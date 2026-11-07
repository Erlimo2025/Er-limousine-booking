'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {setTimeout: delay} = require('node:timers/promises');
const {setup, base, queue, account, guestBooking, initialClock, cookie} = require('./helpers/reservation-management.cjs');
const {guestToken, guestTokenHash, parseRequest, checkProposedChange} = require('../services/reservation-management');
const pg = {skip: !process.env.ER_TEST_DATABASE_URL && 'Requires an isolated PostgreSQL test database'};
const guest = base + '/guest';
const change = (kind = 'cancellation', details = {}) => ({requestId: crypto.randomUUID(), kind, confirmed: true, ...details});
const decision = status => ({status, confirmed: true});
const payable = id => '/api/booking/' + id + '/checkout';

test('reservation requests reject extra authority, amounts, non-text addresses and invalid scheduling', () => {
  for (const payload of [
    change('cancellation', {price: 1}), change('cancellation', {customerId: crypto.randomUUID()}),
    change('cancellation', {confirmed: false}), change('toString'), change(['cancellation']),
    change('locations', {pickup: 1, dropoff: ''}), change('locations', {pickup: '', dropoff: ''}),
    change('locations', {pickup: '<img src=x>', dropoff: ''}), change('locations', {pickup: 'a'.repeat(201), dropoff: ''}),
    change('pickup_schedule', {date: '2026-11-10', time: '24:00'})
  ]) assert.throws(() => parseRequest(payload), {status: 400});
  const location = parseRequest(change('locations', {pickup: '  4 Market Street  ', dropoff: ''}));
  assert.deepEqual(location.details, {pickup: '4 Market Street'});
  const time = (date, clock) => Date.parse(date + 'T' + clock + ':00-04:00');
  const trip = {status: 'confirmed', trip: {date: '2026-11-01', time: '12:00', tripType: 'roundtrip', returnDate: '2026-11-02', returnTime: '12:00'}};
  for (const [date, clock] of [['2026-11-01', '12:00'], ['2026-11-02', '12:00'], ['2026-09-30', '12:00']]) {
    assert.throws(() => checkProposedChange(trip, parseRequest(change('pickup_schedule', {date, time: clock})), initialClock, time), {status: 400});
  }
  const tokens = Array.from({length: 32}, guestToken);
  assert.equal(new Set(tokens).size, tokens.length);
  for (const token of tokens) {
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.match(guestTokenHash(token), /^[a-f0-9]{64}$/);
  }
  assert.equal(guestTokenHash('forged'), null);
});

test('PostgreSQL guest recovery is non-enumerating, scoped, hash-only, one-use and revocable', pg, async t => {
  const f = await setup(t, {NODE_ENV: 'production', SITE_URL: 'https://booking.example.test'});
  const id = await f.reserve();
  const other = await f.reserve(null, {time: '14:00'});
  const owner = await f.register();
  const accountId = await f.reserve(owner, {email: account.email, time: '15:00'});
  assert.equal((await f.get(guest)).status, 404);
  assert.equal((await f.get('/api/booking/' + id)).status, 401);
  assert.equal((await f.post(payable(id), {})).status, 404);
  assert.equal((await f.post(base + '/verification/request', {reference: id, email: guestBooking.email},
    '', {origin: 'https://foreign.example.test'})).status, 403);

  const responses = [
    await f.requestVerification(id, 'wrong-address@example.test'),
    await f.requestVerification(crypto.randomUUID()),
    await f.requestVerification(accountId, account.email),
    await f.requestVerification(id, '  ' + guestBooking.email.toUpperCase() + '  '),
    await f.requestVerification(id)
  ];
  assert.ok(responses.every(response => JSON.stringify(response.body) === JSON.stringify(responses[0].body)));
  assert.equal(responses[0].headers.get('referrer-policy'), 'no-referrer');
  assert.equal(responses[0].headers.get('cache-control'), 'no-store');
  assert.equal((await f.post(base + '/verification/request', {reference: id, email: guestBooking.email})).status, 429);
  const {token, message} = await f.waitForInvitation();
  assert.equal(message.to, guestBooking.email);
  assert.equal((await f.post(base + '/verification/exchange', {token: guestToken()})).status, 400);
  assert.equal((await f.post(base + '/verification/exchange', {token}, '', {'sec-fetch-site': 'cross-site'})).status, 403);
  const attempts = await Promise.all([
    f.post(base + '/verification/exchange', {token}),
    f.post(base + '/verification/exchange', {token})
  ]);
  assert.deepEqual(attempts.map(result => result.status).sort(), [200, 400]);
  const accepted = attempts.find(result => result.status === 200);
  const name = '__Secure-er_reservation_management';
  const grant = cookie(accepted, name);
  const setCookie = accepted.headers.getSetCookie().find(value => value.startsWith(name + '='));
  assert.match(setCookie, /;\s*HttpOnly\b/i);
  assert.match(setCookie, /;\s*Secure\b/i);
  assert.match(setCookie, /;\s*SameSite=Strict\b/i);
  assert.match(setCookie, /;\s*Path=\/api\/booking;/i);
  const rawGrant = grant.slice(name.length + 1);
  const {rows} = await f.pool.query('SELECT * FROM er_reservation_management_access');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].booking_id, id);
  assert.equal(rows[0].link_hash, guestTokenHash(token));
  assert.equal(rows[0].grant_hash, guestTokenHash(rawGrant));
  assert.equal(rows[0].issued_count, 1);
  assert.ok(rows[0].used_at);
  assert.ok(!JSON.stringify(rows).includes(token) && !JSON.stringify(rows).includes(rawGrant));
  assert.equal(f.invitations().length, 1);

  const read = await f.get(guest, grant);
  assert.equal(read.status, 200);
  assert.equal(read.body.reservation.reference, id);
  assert.equal(read.body.reservation.total, (await f.store.get(id)).quote.total);
  const fields = JSON.stringify(read.body);
  for (const value of [guestBooking.email, guestBooking.phone, token, rawGrant, 'tokenHash', 'stripeSessionId', 'customer_id']) {
    assert.ok(!fields.includes(value), 'Private value leaked from the view');
  }
  assert.equal((await f.get(guest, grant + '; ' + grant)).status, 404);
  assert.equal((await f.get(base + '/account/' + accountId, grant)).status, 401);
  assert.equal((await f.get(base + '/account/' + id, owner)).status, 404);
  assert.equal((await f.get('/api/booking/' + other, grant)).status, 401);
  assert.equal((await f.post(payable(other), {}, grant)).status, 404);
  assert.equal((await f.post(payable(accountId), {}, grant)).status, 404);
  const ended = await f.post(guest + '/sign-out', {}, grant);
  assert.equal(ended.status, 200);
  assert.equal((await f.get(guest, grant)).status, 404);
  assert.equal((await f.post(base + '/verification/exchange', {token})).status, 400);
  assert.equal(f.h.state.creates.length, 0);
});

test('PostgreSQL expiration, retry and grant replacement preserve guest scope', pg, async t => {
  const f = await setup(t);
  const id = await f.reserve();
  await f.requestVerification(id);
  const first = await f.waitForInvitation();
  f.h.advance(20 * 60000);
  assert.equal((await f.post(base + '/verification/exchange', {token: first.token})).status, 400);
  const grant = await f.verify(id, undefined, 1);
  f.h.advance(60000);
  await f.requestVerification(id);
  const third = await f.waitForInvitation(2);
  assert.equal((await f.get(guest, grant)).status, 200, 'Mail request cannot revoke a verified session');
  const used = await f.post(base + '/verification/exchange', {token: third.token});
  const rotated = cookie(used, 'er_reservation_management');
  assert.equal(used.status, 200);
  assert.notEqual(rotated, grant);
  assert.equal((await f.get(guest, grant)).status, 404);
  assert.equal((await f.get(guest, rotated)).status, 200);
  f.h.advance(45 * 60000);
  assert.equal((await f.get(guest, rotated)).status, 404);
  assert.equal((await f.post(payable(id), {}, rotated)).status, 404);
});

test('disabled or failing verification email leaves existing reservations and payment intact', pg, async t => {
  const off = await setup(t, {BOOKING_EMAILS_ENABLED: 'false'});
  const id = await off.reserve();
  const before = await off.store.get(id);
  assert.equal((await off.post(base + '/verification/request', {reference: id, email: guestBooking.email})).status, 503);
  assert.equal((await off.pool.query('SELECT count(*) FROM er_reservation_management_access')).rows[0].count, '0');
  assert.deepEqual(await off.store.get(id), before);
  const on = await setup(t);
  const other = await on.reserve();
  const saved = await on.store.get(other);
  on.h.state.emailFail = true;
  await on.requestVerification(other);
  for (let i = 0; i < 100 && !on.h.state.logs.some(log => log.includes('provider_error')); i++) await delay(20);
  assert.equal(on.invitations().length, 0);
  assert.ok(on.h.state.logs.some(log => log.includes('provider_error')));
  assert.ok(!on.h.state.logs.join(' ').includes('synthetic email secret marker'));
  assert.deepEqual(await on.store.get(other), saved);
  on.h.state.emailFail = false;
  on.h.advance(60000);
  assert.ok(await on.verify(other));
});

test('PostgreSQL account and guest requests require ownership and confirmation; decisions preserve booking and immutable audit', pg, async t => {
  const f = await setup(t);
  const owner = await f.register();
  const foreign = await f.register({email: 'foreign@example.test', phone: '2015550181'});
  const id = await f.reserve(owner, {email: account.email});
  const guestId = await f.reserve(null, {time: '14:00'});
  const grant = await f.verify(guestId);
  const admin = await f.adminLogin();
  const accountPath = base + '/account/' + id;
  const before = await f.store.get(id);
  const guestBefore = await f.store.get(guestId);
  const paymentRequests = f.h.state.creates.length;
  const googleRequests = f.h.state.googleCalls;
  assert.equal((await f.get(accountPath, owner)).body.reservation.reference, id);
  assert.equal((await f.get(accountPath, foreign)).status, 404);
  assert.equal((await f.get(accountPath)).status, 401);
  assert.equal((await f.get(queue)).status, 401);
  assert.equal((await f.get(queue, owner)).status, 401);
  assert.equal((await f.get(queue, grant)).status, 401);
  assert.equal((await f.post(accountPath + '/requests', change(), foreign)).status, 404);
  assert.equal((await f.post(accountPath + '/requests', change(), owner, {origin: 'https://foreign.example.test'})).status, 403);
  assert.equal((await f.post(accountPath + '/requests', change('locations', {pickup: before.trip.pickup, dropoff: ''}), owner)).status, 400);
  assert.equal((await f.post(accountPath + '/requests', change('pickup_schedule', {date: '2026-02-30', time: '13:00'}), owner)).status, 400);

  const schedule = change('pickup_schedule', {date: '2026-11-11', time: '15:30'});
  const [one, two] = await Promise.all([
    f.post(accountPath + '/requests', schedule, owner),
    f.post(accountPath + '/requests', schedule, owner)
  ]);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.deepEqual(one.body, two.body);
  assert.equal(one.body.request.status, 'pending');
  assert.equal((await f.post(accountPath + '/requests', {...schedule, time: '14:00'}, owner)).status, 409);
  assert.equal((await f.post(accountPath + '/requests', change(), owner)).status, 409);
  const requestId = one.body.request.id;
  const address = await f.post(guest + '/requests', change('locations', {pickup: '5 Market Street', dropoff: 'JFK Terminal 4'}), grant);
  assert.equal(address.status, 200);
  assert.deepEqual(address.body.request.details, {pickup: '5 Market Street', dropoff: 'JFK Terminal 4'});

  const view = await f.get(queue + '?status=pending', admin);
  assert.equal(view.body.requests.length, 2);
  assert.deepEqual(new Set(view.body.requests.map(request => request.source)), new Set(['guest', 'account']));
  assert.equal((await f.get(queue + '?cursor=invalid', admin)).status, 400);
  const decisionPath = queue + '/' + requestId + '/decision';
  assert.equal((await f.post(decisionPath, decision('approved'), owner)).status, 401);
  assert.equal((await f.post(decisionPath, decision('approved'), admin, {'sec-fetch-site': 'cross-site'})).status, 403);
  assert.equal((await f.post(decisionPath, {status: 'approved', confirmed: false}, admin)).status, 400);
  const race = await Promise.all([
    f.post(decisionPath, decision('approved'), admin),
    f.post(decisionPath, decision('declined'), admin)
  ]);
  assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
  const recorded = race.find(result => result.status === 200).body.request;
  const replay = await f.post(decisionPath, decision(recorded.status), admin);
  assert.deepEqual(replay.body.request, recorded);
  const privateResult = await f.get(accountPath, owner);
  assert.equal(privateResult.body.requests[0].status, recorded.status);
  assert.ok(!Object.hasOwn(privateResult.body.requests[0], 'reviewer'));
  const queueResult = await f.get(queue + '?status=' + recorded.status, admin);
  assert.match(queueResult.body.requests[0].reviewer, /^[a-f0-9-]{36}$/);
  assert.equal(queueResult.body.requests[0].reviewedAt, recorded.reviewedAt);
  assert.equal((await f.post(queue + '/' + address.body.request.id + '/decision', decision('approved'), admin)).status, 200);
  const cancel = await f.post(guest + '/requests', change(), grant);
  assert.equal(cancel.body.request.status, 'pending');
  assert.equal((await f.post(queue + '/' + cancel.body.request.id + '/decision', decision('declined'), admin)).status, 200);
  assert.equal((await f.get(guest, grant)).body.requests.length, 2);
  await assert.rejects(f.pool.query('UPDATE er_reservation_management_requests SET reviewer_id=$1 WHERE id=$2', [crypto.randomUUID(), requestId]), /history is immutable/);
  await assert.rejects(f.pool.query('DELETE FROM er_reservation_management_requests WHERE id=$1', [requestId]), /history is immutable/);
  assert.deepEqual(await f.store.get(id), before);
  assert.deepEqual(await f.store.get(guestId), guestBefore);
  assert.equal(f.h.state.creates.length, paymentRequests);
  assert.equal(f.h.state.googleCalls, googleRequests);
  assert.equal((await f.pool.query('SELECT count(*) FROM er_payment_ledger')).rows[0].count, '0');
  await f.post('/api/customer/logout', {}, owner);
  assert.equal((await f.get(accountPath, owner)).status, 401);
});

test('PostgreSQL stale reservations cannot be approved and cancelled trips reject new requests and payment', pg, async t => {
  const f = await setup(t);
  const owner = await f.register();
  const id = await f.reserve(owner);
  const admin = await f.adminLogin();
  const path = base + '/account/' + id;
  const proposal = await f.post(path + '/requests', change('locations', {pickup: '5 Market St', dropoff: ''}), owner);
  assert.equal(proposal.status, 200);
  const oldTrip = (await f.get('/api/customer/trips/' + id, owner)).body.trip;
  const existingAction = {requestId: crypto.randomUUID(), confirmed: true, expectedPickupAt: oldTrip.management.pickupAt,
    date: '2026-11-10', time: '16:00'};
  const moved = await f.post('/api/customer/trips/' + id + '/pickup-time', existingAction, owner);
  assert.equal(moved.status, 200, 'Existing My Trips action still applies immediately');
  assert.equal((await f.store.get(id)).trip.time, '16:00');
  const decisionPath = queue + '/' + proposal.body.request.id + '/decision';
  assert.equal((await f.post(decisionPath, decision('approved'), admin)).status, 409);
  assert.equal((await f.post(decisionPath, decision('declined'), admin)).status, 200);
  assert.equal((await f.post('/api/customer/trips/' + id + '/cancel',
    {requestId: crypto.randomUUID(), confirmed: true, expectedPickupAt: moved.body.trip.management.pickupAt}, owner)).status, 200);
  const cancelled = (await f.get(path, owner)).body.reservation;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.canRequest, false);
  assert.equal(cancelled.canPay, false);
  assert.equal((await f.post(path + '/requests', change(), owner)).status, 409);
  assert.equal((await f.post('/api/customer/trips/' + id + '/payment', {}, owner)).status, 409);
  assert.equal(f.h.state.creates.length, 0);
});

test('PostgreSQL guest and account Pay Later retain the accepted fare through retries, webhook, and paid-request decisions', pg, async t => {
  const f = await setup(t);
  const admin = await f.adminLogin();
  const accountCookie = await f.register();
  for (const [credentials, options] of [[null, {}], [accountCookie, {email: account.email, time: '15:00'}]]) {
    const id = await f.reserve(credentials, options);
    const who = credentials || await f.verify(id);
    const path = credentials ? base + '/account/' + id : guest;
    const payment = credentials ? '/api/customer/trips/' + id + '/payment' : payable(id);
    const before = await f.store.get(id);
    const creations = f.h.state.creates.length;
    const googleCalls = f.h.state.googleCalls;
    assert.equal((await f.get(path, who)).body.reservation.canPay, true);
    const starts = await Promise.all([f.post(payment, {}, who), f.post(payment, {}, who)]);
    assert.ok(starts.some(result => result.status === 200));
    assert.ok(starts.every(result => [200, 409].includes(result.status)));
    const retry = await f.post(payment, {}, who);
    assert.equal(retry.status, 200);
    assert.equal(f.h.state.creates.length, creations + 1);
    const session = [...f.h.state.sessions.values()].at(-1);
    assert.equal(session.amount_total, Math.round(before.quote.total * 100));
    assert.equal(session.metadata.bookingId, id);
    assert.equal(f.h.state.googleCalls, googleCalls);
    assert.equal((await f.store.get(id)).paymentStatus, 'unpaid');
    session.status = 'expired';
    assert.equal((await f.post(payment, {}, who)).status, 200);
    assert.equal(f.h.state.creates.length, creations + 2);
    const replacement = [...f.h.state.sessions.values()].at(-1);
    assert.equal(replacement.amount_total, session.amount_total);
    replacement.status = 'complete';
    replacement.payment_status = 'paid';
    assert.equal((await f.h.webhook(replacement, undefined, true)).status, 400);
    assert.equal((await f.post(payment, {}, who)).status, 409);
    const pending = (await f.get(path, who)).body.reservation;
    assert.equal(pending.paymentStatus, 'unpaid');
    assert.equal(pending.paymentVerificationPending, true);
    assert.equal(pending.canPay, false);
    assert.equal((await f.h.webhook(replacement)).status, 200);
    const after = await f.store.get(id);
    assert.deepEqual(after.quote, before.quote);
    assert.equal(after.paymentStatus, 'paid');
    const view = (await f.get(path, who)).body.reservation;
    assert.equal(view.paymentStatus, 'paid');
    assert.equal(view.canPay, false);
    assert.equal(view.total, before.quote.total);
    assert.equal((await f.post(payment, {}, who)).status, 409);
    if (!credentials) assert.equal((await f.get('/api/booking/' + id, who)).body.paymentStatus, 'paid');
    const submitted = await f.post(path + '/requests', change(), who);
    assert.equal(submitted.status, 200);
    assert.equal((await f.post(queue + '/' + submitted.body.request.id + '/decision', decision('approved'), admin)).status, 200);
    const cancelled = await f.store.get(id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.paymentStatus, after.paymentStatus);
    assert.deepEqual(cancelled.quote, after.quote);
    assert.deepEqual(cancelled.trip, after.trip);
    assert.equal(f.h.state.refundRequests.length, 0, 'Owner approval never authorizes a refund');
    assert.equal((await f.post(payment, {}, who)).status, 409);
    assert.equal(f.h.state.creates.length, creations + 2);
    assert.equal(Number((await f.pool.query('SELECT amount_cents FROM er_payment_ledger WHERE booking_id=$1', [id])).rows[0].amount_cents), session.amount_total);
  }
  const now = await f.post('/api/checkout', {...guestBooking, time: '16:00', paymentChoice: 'now'});
  assert.equal(now.status, 200);
  const quote = await f.store.get(now.body.bookingId);
  assert.equal([...f.h.state.sessions.values()].at(-1).amount_total, Math.round(quote.quote.total * 100));
});

test('PostgreSQL a guest revoked during Checkout gets no link and the next verified session reuses the existing Checkout', {...pg, timeout: 15000}, async t => {
  const f = await setup(t);
  const id = await f.reserve();
  const grant = await f.verify(id);
  const fare = (await f.store.get(id)).quote;
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  f.h.state.checkoutOnCreate = () => { entered(); return pending; };
  const payment = f.post(payable(id), {}, grant);
  try {
    await Promise.race([started, payment.then(result => { throw new Error('Checkout ended early with HTTP ' + result.status); })]);
    assert.equal((await f.post(guest + '/sign-out', {}, grant)).status, 200);
  } finally {
    release();
  }
  const denied = await payment;
  assert.equal(denied.status, 401);
  assert.ok(!Object.hasOwn(denied.body, 'url'));
  assert.equal(f.h.state.creates.length, 1);
  const saved = await f.store.get(id);
  assert.deepEqual(saved.quote, fare);
  assert.equal(saved.paymentStatus, 'unpaid');
  assert.ok(saved.stripeSessionId);
  assert.equal((await f.post(payable(id), {}, grant)).status, 404);
  f.h.advance(60000);
  const freshGrant = await f.verify(id, undefined, 1);
  assert.equal((await f.post(payable(id), {}, freshGrant)).status, 200);
  assert.equal(f.h.state.creates.length, 1);
});
