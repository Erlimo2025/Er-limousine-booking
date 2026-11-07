'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {setup, harness, base, queue, account, guestBooking, initialClock} = require('./helpers/reservation-management.cjs');
const {currentPolicy, acceptedPolicy, policyAtBooking} = require('../services/cancellation-policy');
const {cancellationTerms, amendmentInput, amendmentTerms} = require('../services/reservation-self-service');
const {DAY} = require('../services/trip-management');
const HOUR = 3600000;
const pg = {skip: !process.env.ER_TEST_DATABASE_URL && 'Requires an isolated PostgreSQL test database'};
const enabled = {RESERVATION_SELF_SERVICE_ENABLED: 'true', RESERVATION_AUTO_CANCELLATIONS_ENABLED: 'true'};
const guestPath = base + '/guest';
const accept = (terms, ownerReview = false) => ({
  requestId: crypto.randomUUID(), revision: terms.revision, confirmed: true, ownerReview
});
const order = (f, route, cookie) => f.post(route + '/cancellation/preview', {}, cookie);
const cancel = (f, route, body, cookie) => f.post(route + '/cancellation/confirm', body, cookie);
const currentRefund = f => [...f.h.state.refunds.values()].at(-1);
const refundHook = (f, refund, eventId, invalid = false) => {
  const payload = JSON.stringify({id: eventId, type: 'refund.updated', data: {object: refund}});
  const signature = f.h.signatureSdk.webhooks.generateTestHeaderString({payload, secret: 'whsec_local_mock'});
  return f.h.request('/api/stripe-webhook', invalid ? payload + ' ' : payload, {'stripe-signature': signature});
};
const stripeEventId = () => 'evt_managed_' + crypto.randomUUID().replaceAll('-', '');

async function trip(t, {signedIn = true, paid = true, time = '12:00', date = '2026-10-02', open = false, env = enabled, booking} = {}) {
  const f = await setup(t, env);
  const owner = signedIn ? await f.register() : null;
  const id = await f.reserve(owner, {date, time, ...(signedIn ? {email: account.email} : {}), ...booking});
  const credentials = owner || await f.verify(id);
  const route = owner ? base + '/account/' + id : guestPath;
  const payment = owner ? '/api/customer/trips/' + id + '/payment' : '/api/booking/' + id + '/checkout';
  let session;
  if (paid || open) {
    assert.equal((await f.post(payment, {}, credentials)).status, 200);
    session = [...f.h.state.sessions.values()][0];
  }
  if (paid) {
    session.status = 'complete';
    session.payment_status = 'paid';
    assert.equal((await f.h.webhook(session)).status, 200);
  }
  return {...f, id, route, payment, credentials, session};
}

test('the simple policy is inclusive at 24 hours and never calculates a percentage fee', () => {
  const record = {id: crypto.randomUUID(), status: 'confirmed', paymentStatus: 'paid',
    quote: {total: 100.05, currency: 'usd'}, createdAt: new Date(initialClock - DAY).toISOString(),
    trip: {date: '2026-10-02', time: '12:00'}};
  record.cancellationPolicyAcceptance = {policy: currentPolicy, acceptedAt: record.createdAt};
  const source = {remainingCents: 8005, refundedBeforeCents: 2000};
  for (const before of [DAY + 1, DAY]) {
    const terms = cancellationTerms(record, initialClock, () => initialClock + before, source);
    assert.equal(terms.review, null);
    assert.equal(terms.refundCents, 8005);
    assert.equal(terms.refundedBeforeCents, 2000);
    assert.equal(Object.hasOwn(terms, 'feePercent'), false);
    assert.equal(Object.hasOwn(terms, 'feeCents'), false);
  }
  for (const before of [DAY - 1000, 2 * HOUR, 1, 0, -1]) {
    const terms = cancellationTerms(record, initialClock, () => initialClock + before, source);
    assert.equal(terms.review, 'within_24_hours');
    assert.equal(terms.refundCents, null);
  }
  assert.equal(cancellationTerms({...record, status: 'completed'}, initialClock, () => initialClock + DAY, source).review, 'service_started');
  assert.ok(!JSON.stringify(currentPolicy).match(/10%|25%|50%/));
});

test('change policy independently checks both schedules and rejects forged inputs', () => {
  const record = {id: crypto.randomUUID(), status: 'confirmed', paymentStatus: 'paid', quote: {total: 100, currency: 'usd'},
    trip: {date: '2026-10-02', time: '12:00', vehicle: 'suv', passengers: 4, tripType: 'oneway', pickup: 'Main Street', dropoff: 'Other Street'}};
  const parse = (date, time) => Date.parse(date + 'T' + time + ':00-04:00');
  assert.equal(amendmentTerms(record, {passengers: 5}, initialClock, parse).review, 'availability_unverified');
  assert.equal(amendmentTerms(record, {time: '11:59'}, initialClock, parse).review, 'within_24_hours');
  assert.equal(amendmentTerms({...record, trip: {...record.trip, time: '11:59'}}, {time: '12:00'}, initialClock, parse).review, 'within_24_hours');
  assert.equal(amendmentTerms(record, {luggage: 2}, initialClock, parse).capacityReview, true);
  for (const body of [{quote: 1}, {offerCode: 'EWR_MANHATTAN_SUV'}, {pickup: '<script>'}, {passengers: '6'},
    {luggage: -1}, {pickupTerminal: 'unknown'}, {vehicle: '__proto__'}]) assert.throws(() => amendmentInput(body), {status: 400});
});

test('PostgreSQL automatic cancellation is off by default and legacy My Trips remains available', pg, async t => {
  const f = await trip(t, {paid: false, env: {}});
  const view = await f.get(f.route, f.credentials);
  assert.equal(view.status, 200);
  assert.ok(!Object.hasOwn(view.body, 'selfService'));
  assert.equal((await order(f, f.route, f.credentials)).status, 404);
  assert.equal((await f.get('/api/customer/trips/' + f.id, f.credentials)).body.trip.management.canCancel, true);
  assert.equal((await f.get(queue + '/settlements', f.credentials)).status, 401);
});

test('PostgreSQL no-fee paid cancellation uses original funds for guests and accounts, including duplicate and signed retries', pg, async t => {
  for (const [date, time, signedIn] of [
    ['2026-10-02', '12:00', false], ['2026-10-03', '14:00', true]
  ]) {
    const f = await trip(t, {date, time, signedIn});
    const before = await f.store.get(f.id);
    const quote = (await order(f, f.route, f.credentials)).body.terms;
    assert.equal(quote.review, null);
    const input = accept(quote);
    assert.equal((await cancel(f, f.route, input, '')).status, signedIn ? 401 : 404);
    assert.equal((await cancel(f, f.route, {...input, refundCents: 99999}, f.credentials)).status, 400);
    assert.equal((await cancel(f, f.route, {...input, confirmed: false}, f.credentials)).status, 400);
    const race = await Promise.all([cancel(f, f.route, input, f.credentials), cancel(f, f.route, input, f.credentials)]);
    assert.ok(race.some(result => result.status === 200));
    assert.ok(race.every(result => [200, 409].includes(result.status)));
    assert.equal((await cancel(f, f.route, input, f.credentials)).status, 200);
    assert.equal((await cancel(f, f.route, accept(quote), f.credentials)).status, 409);
    assert.equal(f.h.state.refundRequests.length, 1);
    const refund = currentRefund(f);
    assert.equal(refund.amount, f.session.amount_total);
    assert.equal(refund.payment_intent, f.session.payment_intent);
    assert.equal(refund.metadata.bookingId, f.id);
    assert.match(f.h.state.refundRequests[0].options.idempotencyKey, /^er-managed-cancel-/);
    assert.deepEqual((await f.store.get(f.id)).quote, before.quote);
    assert.equal((await f.store.get(f.id)).status, 'cancelled');
    assert.equal((await f.store.get(f.id)).paymentStatus, 'paid');
    assert.equal((await f.post(f.payment, {}, f.credentials)).status, 409);
    assert.equal((await f.get(f.route, f.credentials)).body.cancellation.state, 'provider_identified');
    const eventId = stripeEventId();
    assert.equal((await refundHook(f, refund, eventId, true)).status, 400);
    assert.equal((await refundHook(f, {...refund, amount: refund.amount + 1}, stripeEventId())).status, 400);
    assert.equal((await refundHook(f, refund, eventId)).status, 200);
    assert.equal((await refundHook(f, refund, eventId)).status, 200);
    assert.equal((await f.get(f.route, f.credentials)).body.cancellation.state, 'confirmed');
    assert.equal((await f.pool.query('SELECT count(*) FROM er_managed_cancellation_events WHERE stripe_event_id=$1', [eventId])).rows[0].count, '1');
    const {rows: [ledger]} = await f.pool.query('SELECT amount_cents FROM er_payment_ledger WHERE booking_id=$1', [f.id]);
    assert.equal(Number(ledger.amount_cents), f.session.amount_total);
    assert.equal(await f.store.refundForBooking(f.id), null, 'Legacy refund worker cannot duplicate a managed obligation');
  }
});

test('PostgreSQL unpaid cancellation retires open Checkout, refuses uncertainty, and requires owner review inside 24 hours', pg, async t => {
  const f = await trip(t, {paid: false, open: true});
  const before = await f.store.get(f.id);
  const quote = (await order(f, f.route, f.credentials)).body.terms;
  assert.equal(quote.refundCents, 0);
  f.h.state.retrieveError = true;
  const input = accept(quote);
  assert.equal((await cancel(f, f.route, input, f.credentials)).status, 409);
  assert.equal((await f.store.get(f.id)).status, 'awaiting_payment');
  assert.equal(await f.store.managedCancellation(f.id), null);
  f.h.state.retrieveError = false;
  const result = await cancel(f, f.route, input, f.credentials);
  assert.equal(result.status, 200);
  assert.equal(result.body.cancellation.state, 'no_refund');
  assert.equal(f.session.status, 'expired');
  assert.equal((await f.post(f.payment, {}, f.credentials)).status, 409);
  assert.equal(f.h.state.creates.length, 1);
  assert.equal(f.h.state.refundRequests.length, 0);
  assert.deepEqual((await f.store.get(f.id)).quote, before.quote);
  await assert.rejects(f.pool.query("UPDATE er_reservations SET record=jsonb_set(record,'{status}',to_jsonb('confirmed'::text)) WHERE id=$1",
    [f.id]), /cannot be reopened or repriced/);
  await assert.rejects(f.pool.query('UPDATE er_managed_cancellations SET fee_percent=10 WHERE booking_id=$1', [f.id]),
    /authority is immutable/);

  const short = await trip(t, {paid: false, date: '2026-10-01', time: '14:00'});
  const terms = (await order(short, short.route, short.credentials)).body.terms;
  assert.equal(terms.review, 'within_24_hours');
  assert.equal(terms.refundCents, null);
  assert.equal((await cancel(short, short.route, accept(terms), short.credentials)).status, 409);
  const exception = await cancel(short, short.route, accept(terms, true), short.credentials);
  assert.equal(exception.body.request.status, 'pending');
  assert.equal((await short.store.get(short.id)).status, 'awaiting_payment');
  assert.equal(short.h.state.creates.length + short.h.state.refundRequests.length, 0);
});

test('PostgreSQL inside the cutoff and started/completed trips require owner decisions without automatic refunds', pg, async t => {
  for (const status of ['confirmed', 'passenger_on_board', 'completed']) {
    const f = await trip(t, {date: '2026-10-01', time: '14:00'});
    if (status !== 'confirmed') await f.store.update(f.id, record => {record.status = status;});
    const before = await f.store.get(f.id);
    const terms = (await order(f, f.route, f.credentials)).body.terms;
    assert.ok(terms.review);
    assert.equal(terms.refundCents, null);
    assert.equal((await cancel(f, f.route, accept(terms), f.credentials)).status, 409);
    const {body: {request}} = await cancel(f, f.route, accept(terms, true), f.credentials);
    assert.equal(request.status, 'pending');
    assert.equal((await f.store.get(f.id)).status, status);
    assert.equal(f.h.state.refundRequests.length, 0);
    const admin = await f.adminLogin();
    const path = queue + '/' + request.id + '/decision';
    assert.equal((await f.post(path, {confirmed: true, status: 'approved'}, f.credentials)).status, 401);
    const approved = await f.post(path, {confirmed: true, status: 'approved'}, admin);
    assert.equal(approved.status, 200);
    assert.ok(approved.body.request.cancellationAppliedAt);
    assert.equal((await f.post(path, {confirmed: true, status: 'approved'}, admin)).status, 200);
    assert.equal((await f.post(path, {confirmed: true, status: 'declined'}, admin)).status, 409);
    const after = await f.store.get(f.id);
    assert.equal(after.status, 'cancelled');
    assert.deepEqual(after.quote, before.quote);
    assert.equal(after.paymentStatus, 'paid');
    assert.equal(await f.store.managedCancellation(f.id), null);
    assert.equal(f.h.state.refundRequests.length, 0);
    const history = (await f.pool.query('SELECT cancellation_status_before FROM er_reservation_management_requests WHERE id=$1', [request.id])).rows[0];
    assert.equal(history.cancellation_status_before, status);
  }
});

test('PostgreSQL one second inside 24 hours stays active after request and rejection', pg, async t => {
  const f = await trip(t);
  f.h.advance(1000);
  const terms = (await order(f, f.route, f.credentials)).body.terms;
  assert.equal(terms.review, 'within_24_hours');
  assert.equal((await cancel(f, f.route, accept(terms), f.credentials)).status, 409);
  const requested = await cancel(f, f.route, accept(terms, true), f.credentials);
  assert.equal(requested.status, 200);
  const admin = await f.adminLogin();
  const decision = await f.post(queue + '/' + requested.body.request.id + '/decision', {confirmed: true, status: 'declined'}, admin);
  assert.equal(decision.status, 200);
  assert.equal((await f.store.get(f.id)).status, 'confirmed');
  assert.equal(f.h.state.refundRequests.length, 0);
});

test('PostgreSQL refunds survive lost responses, provider failure, expired idempotency, and unverified funding', pg, async t => {
  const lost = await trip(t);
  lost.h.state.loseRefundResponse = true;
  const terms = (await order(lost, lost.route, lost.credentials)).body.terms;
  const accepted = await cancel(lost, lost.route, accept(terms), lost.credentials);
  assert.equal(accepted.body.cancellation.state, 'submitted_unknown');
  assert.equal(lost.h.state.refunds.size, 1);
  lost.h.advance(60000);
  await lost.h.context.runReservationRefunds();
  assert.equal(lost.h.state.refundRequests.length, 1, 'A charge already refunded is not submitted again');
  assert.equal((await lost.get(lost.route, lost.credentials)).body.cancellation.state, 'confirmed', 'The provider refund is discovered without a webhook');
  assert.equal((await refundHook(lost, currentRefund(lost), stripeEventId())).status, 200);
  assert.equal((await lost.get(lost.route, lost.credentials)).body.cancellation.state, 'confirmed');
  const savedRefund = currentRefund(lost);
  savedRefund.status = 'failed';
  assert.equal((await refundHook(lost, savedRefund, stripeEventId())).status, 200);
  assert.equal((await lost.get(lost.route, lost.credentials)).body.cancellation.state, 'failed');
  assert.equal((await refundHook(lost, {...savedRefund, status: 'succeeded'}, stripeEventId())).status, 200);
  assert.equal((await lost.get(lost.route, lost.credentials)).body.cancellation.state, 'failed', 'A delayed success event cannot override a verified provider failure');

  const transient = await trip(t);
  transient.h.state.refundError = new Error('private provider timeout');
  const pending = (await order(transient, transient.route, transient.credentials)).body.terms;
  assert.equal((await cancel(transient, transient.route, accept(pending), transient.credentials)).body.cancellation.state, 'submitted_unknown');
  transient.h.advance(60000);
  await transient.h.context.runReservationRefunds();
  assert.equal(transient.h.state.refundRequests.length, 2);
  assert.equal(transient.h.state.refunds.size, 1);
  assert.equal(transient.h.state.refundRequests[0].options.idempotencyKey, transient.h.state.refundRequests[1].options.idempotencyKey);
  assert.ok(!transient.h.state.logs.join(' ').includes('private provider timeout'));

  const expired = await trip(t);
  expired.h.state.refundError = new Error('private provider timeout');
  const expiredQuote = (await order(expired, expired.route, expired.credentials)).body.terms;
  await cancel(expired, expired.route, accept(expiredQuote), expired.credentials);
  expired.h.advance(23 * HOUR);
  await expired.h.context.runReservationRefunds();
  assert.equal(expired.h.state.refundRequests.length, 1);
  assert.equal((await expired.store.managedCancellation(expired.id)).evidence, 'idempotency_window_expired');

  const disputed = await trip(t);
  disputed.h.state.chargeOverride = {disputed: true};
  const doubtful = (await order(disputed, disputed.route, disputed.credentials)).body.terms;
  assert.equal((await cancel(disputed, disputed.route, accept(doubtful), disputed.credentials)).status, 409);
  assert.equal(disputed.h.state.refundRequests.length, 0);
  assert.equal((await disputed.store.get(disputed.id)).status, 'confirmed');
});

test('PostgreSQL an in-flight Checkout and elapsed 24-hour boundary invalidate prior cancellation confirmation', {...pg, timeout: 15000}, async t => {
  const f = await trip(t, {paid: false});
  const terms = (await order(f, f.route, f.credentials)).body.terms;
  let start, unblock;
  const started = new Promise(resolve => {start = resolve;});
  const hold = new Promise(resolve => {unblock = resolve;});
  f.h.state.checkoutOnCreate = () => {start(); return hold;};
  const checkout = f.post(f.payment, {}, f.credentials);
  try {
    await Promise.race([started, checkout.then(result => {throw Error('Checkout ended before hold ' + result.status);})]);
    assert.equal((await cancel(f, f.route, accept(terms), f.credentials)).status, 409);
  } finally {
    unblock();
  }
  assert.equal((await checkout).status, 200);
  assert.equal((await cancel(f, f.route, accept(terms), f.credentials)).status, 409, 'The Checkout session changed since preview');
  const fresh = (await order(f, f.route, f.credentials)).body.terms;
  f.h.advance(1);
  assert.equal((await cancel(f, f.route, accept(fresh), f.credentials)).status, 409, 'Exactly 24 hours passed');
  assert.equal(f.h.state.refundRequests.length, 0);
  assert.equal((await f.store.get(f.id)).status, 'awaiting_payment');
  assert.equal(f.h.state.sessions.size, 1);
});

test('PostgreSQL server-priced amendments keep availability, older previews, owner decisions and payment separate', pg, async t => {
  const f = await trip(t, {paid: true});
  const before = await f.store.get(f.id);
  const previewPath = f.route + '/changes/preview', confirmPath = f.route + '/changes/confirm';
  const preview = async fields => {
    const result = await f.post(previewPath, fields, f.credentials);
    assert.equal(result.status, 200);
    return result.body.preview;
  };
  const one = await preview({vehicle: 'suv'});
  assert.equal(one.originalCents, 10000);
  assert.equal(one.newCents, 8000);
  assert.equal(one.differenceCents, -2000);
  assert.equal(one.review, 'availability_unverified');
  const two = await preview({vehicle: 'suv', passengers: 4, luggage: 2, flightNumber: 'UA 109',
    pickup: 'Newark Liberty International Airport (EWR)', pickupTerminal: 'c'});
  assert.equal(two.review, 'availability_unverified');
  assert.equal(two.changes.pickupTerminal, 'c');
  assert.equal(two.luggageReview, true);
  const confirm = p => ({previewId: p.id, revision: p.revision, confirmed: true, requestId: crypto.randomUUID()});
  assert.equal((await f.post(confirmPath, confirm(one), f.credentials)).status, 409);
  const action = confirm(two);
  assert.equal((await f.post(confirmPath, {...action, newCents: 1}, f.credentials)).status, 400);
  const confirmed = await f.post(confirmPath, action, f.credentials);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.request.status, 'pending');
  assert.deepEqual((await f.post(confirmPath, action, f.credentials)).body, confirmed.body);
  const admin = await f.adminLogin();
  assert.equal((await f.post(queue + '/' + confirmed.body.request.id + '/decision',
    {confirmed: true, status: 'approved'}, admin)).status, 200);
  assert.deepEqual(await f.store.get(f.id), before);
  assert.equal(f.h.state.creates.length, 1);
  assert.equal(f.h.state.refundRequests.length, 0);

  const special = await trip(t, {paid: false, booking: {vehicle: 'suv', offerCode: 'EWR_MANHATTAN_SUV'}});
  const specialPreview = (await special.post(special.route + '/changes/preview', {passengers: 3}, special.credentials)).body.preview;
  assert.equal(specialPreview.originalCents, 15000);
  assert.equal(specialPreview.newCents, 15000);
  const promo = await trip(t, {paid: false, booking: {promoCode: 'FIRST15'}});
  const promoPreview = (await promo.post(promo.route + '/changes/preview', {vehicle: 'suv'}, promo.credentials)).body.preview;
  assert.equal(promoPreview.pricingReview, 'existing_promotion');
  assert.equal(promoPreview.newCents, null);
  assert.equal((await promo.store.get(promo.id)).quote.promotion.code, 'FIRST15');
});

test('PostgreSQL a restarted worker reconciles committed refunds with new customer actions disabled', pg, async t => {
  const f = await trip(t);
  f.h.state.refundError = new Error('synthetic transport error');
  const terms = (await order(f, f.route, f.credentials)).body.terms;
  const accepted = await cancel(f, f.route, accept(terms), f.credentials);
  assert.equal(accepted.body.cancellation.state, 'submitted_unknown');
  const stableKey = f.h.state.refundRequests[0].options.idempotencyKey;
  const withoutProvider = await harness(t, {STRIPE_SECRET_KEY: ''}, '[]', f.store, initialClock + 60000);
  await withoutProvider.context.runReservationRefunds();
  const scheduled = await f.store.managedCancellation(f.id);
  assert.equal(scheduled.evidence, 'refund_provider_unavailable');
  assert.equal(scheduled.next_attempt_at.getTime(), initialClock + 6 * 60000);
  const worker = await harness(t, {RESERVATION_SELF_SERVICE_ENABLED: 'false'}, '[]', f.store);
  worker.state.sessions = f.h.state.sessions;
  worker.state.refunds = f.h.state.refunds;
  await worker.context.runReservationRefunds();
  assert.equal((await worker.request(f.route + '/cancellation/preview', {},
    {cookie: f.credentials, origin: 'http://localhost:3000'})).status, 404);
  worker.advance(6 * 60000);
  await worker.context.runReservationRefunds();
  assert.equal(worker.state.refundRequests.length, 1);
  assert.equal(worker.state.refundRequests[0].options.idempotencyKey, stableKey);
  const refund = [...worker.state.refunds.values()][0];
  assert.equal(refund.amount, 10000);
  assert.equal((await refundHook({h: worker}, refund, stripeEventId())).status, 200);
  const after = (await worker.request(f.route, undefined, {cookie: f.credentials})).body;
  assert.equal(after.reservation.status, 'cancelled');
  assert.equal(after.cancellation.state, 'confirmed');
  assert.ok(!Object.hasOwn(after, 'selfService'));
});

test('PostgreSQL checkout records server policy for guest and account bookings without recording explicit acceptance', pg, async t => {
  const f = await setup(t);
  const input = {...guestBooking, paymentChoice: 'later'};
  const quote = await f.post('/api/quote', input);
  assert.equal(quote.status, 200);
  assert.deepEqual(quote.body.cancellationPolicy, currentPolicy);

  const guest = await f.post('/api/checkout', input);
  assert.equal(guest.status, 200);
  const reference = guest.body.bookingId;
  const saved = await f.store.get(reference);
  const expected = {policy: currentPolicy, recordedAt: new Date(initialClock).toISOString()};
  assert.deepEqual(saved.cancellationPolicyAtBooking, expected);
  assert.equal(Object.hasOwn(saved, 'cancellationPolicyAcceptance'), false);
  assert.equal(acceptedPolicy(saved), null);
  assert.equal(f.h.state.creates.length, 0);
  const guestStatus = '/api/booking/' + reference;
  assert.equal((await f.get(guestStatus)).status, 401);
  const guestStatusCookie = guest.headers.getSetCookie().find(value => value.includes('er_booking_access_')).split(';')[0];
  const guestDetails = await f.get(guestStatus, guestStatusCookie);
  assert.equal(guestDetails.status, 200);
  assert.deepEqual(guestDetails.body.cancellationPolicy, expected);
  await assert.rejects(f.pool.query("UPDATE er_reservations SET record=record - 'cancellationPolicyAtBooking' WHERE id=$1",
    [reference]), /immutable/);
  const forged = {...expected, policy: {...currentPolicy, tiers: currentPolicy.tiers.slice(1)}};
  await assert.rejects(f.pool.query("UPDATE er_reservations SET record=jsonb_set(record,'{cancellationPolicyAtBooking}',$2) WHERE id=$1",
    [reference, JSON.stringify(forged)]), /immutable/);

  const owner = await f.register();
  const accountInput = {...input, email: account.email, time: '14:00', paymentChoice: 'now'};
  const result = await f.post('/api/checkout', {...accountInput, cancellationPolicyAtBooking: forged,
    cancellationPolicyAcceptance: {version: currentPolicy.version, accepted: true}}, owner);
  assert.equal(result.status, 200);
  assert.equal(f.h.state.creates.length, 1);
  const ownedReference = result.body.bookingId;
  const owned = await f.store.get(ownedReference);
  assert.deepEqual(owned.cancellationPolicyAtBooking, expected);
  assert.equal(Object.hasOwn(owned, 'cancellationPolicyAcceptance'), false);
  assert.equal(f.h.state.creates[0].params.line_items[0].price_data.unit_amount, Math.round(owned.quote.total * 100));
  const detail = await f.get('/api/customer/trips/' + ownedReference, owner);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.trip.cancellationPolicy, expected);
  const foreign = await f.register({email: 'other-policy@example.test', phone: '2015550196'});
  assert.equal((await f.get('/api/customer/trips/' + ownedReference, foreign)).status, 404);
  await f.h.context.runBookingEmails();
  const notice = f.h.state.bookingMessages.find(message => message.to === guestBooking.email &&
    message.subject.includes('Reservation Confirmed'));
  assert.ok(notice);
  assert.ok(notice.text.includes(currentPolicy.version));
  assert.match(notice.text, /Cancellation policy at booking/);
  assert.doesNotMatch(notice.text, /Accepted cancellation policy|Policy accepted/);
  for (const tier of currentPolicy.tiers) assert.ok(notice.text.includes(tier.text));
});

test('PostgreSQL legacy bookings cannot acquire new terms or be automatically charged a cancellation fee', pg, async t => {
  const f = await setup(t, enabled);
  const example = await f.reserve(null, {time: '14:00'});
  const legacy = await f.store.get(example);
  const snapshot = legacy.cancellationPolicyAtBooking;
  delete legacy.cancellationPolicyAtBooking;
  delete legacy.customerAccess;
  delete legacy.checkoutFingerprint;
  delete legacy.checkoutClientHash;
  legacy.id = crypto.randomUUID();
  assert.deepEqual(await f.store.importLegacy([legacy]), {inserted: 1, skipped: 0});
  await assert.rejects(f.pool.query("UPDATE er_reservations SET record=jsonb_set(record,'{cancellationPolicyAtBooking}',$2) WHERE id=$1",
    [legacy.id, JSON.stringify(snapshot)]), /immutable/);
  await assert.rejects(f.store.importLegacy([{...legacy, id: crypto.randomUUID(), cancellationPolicyAtBooking: snapshot}]));

  const guest = await f.verify(legacy.id);
  const payment = '/api/booking/' + legacy.id + '/checkout';
  assert.equal((await f.post(payment, {}, guest)).status, 200);
  const session = [...f.h.state.sessions.values()][0];
  session.status = 'complete';
  session.payment_status = 'paid';
  assert.equal((await f.h.webhook(session)).status, 200);
  const before = await f.store.get(legacy.id);
  const result = await order(f, guestPath, guest);
  assert.equal(result.status, 200);
  const terms = result.body.terms;
  assert.equal(terms.review, 'legacy_policy');
  for (const key of ['policyVersion', 'refundCents']) assert.equal(terms[key], null);
  assert.equal(Object.hasOwn(terms, 'feePercent'), false);
  assert.equal((await cancel(f, guestPath, accept(terms), guest)).status, 409);
  assert.equal((await cancel(f, guestPath, accept(terms, true), guest)).body.request.status, 'pending');
  assert.equal(f.h.state.refundRequests.length, 0);
  assert.equal(await f.store.managedCancellation(legacy.id), null);
  assert.deepEqual(await f.store.get(legacy.id), before);
});

test('New York daylight saving transitions use elapsed time and the server pickup instant', async t => {
  const h = await harness(t);
  const parse = h.context.parseServiceDateTime;
  const evaluate = (date, time, at) => {
    const record = {id: crypto.randomUUID(), status: 'confirmed', paymentStatus: 'paid', quote: {total: 100, currency: 'usd'},
      createdAt: '2026-10-01T00:00:00.000Z', trip: {date, time}};
    record.cancellationPolicyAcceptance = {policy: currentPolicy, acceptedAt: record.createdAt};
    return cancellationTerms(record, Date.parse(at), parse);
  };
  const fall = evaluate('2026-11-01', '01:30', '2026-10-31T05:30:00.000Z');
  assert.equal(fall.pickupAt, '2026-11-01T05:30:00.000Z');
  assert.equal(fall.automaticEligible, true);
  assert.equal(evaluate('2026-11-01', '01:30', '2026-10-31T05:30:00.001Z').automaticEligible, false);
  assert.equal(evaluate('2027-03-14', '03:30', '2027-03-14T05:30:00.000Z').automaticEligible, false);
  assert.equal(evaluate('2027-03-14', '03:30', '2027-03-14T05:30:00.001Z').automaticEligible, false);
  assert.throws(() => evaluate('2027-03-14', '02:30', '2027-03-14T05:30:00.000Z'));
});

test('PostgreSQL change pricing and owner requests work with new automatic settlements disabled', pg, async t => {
  const f = await trip(t, {env: {RESERVATION_SELF_SERVICE_ENABLED: 'true', RESERVATION_AUTO_CANCELLATIONS_ENABLED: 'false'}});
  const view = await f.get(f.route, f.credentials);
  assert.equal(view.body.selfService.changePreviewsEnabled, true);
  assert.equal(view.body.selfService.autoCancellationsEnabled, false);
  const {body: {terms}} = await order(f, f.route, f.credentials);
  assert.equal((await cancel(f, f.route, accept(terms), f.credentials)).status, 404);
  const change = await f.post(f.route + '/changes/preview', {vehicle: 'suv'}, f.credentials);
  assert.equal(change.status, 200);
  const preview = change.body.preview;
  assert.deepEqual([preview.originalCents, preview.newCents, preview.differenceCents], [10000, 8000, -2000]);
  const submitted = await f.post(f.route + '/changes/confirm',
    {previewId: preview.id, revision: preview.revision, requestId: crypto.randomUUID(), confirmed: true}, f.credentials);
  assert.equal(submitted.body.request.status, 'pending');
  const admin = await f.adminLogin();
  assert.equal((await f.post(queue + '/' + submitted.body.request.id + '/verify-cancellation',
    {verifiedNoService: true, confirmed: true, note: 'Synthetic dispatch proof.'}, admin)).status, 404);
  assert.equal(f.h.state.refundRequests.length, 0);
  assert.equal(await f.store.managedCancellation(f.id), null);
  assert.equal((await f.store.get(f.id)).quote.total, 100);
});

test('PostgreSQL failed charge lookups are audited, retried on schedule, and escalated to Dispatch', pg, async t => {
  const f = await trip(t);
  f.h.state.refundError = new Error('Synthetic Stripe timeout before receipt');
  const {body: {terms}} = await order(f, f.route, f.credentials);
  const result = await cancel(f, f.route, accept(terms), f.credentials);
  assert.equal(result.body.cancellation.state, 'submitted_unknown');
  f.h.state.chargeError = true;
  const minute = 60000;
  for (const [advance, attempts, elapsed, next] of [[minute, 2, 1, 6], [5 * minute, 3, 6, 21]]) {
    f.h.advance(advance);
    await f.h.context.runReservationRefunds();
    const row = await f.store.managedCancellation(f.id);
    assert.equal(row.evidence, 'funding_lookup_failed');
    assert.equal(row.reconciliation_attempts, attempts);
    assert.equal(row.last_attempt_at.getTime(), initialClock + elapsed * minute);
    assert.equal(row.next_attempt_at.getTime(), initialClock + next * minute);
    await f.h.context.runReservationRefunds();
    assert.equal((await f.store.managedCancellation(f.id)).reconciliation_attempts, attempts);
  }
  f.h.advance(DAY - 6 * minute);
  await f.h.context.runReservationRefunds();
  const row = await f.store.managedCancellation(f.id);
  assert.equal(row.state, 'review_required');
  assert.equal(row.evidence, 'reconciliation_deadline');
  assert.equal(row.next_attempt_at, null);
  assert.equal(row.escalated_at.getTime(), initialClock + DAY);
  const audit = await f.pool.query('SELECT evidence FROM er_managed_cancellation_events WHERE cancellation_id=$1', [row.id]);
  assert.equal(audit.rows.filter(event => event.evidence === 'funding_lookup_failed').length, 2);
  assert.equal((await f.get(queue + '/settlements?status=reconciliation', f.credentials)).status, 401);
  const admin = await f.adminLogin();
  const stalled = await f.get(queue + '/settlements?status=reconciliation', admin);
  assert.equal(stalled.status, 200);
  assert.equal(stalled.body.settlements[0].reference, f.id);
  assert.equal(stalled.body.settlements[0].state, 'review_required');
  assert.equal(stalled.body.settlements[0].attempts, 3);
  const recheck = queue + '/settlements/' + f.id + '/recheck';
  assert.equal((await f.post(recheck, {}, f.credentials)).status, 401);
  assert.equal((await f.post(recheck, {}, admin, {origin: 'https://external.example.test'})).status, 403);
  assert.equal((await f.post(recheck, {amount: 10000}, admin)).status, 409);
  assert.equal((await f.post(recheck, {}, admin)).body.cancellation.state, 'review_required');
  assert.equal(f.h.state.refundRequests.length, 1, 'Dispatch recheck must not submit a Stripe refund');
  const {rows: [operator]} = await f.pool.query('SELECT actor_id FROM er_managed_cancellation_events WHERE cancellation_id=$1 AND evidence=$2',
    [row.id, 'operator_recheck_started']);
  assert.match(operator.actor_id, /^[a-f0-9-]{36}$/);
});

test('PostgreSQL a crash after Stripe accepts a refund recovers by lookup after restart without a webhook', pg, async t => {
  const f = await trip(t);
  await f.pool.query('CREATE FUNCTION test_refund_observation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ' +
    "IF NEW.evidence='provider_succeeded_awaiting_reconciliation' THEN RAISE EXCEPTION 'Synthetic write failure'; END IF; RETURN NEW; END $$; " +
    'CREATE TRIGGER test_refund_observation_failure BEFORE UPDATE ON er_managed_cancellations ' +
    'FOR EACH ROW EXECUTE FUNCTION test_refund_observation_failure()');
  const {body: {terms}} = await order(f, f.route, f.credentials);
  const result = await cancel(f, f.route, accept(terms), f.credentials);
  assert.equal(result.body.cancellation.state, 'submitted_unknown');
  const row = await f.store.managedCancellation(f.id);
  assert.equal(row.stripe_refund_id, null);
  assert.equal(row.submission_count, 1);
  assert.equal(f.h.state.refunds.size, 1);
  await f.pool.query('DROP TRIGGER test_refund_observation_failure ON er_managed_cancellations');
  const worker = await harness(t, {}, '[]', f.store);
  worker.state.sessions = f.h.state.sessions;
  worker.state.refunds = f.h.state.refunds;
  await worker.context.runReservationRefunds();
  worker.advance(60000);
  await worker.context.runReservationRefunds();
  const repaired = await f.store.managedCancellation(f.id);
  assert.equal(repaired.state, 'confirmed');
  assert.equal(repaired.evidence, 'provider_api_confirmed');
  assert.equal(repaired.stripe_refund_id, currentRefund(f).id);
  assert.equal(repaired.submission_count, 1);
  assert.equal(worker.state.refundRequests.length, 0);
  assert.equal(f.h.state.refundRequests.length, 1);
});

test('PostgreSQL scheduled lookup confirms a known pending refund without a signed delivery', pg, async t => {
  const f = await trip(t);
  f.h.state.refundStatus = 'pending';
  const {body: {terms}} = await order(f, f.route, f.credentials);
  assert.equal((await cancel(f, f.route, accept(terms), f.credentials)).body.cancellation.state, 'provider_identified');
  const refund = currentRefund(f);
  f.h.advance(60000);
  await f.h.context.runReservationRefunds();
  assert.equal((await f.store.managedCancellation(f.id)).evidence, 'provider_pending');
  refund.status = 'succeeded';
  f.h.advance(5 * 60000);
  await f.h.context.runReservationRefunds();
  assert.equal((await f.store.managedCancellation(f.id)).state, 'confirmed');
  assert.ok(f.h.state.refundRetrievals.some(request => request.id === refund.id));
  assert.equal((await refundHook(f, {...refund, status: 'pending'}, stripeEventId())).status, 200);
  assert.equal((await f.store.managedCancellation(f.id)).state, 'confirmed');
  assert.equal(f.h.state.refundRequests.length, 1);
});

test('PostgreSQL due scheduling prevents ten failed lookups from starving a later refund', {...pg, timeout: 30000}, async t => {
  const f = await setup(t, enabled);
  const owner = await f.register();
  const earlyCharges = new Set();
  const references = [];
  for (let i = 0; i < 11; i++) {
    const id = await f.reserve(owner, {email: account.email, date: '2026-10-' + (10 + i), time: '14:00'});
    const route = base + '/account/' + id;
    assert.equal((await f.post('/api/customer/trips/' + id + '/payment', {}, owner)).status, 200);
    const session = [...f.h.state.sessions.values()].at(-1);
    session.status = 'complete';
    session.payment_status = 'paid';
    assert.equal((await f.h.webhook(session)).status, 200);
    f.h.state.refundError = new Error('Synthetic Stripe timeout');
    const {body: {terms}} = await order(f, route, owner);
    assert.equal((await cancel(f, route, accept(terms), owner)).body.cancellation.state, 'submitted_unknown');
    if (i < 10) earlyCharges.add('ch_mock_' + session.payment_intent);
    references.push(id);
    f.h.advance(1);
  }
  f.h.state.chargeErrors = earlyCharges;
  f.h.advance(60000);
  await f.h.context.runReservationRefunds();
  const last = references.at(-1);
  assert.equal((await f.store.managedCancellation(last)).reconciliation_attempts, 1);
  await f.h.context.runReservationRefunds();
  assert.equal((await f.store.managedCancellation(last)).state, 'provider_identified');
  for (const id of references.slice(0, -1)) assert.equal((await f.store.managedCancellation(id)).evidence, 'funding_lookup_failed');
  assert.equal(f.h.state.refunds.size, 1);
  assert.equal(f.h.state.refundRequests.length, 12);
});

test('PostgreSQL an unrelated pending Stripe refund blocks resubmission even before the charge balance changes', pg, async t => {
  const f = await trip(t);
  f.h.state.refundError = new Error('Synthetic Stripe timeout');
  const {body: {terms}} = await order(f, f.route, f.credentials);
  assert.equal((await cancel(f, f.route, accept(terms), f.credentials)).body.cancellation.state, 'submitted_unknown');
  const {charge, amount} = f.h.state.refundRequests[0].params;
  f.h.state.refunds.set('re_mock_external', {id: 're_mock_external', charge, amount, status: 'pending', metadata: {}});
  f.h.advance(60000);
  await f.h.context.runReservationRefunds();
  const row = await f.store.managedCancellation(f.id);
  assert.equal(row.state, 'review_required');
  assert.equal(row.evidence, 'another_refund_exists');
  assert.equal(f.h.state.refundRequests.length, 1);
  assert.equal(f.h.state.refunds.size, 1);
});

test('PostgreSQL eligible cancellation refunds only the verified remaining balance, including an already-refunded payment', pg, async t => {
  for (const previous of [2000, 10000]) {
    const f = await trip(t, {signedIn: previous === 2000});
    const original = await f.store.get(f.id);
    f.h.state.refunds.set('re_external_settled', {id: 're_external_settled', charge: 'ch_mock_' + f.session.payment_intent,
      payment_intent: f.session.payment_intent, amount: previous, currency: 'usd', status: 'succeeded', metadata: {}});
    const {body: {terms}} = await order(f, f.route, f.credentials);
    assert.equal(terms.review, null);
    assert.equal(terms.refundedBeforeCents, previous);
    assert.equal(terms.refundCents, 10000 - previous);
    const input = accept(terms);
    const cancelled = await cancel(f, f.route, input, f.credentials);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.cancellation.refundCents, 10000 - previous);
    assert.equal((await cancel(f, f.route, input, f.credentials)).status, 200);
    assert.equal(f.h.state.refundRequests.length, previous === 10000 ? 0 : 1);
    const row = await f.store.managedCancellation(f.id);
    assert.equal(Number(row.refunded_before_cents), previous);
    assert.equal(Number(row.fee_cents), 0);
    assert.equal(Number(row.fee_percent), 0);
    assert.equal(Number(row.amount_cents), 10000 - previous);
    if (previous !== 10000) {
      const refund = currentRefund(f);
      assert.equal(refund.amount, 8000);
      assert.equal((await refundHook(f, refund, stripeEventId())).status, 200);
      assert.equal((await f.store.managedCancellation(f.id)).state, 'confirmed');
    } else assert.equal(row.state, 'no_refund');
    assert.deepEqual((await f.store.get(f.id)).quote, original.quote);
    assert.equal(Number((await f.pool.query('SELECT amount_cents FROM er_payment_ledger WHERE booking_id=$1', [f.id])).rows[0].amount_cents), 10000);
    const total = [...f.h.state.refunds.values()].filter(r => r.status === 'succeeded').reduce((sum, r) => sum + r.amount, 0);
    assert.equal(total, 10000);
    await assert.rejects(f.pool.query('UPDATE er_managed_cancellations SET refunded_before_cents=0 WHERE booking_id=$1', [f.id]), /immutable/);
  }
});

test('PostgreSQL uncertain prior refunds and a balance changed after preview cannot cancel or over-refund', pg, async t => {
  const f = await trip(t);
  const external = {id: 're_external_uncertain', charge: 'ch_mock_' + f.session.payment_intent,
    payment_intent: f.session.payment_intent, amount: 2000, currency: 'usd', status: 'pending', metadata: {}};
  f.h.state.refunds.set(external.id, external);
  let result = await order(f, f.route, f.credentials);
  assert.equal(result.body.terms.review, 'payment_review');
  assert.equal(result.body.terms.refundCents, null);
  assert.equal((await cancel(f, f.route, accept(result.body.terms), f.credentials)).status, 409);
  external.status = 'succeeded';
  const terms = (await order(f, f.route, f.credentials)).body.terms;
  assert.equal(terms.refundCents, 8000);
  f.h.state.refunds.set('re_external_later', {...external, id: 're_external_later', amount: 1000});
  assert.equal((await cancel(f, f.route, accept(terms), f.credentials)).status, 409);
  assert.equal((await f.store.get(f.id)).status, 'confirmed');
  assert.equal(f.h.state.refundRequests.length, 0);
  assert.equal(await f.store.managedCancellation(f.id), null);
  f.h.state.refundListOverride = {data: [...f.h.state.refunds.values()], has_more: true};
  assert.equal((await order(f, f.route, f.credentials)).body.terms.review, 'payment_review');
});

test('PostgreSQL owner cancellation decisions retire unpaid Checkout and concurrency records one immutable outcome', pg, async t => {
  const f = await trip(t, {paid: false, signedIn: false, open: true, date: '2026-10-01', time: '14:00'});
  const terms = (await order(f, f.route, f.credentials)).body.terms;
  const requested = (await cancel(f, f.route, accept(terms, true), f.credentials)).body.request;
  const admin = await f.adminLogin();
  const path = queue + '/' + requested.id + '/decision';
  f.h.state.retrieveError = true;
  assert.equal((await f.post(path, {confirmed: true, status: 'approved'}, admin)).status, 409);
  assert.equal((await f.store.get(f.id)).status, 'awaiting_payment');
  assert.equal((await f.get(f.route, f.credentials)).body.requests[0].status, 'pending');
  f.h.state.retrieveError = false;
  const responses = await Promise.all(['approved', 'declined'].map(status => f.post(path, {confirmed: true, status}, admin)));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const winner = responses.find(r => r.status === 200).body.request;
  const after = await f.store.get(f.id);
  assert.equal(after.status, winner.status === 'approved' ? 'cancelled' : 'awaiting_payment');
  assert.equal((await f.post(path, {confirmed: true, status: winner.status}, admin)).status, 200);
  assert.equal(f.h.state.refundRequests.length, 0);
  if (winner.status === 'approved') {
    assert.equal(f.session.status, 'expired');
    assert.equal((await f.post(f.payment, {}, f.credentials)).status, 409);
    await assert.rejects(f.pool.query("UPDATE er_reservations SET record=jsonb_set(record,'{status}',to_jsonb('confirmed'::text)) WHERE id=$1", [f.id]), /cannot be reopened or repriced/);
  }
  assert.equal((await f.post(queue + '/' + requested.id + '/verify-cancellation',
    {verifiedNoService: true, confirmed: true, note: 'No money-moving override.'}, admin)).status, 404);
});

test('the retired proposal remains historical evidence only and cannot authorize new cancellation fees', () => {
  const historical = {
  "version": "ER-CANCELLATION-2026-1",
  "summary": "Fees are based on the accepted reservation fare. Time before pickup is measured in elapsed hours. Eligible refunds return to the original payment method.",
  "tiers": [
    {
      "minimumHours": 24,
      "feePercent": 0,
      "verification": false,
      "text": "At least 24 hours before pickup — 0% fee. Full eligible refund."
    },
    {
      "minimumHours": 2,
      "feePercent": 10,
      "verification": false,
      "text": "At least 2 hours but less than 24 hours before pickup — 10% fee."
    },
    {
      "minimumHours": 0,
      "feePercent": 25,
      "verification": false,
      "text": "Less than 2 hours before pickup — 25% fee."
    },
    {
      "minimumHours": null,
      "feePercent": 50,
      "verification": true,
      "text": "At or after pickup — 50% fee only after authorized verification that pickup and service did not occur."
    }
  ]
};
  const record = {id: crypto.randomUUID(), createdAt: '2026-09-01T12:00:00.000Z', status: 'confirmed',
    paymentStatus: 'unpaid', quote: {total: 100, currency: 'usd'}, trip: {date: '2026-10-02', time: '12:00'}};
  record.cancellationPolicyAcceptance = {policy: historical, acceptedAt: record.createdAt};
  assert.deepEqual(acceptedPolicy(record), record.cancellationPolicyAcceptance);
  const result = cancellationTerms(record, initialClock, () => initialClock + DAY);
  assert.equal(result.review, 'legacy_policy');
  assert.equal(result.refundCents, null);
  assert.equal(result.automaticEligible, false);
  assert.equal(Object.hasOwn(result, 'feePercent'), false);
  assert.deepEqual(policyAtBooking(record), record.cancellationPolicyAcceptance);
});

test('PostgreSQL migrations preserve historical consent and reconcile settlements at their original amounts', pg, async t => {
  const fs = require('node:fs'), path = require('node:path');
  const {Pool} = require('pg');
  const {createStore} = require('../storage/postgres');
  const f = await trip(t);
  const before = await f.store.get(f.id);
  const record = structuredClone(before);
  delete record.cancellationPolicyAtBooking;
  record.cancellationPolicyAcceptance = {policy: currentPolicy, acceptedAt: record.createdAt};
  record.status = 'cancelled';
  const schema = 'prior_policy_' + crypto.randomBytes(8).toString('hex');
  const control = new Pool({connectionString: process.env.ER_TEST_DATABASE_URL});
  await control.query('CREATE SCHEMA ' + schema);
  const pool = new Pool({connectionString: process.env.ER_TEST_DATABASE_URL, options: '-c search_path=' + schema});
  const store = createStore({}, pool);
  t.after(async () => {try {await store.close(); await control.query('DROP SCHEMA ' + schema + ' CASCADE');} finally {await control.end();}});
  const directory = path.join(__dirname, '../migrations');
  const prior = fs.readdirSync(directory).filter(name => /^0(?:0[1-9]|1[0-5])-.*\.sql$/.test(name)).sort();
  assert.equal(prior.length, 14, 'Migration 001 also registers version 002');
  for (const file of prior) await pool.query(fs.readFileSync(path.join(directory, file), 'utf8'));
  assert.deepEqual((await pool.query('SELECT version FROM er_schema_migrations ORDER BY version')).rows.map(row => row.version),
    Array.from({length: 15}, (_, i) => i + 1));
  await pool.query('INSERT INTO er_reservations(id,record,created_at) VALUES($1,$2,$3)', [record.id, record, record.createdAt]);
  const {rows: [paid]} = await f.pool.query('SELECT * FROM er_payment_ledger WHERE booking_id=$1', [record.id]);
  await pool.query('INSERT INTO er_payment_ledger(booking_id,amount_cents,currency,stripe_session_id,paid_at,retain_until) VALUES($1,$2,$3,$4,$5,$6)',
    [paid.booking_id, paid.amount_cents, paid.currency, paid.stripe_session_id, paid.paid_at, paid.retain_until]);
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO er_managed_cancellations(id,booking_id,request_id,terms_revision,origin,pickup_at,fare_cents,captured_cents,' +
    'fee_percent,fee_cents,amount_cents,currency,stripe_session_id,payment_intent_id,charge_id,idempotency_key,state,evidence,created_at,updated_at,next_attempt_at)' +
    " VALUES($1,$2,$3,$4,'account',$5,10000,10000,10,1000,9000,'usd',$6,$7,$8,$9,'prepared','prepared',$10,$10,$11)",
    [id, record.id, crypto.randomUUID(), 'a'.repeat(64), '2026-10-02T16:00:00Z', f.session.id, f.session.payment_intent,
      'ch_mock_' + f.session.payment_intent, 'er-managed-cancel-' + id, new Date(initialClock), new Date(initialClock + 60000)]);
  const old = (await pool.query('SELECT * FROM er_managed_cancellations')).rows[0];
  await Promise.all([store.migrate(), store.migrate()]);
  const upgraded = await store.managedCancellation(record.id);
  const {refunded_before_cents, ...unchanged} = upgraded;
  assert.equal(Number(refunded_before_cents), 0);
  assert.deepEqual(unchanged, old);
  assert.deepEqual(await store.get(record.id), record);
  await assert.rejects(pool.query("UPDATE er_reservations SET record=record - 'cancellationPolicyAcceptance' WHERE id=$1",
    [record.id]), /immutable/);
  assert.deepEqual((await pool.query('SELECT * FROM er_payment_ledger')).rows[0], paid);
  await assert.rejects(pool.query('INSERT INTO er_managed_cancellations SELECT * FROM jsonb_populate_record(NULL::er_managed_cancellations,$1)',
    [{...upgraded, id: crypto.randomUUID(), idempotency_key: 'er-managed-cancel-' + crypto.randomUUID()}]),
    /New cancellation settlements cannot retain a fee/);

  const worker = await harness(t, {RESERVATION_SELF_SERVICE_ENABLED: 'false', RESERVATION_AUTO_CANCELLATIONS_ENABLED: 'false'}, '[]', store);
  worker.state.sessions = f.h.state.sessions;
  worker.advance(60000);
  await worker.context.runReservationRefunds();
  assert.equal(worker.state.refundRequests.length, 1);
  const refund = [...worker.state.refunds.values()][0];
  assert.equal(refund.amount, 9000, 'An existing obligation is not recalculated under the new policy');
  assert.equal((await refundHook({h: worker}, refund, stripeEventId())).status, 200);
  const final = await store.managedCancellation(record.id);
  assert.equal(final.state, 'confirmed');
  assert.equal(Number(final.fee_cents), 1000, 'Previously recorded history is immutable');
  assert.equal(Number(final.amount_cents), 9000);
  assert.deepEqual((await store.get(record.id)).quote, before.quote);
});

test('PostgreSQL My Trips cannot auto-cancel a started trip even when the scheduled pickup is still more than 24 hours away', pg, async t => {
  const f = await trip(t, {date: '2026-10-03', env: {}});
  await f.store.update(f.id, record => {record.status = 'passenger_on_board';});
  const tripPath = '/api/customer/trips/' + f.id;
  const details = (await f.get(tripPath, f.credentials)).body.trip;
  assert.equal(details.management.canCancel, false);
  const result = await f.post(tripPath + '/cancel', {expectedPickupAt: details.management.pickupAt,
    requestId: crypto.randomUUID(), confirmed: true}, f.credentials);
  assert.equal(result.status, 409);
  assert.equal(f.h.state.refundRequests.length, 0);
  assert.equal((await f.store.get(f.id)).status, 'passenger_on_board');
  const requested = await f.post(f.route + '/requests', {kind: 'cancellation', requestId: crypto.randomUUID(),
    confirmed: true}, f.credentials);
  assert.equal(requested.status, 200);
  assert.equal(requested.body.request.status, 'pending');
});
