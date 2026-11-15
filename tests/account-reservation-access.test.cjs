'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {setTimeout: delay} = require('node:timers/promises');
const {hashToken} = require('../auth/customers');
const {setup, base, account, guestBooking, cookie} = require('./helpers/reservation-management.cjs');

const pg = {skip: !process.env.ER_TEST_DATABASE_URL && 'Requires isolated loopback PostgreSQL'};
const ownerBooking = {...guestBooking, email: account.email, phone: account.phone, paymentChoice: 'later'};
const otherAccount = {email: 'second-m06a-account@example.test', phone: '2015550191'};
const statusPath = id => '/api/booking/' + id;
const legacyPayment = id => statusPath(id) + '/checkout';
const tripPath = id => '/api/customer/trips/' + id;
const accountPayment = id => tripPath(id) + '/payment';
const credentials = (...cookies) => cookies.filter(Boolean).join('; ');

async function reserve(f, body, session) {
  const response = await f.post('/api/checkout', body, session);
  assert.equal(response.status, 200);
  const {bookingId: id} = response.body;
  const bookingAccess = cookie(response, 'er_booking_access_' + id);
  const checkoutAccess = cookie(response, 'er_checkout_access_' + id);
  assert.ok(bookingAccess && checkoutAccess);
  return {id, bookingAccess, checkoutAccess};
}

async function signIn(f, details = account) {
  const response = await f.post('/api/customer/login', {email: details.email, password: details.password});
  assert.equal(response.status, 200);
  const session = cookie(response, 'er_customer_session');
  assert.ok(session);
  return session;
}

function assertDenied(response, statuses) {
  assert.ok(statuses.includes(response.status), 'Unexpected HTTP status ' + response.status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(response.body).sort(), ['error', 'referenceId']);
  assert.equal(typeof response.body.error, 'string');
  assert.match(response.body.referenceId, /^[a-f0-9-]{36}$/);
}

function assertPrivatePayment(result, id) {
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['bookingId', 'url']);
  assert.equal(result.body.bookingId, id);
  assert.equal(new URL(result.body.url).hostname, 'checkout.example.test');
}

test('PostgreSQL owner confirmation and My Trips use active relational ownership', pg, async t => {
  const f = await setup(t);
  const owner = await f.register();
  const foreign = await f.register(otherAccount);
  const {id, bookingAccess} = await reserve(f, ownerBooking, owner);
  assert.equal(await f.store.reservationOwner(id), (await f.store.customerByEmail(account.email)).id);

  for (const access of [owner, credentials(owner, bookingAccess)]) {
    const result = await f.get(statusPath(id), access);
    assert.equal(result.status, 200);
    assert.equal(result.body.id, id);
    assert.equal(result.body.paymentStatus, 'unpaid');
    assert.equal(result.body.quote.total, (await f.store.get(id)).quote.total);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  const mine = await f.get(tripPath(id), owner);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.trip.reference, id);
  const list = await f.get('/api/customer/trips', owner);
  assert.ok(list.body.trips.some(trip => trip.reference === id));

  const absent = await f.get(statusPath(randomUUID()), foreign);
  assertDenied(absent, [401]);
  for (const access of [foreign, credentials(foreign, bookingAccess), bookingAccess]) {
    const result = await f.get(statusPath(id), access);
    assertDenied(result, [401]);
    assert.equal(result.body.error, absent.body.error);
  }
  assertDenied(await f.get(tripPath(id), foreign), [404]);
  assertDenied(await f.get(base + '/account/' + id, foreign), [404]);
  const reference = mine.body.trip.bookingReference;
  assert.match(reference, /^ER-\d{6}$/);
  assertDenied(await f.get(statusPath(reference)), [401]);
});

test('PostgreSQL logout rejects retained owned booking cookies for confirmation, Pay Later and Checkout retry', pg, async t => {
  const f = await setup(t);
  const owner = await f.register();
  const foreign = await f.register(otherAccount);
  const {id, bookingAccess, checkoutAccess} = await reserve(f, ownerBooking, owner);
  const before = await f.store.get(id);
  assert.equal((await f.post('/api/customer/logout', {}, owner)).status, 200);

  const otherTabs = [bookingAccess, credentials(owner, bookingAccess), credentials(foreign, bookingAccess)];
  for (const access of otherTabs) {
    assertDenied(await f.get(statusPath(id), access), [401]);
    assertDenied(await f.post(legacyPayment(id), {}, access), [404]);
    assertDenied(await f.post(accountPayment(id), {}, access), [401, 404]);
  }
  for (const paymentChoice of ['later', 'now']) {
    const result = await f.post('/api/checkout', {...ownerBooking, paymentChoice}, checkoutAccess);
    assertDenied(result, [503]);
  }
  assert.equal(f.h.state.creates.length, 0);
  assert.deepEqual(await f.store.get(id), before);

  const active = await signIn(f);
  assert.equal((await f.get(statusPath(id), active)).status, 200);
  const beforeGoogle = f.h.state.googleCalls;
  const legacy = await f.post(legacyPayment(id), {}, active);
  assertPrivatePayment(legacy, id);
  const retry = await f.post(accountPayment(id), {}, active);
  assert.deepEqual(retry.body, legacy.body);
  assert.equal(retry.status, 200);
  assert.equal(f.h.state.creates.length, 1);
  assert.equal(f.h.state.creates[0].params.line_items[0].price_data.unit_amount, Math.round(before.quote.total * 100));
  assert.deepEqual((await f.store.get(id)).quote, before.quote);
  assert.equal(f.h.state.googleCalls, beforeGoogle);
});

test('PostgreSQL expired and revoked account sessions cannot use a current booking cookie', pg, async t => {
  const f = await setup(t);
  const expired = await f.register();
  const {id, bookingAccess, checkoutAccess} = await reserve(f, ownerBooking, expired);
  const sessionHash = session => hashToken(session.slice(session.indexOf('=') + 1));
  await f.pool.query("UPDATE er_customer_sessions SET expires_at=created_at + interval '1 minute' WHERE token_hash=$1",
    [sessionHash(expired)]);
  f.h.advance(2 * 60_000);

  const revoked = await signIn(f);
  assert.equal((await f.get(statusPath(id), revoked)).status, 200);
  await f.store.revokeCustomerSession(sessionHash(revoked));
  for (const session of [expired, revoked]) {
    assertDenied(await f.get(statusPath(id), credentials(session, bookingAccess)), [401]);
    assertDenied(await f.post(legacyPayment(id), {}, credentials(session, bookingAccess)), [404]);
    assertDenied(await f.post('/api/checkout', ownerBooking, credentials(session, checkoutAccess)), [503]);
  }
  assert.equal(f.h.state.creates.length, 0);
  assert.equal((await f.get(statusPath(id), await signIn(f))).status, 200);
});

test('PostgreSQL password reset revokes owned access through every retained tab credential', pg, async t => {
  const f = await setup(t, {CUSTOMER_EMAIL_RECOVERY_ENABLED: 'true'});
  const owner = await f.register();
  const secondSession = await signIn(f);
  const {id, bookingAccess, checkoutAccess} = await reserve(f, ownerBooking, owner);
  const recovery = '/api/customer/recovery';
  assert.equal((await f.post(recovery + '/request', {email: account.email})).status, 200);

  let message;
  for (let attempt = 0; attempt < 100; attempt++) {
    message = f.h.state.emailMessages[0];
    if (message) {
      const delivery = await f.pool.query('SELECT delivery_state FROM er_customer_recovery WHERE email_token_hash=$1',
        [hashToken(message.token)]);
      if (delivery.rows[0]?.delivery_state === 'sent') break;
    }
    await delay(10);
  }
  assert.ok(message, 'Expected a mocked reset link');
  const exchange = await f.post(recovery + '/exchange', {token: message.token});
  assert.equal(exchange.status, 200);
  const password = 'Synthetic updated reservation owner password';
  const reset = await f.post(recovery + '/reset', {password, confirmPassword: password}, cookie(exchange, 'er_customer_reset'));
  assert.equal(reset.status, 200);

  for (const session of [owner, secondSession]) {
    assertDenied(await f.get(statusPath(id), credentials(session, bookingAccess)), [401]);
    assertDenied(await f.post(legacyPayment(id), {}, credentials(session, bookingAccess)), [404]);
    assertDenied(await f.post('/api/checkout', ownerBooking, credentials(session, checkoutAccess)), [503]);
  }
  assert.equal(f.h.state.creates.length, 0);
  const active = await signIn(f, {...account, password});
  assert.equal((await f.get(tripPath(id), active)).status, 200);
  assert.equal((await f.get(statusPath(id), active)).status, 200);
});

test('PostgreSQL genuine guest booking cookies and verified grants retain only their own reservation access', pg, async t => {
  const f = await setup(t);
  const owner = await f.register();
  const owned = await reserve(f, ownerBooking, owner);
  const guest = await reserve(f, {...guestBooking, paymentChoice: 'later'}, null);
  const other = await reserve(f, {...guestBooking, paymentChoice: 'later', time: '14:00'}, null);
  assert.equal(await f.store.reservationOwner(guest.id), null);
  const grant = await f.verify(guest.id);
  assert.equal((await f.post('/api/customer/logout', {}, owner)).status, 200);

  for (const access of [guest.bookingAccess, grant]) {
    const read = await f.get(statusPath(guest.id), access);
    assert.equal(read.status, 200);
    assert.equal(read.body.id, guest.id);
    assertDenied(await f.get(statusPath(owned.id), access), [401]);
    assertDenied(await f.post(legacyPayment(owned.id), {}, access), [404]);
  }
  const managed = await f.get(base + '/guest', grant);
  assert.equal(managed.status, 200);
  assert.equal(managed.body.reservation.reference, guest.id);
  for (const access of [undefined, other.bookingAccess]) {
    assertDenied(await f.get(statusPath(guest.id), access), [401]);
    assertDenied(await f.post(legacyPayment(guest.id), {}, access), [404]);
  }
  const before = await f.store.get(guest.id);
  const completed = await f.post(legacyPayment(guest.id), {}, grant);
  assertPrivatePayment(completed, guest.id);
  assert.deepEqual((await f.post(legacyPayment(guest.id), {}, guest.bookingAccess)).body, completed.body);
  assert.equal(f.h.state.creates.length, 1);
  const {params} = f.h.state.creates[0];
  assert.equal(params.line_items[0].price_data.unit_amount, Math.round(before.quote.total * 100));
  assert.equal(Object.hasOwn(params, 'customer'), false);
  assert.equal(await f.store.reservationOwner(guest.id), null);
});

test('PostgreSQL saved-card Checkout and ordinary Pay Now retry remain owner-bound', pg, async t => {
  const f = await setup(t, {CUSTOMER_PAYMENT_METHODS_ENABLED: 'true'});
  const owner = await f.register();
  const foreign = await f.register(otherAccount);
  const body = {...ownerBooking, paymentChoice: 'now'};
  const {id, bookingAccess, checkoutAccess} = await reserve(f, body, owner);
  const record = await f.store.get(id);
  const mapping = await f.store.paymentMapping(await f.store.reservationOwner(id));
  const first = f.h.state.creates[0];
  assert.equal(first.params.customer, mapping.stripe_customer_id);
  assert.equal(first.params.saved_payment_method_options.payment_method_save, 'enabled');
  assert.equal(first.params.line_items[0].price_data.unit_amount, Math.round(record.quote.total * 100));

  const wrongLegacy = await f.post(legacyPayment(id), {}, credentials(foreign, bookingAccess));
  assertDenied(wrongLegacy, [404]);
  assertDenied(await f.post(accountPayment(id), {}, foreign), [404]);
  assertDenied(await f.post('/api/checkout', body, credentials(foreign, checkoutAccess)), [503]);
  assertPrivatePayment(await f.post('/api/checkout', body, credentials(owner, checkoutAccess)), id);
  assertPrivatePayment(await f.post(accountPayment(id), {}, owner), id);
  assert.equal(f.h.state.creates.length, 1);
  assert.equal(f.h.state.sessions.size, 1);
  assert.deepEqual(await f.store.get(id), record);
});

test('PostgreSQL mid-flight logout withholds an owned Checkout URL without duplicating the payment attempt', {...pg, timeout: 15_000}, async t => {
  const f = await setup(t);
  const owner = await f.register();
  const {id, bookingAccess} = await reserve(f, ownerBooking, owner);
  const before = await f.store.get(id);
  let entered;
  let release;
  const started = new Promise(resolve => {entered = resolve;});
  const pending = new Promise(resolve => {release = resolve;});
  f.h.state.checkoutOnCreate = () => {entered(); return pending;};

  const payment = f.post(legacyPayment(id), {}, owner);
  try {
    await Promise.race([started, payment.then(result => {throw new Error('Checkout ended before the provider call with HTTP ' + result.status);})]);
    assert.equal((await f.post('/api/customer/logout', {}, owner)).status, 200);
  } finally {
    release();
  }
  assertDenied(await payment, [401, 404]);
  assertDenied(await f.get(statusPath(id), bookingAccess), [401]);
  assertDenied(await f.post(legacyPayment(id), {}, bookingAccess), [404]);
  assert.equal(f.h.state.creates.length, 1);
  assert.equal(f.h.state.sessions.size, 1);

  const resumed = await f.post(accountPayment(id), {}, await signIn(f));
  assertPrivatePayment(resumed, id);
  assert.equal(f.h.state.creates.length, 1);
  assert.deepEqual((await f.store.get(id)).quote, before.quote);
});
