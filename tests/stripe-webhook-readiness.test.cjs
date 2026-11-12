'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const {setup, harness, guestBooking, cookie} = require('./helpers/reservation-management.cjs');
const {StorageError} = require('../storage/postgres');

const pg = {skip: !process.env.ER_TEST_DATABASE_URL && 'Requires isolated PostgreSQL'};
const tollsOff = {ROUTE_TOLLS_ENABLED: 'false'};
const unavailable = 'Online payment is temporarily unavailable. Please try again later or contact ER Limousine Service.';
const guestPayment = id => '/api/booking/' + id + '/checkout';
const accountPayment = id => '/api/customer/trips/' + id + '/payment';
const paymentLink = (id, action) => '/api/bookings/' + id + '/payment-link/' + action;
function accessCookie(response) {
  const value = response.headers.getSetCookie().find(header => header.startsWith('er_booking_access_'));
  assert.ok(value, 'Expected a reservation access cookie');
  return value.split(';')[0];
}

function expectUnavailable(response) {
  assert.equal(response.status, 503);
  assert.equal(response.body.error, unavailable);
  assert.equal(response.body.url, undefined);
  assert.equal(response.body.bookingId, undefined);
}

function post(h, origin, route, body, credentials = '') {
  return h.request(route, body, {origin, 'sec-fetch-site': 'same-origin', cookie: credentials});
}

async function restart(t, fixture, overrides = {}) {
  const worker = await harness(t, {...tollsOff, SITE_URL: fixture.h.url, ...overrides}, '[]', fixture.store);
  worker.state.sessions = fixture.h.state.sessions;
  return worker;
}

async function reserve(fixture, paymentChoice, details = {}, credentials = '') {
  const response = await fixture.post('/api/checkout', {...guestBooking, ...details, paymentChoice}, credentials);
  assert.equal(response.status, 200);
  return response;
}

async function ledger(fixture, id) {
  const {rows} = await fixture.pool.query(
    'SELECT amount_cents::int, currency, stripe_session_id FROM er_payment_ledger WHERE booking_id=$1', [id]
  );
  return rows;
}

function paid(session) {
  return {...session, status: 'complete', payment_status: 'paid'};
}

for (const [kind, secret] of [
  ['missing', undefined],
  ['empty', ''],
  ['blank', ' \t'],
  ['wrong prefix', 'sk_test_synthetic_wrong_configuration'],
  ['prefix with no secret', 'whsec_'],
  ['embedded whitespace', 'whsec_synthetic wrong'],
  ['trailing newline', 'whsec_local_mock\n']
]) {
  test('Pay Now creates neither a reservation nor a session when webhook configuration is ' + kind, pg, async t => {
    const fixture = await setup(t, {...tollsOff, STRIPE_WEBHOOK_SECRET: secret});
    const response = await fixture.post('/api/checkout', {...guestBooking, paymentChoice: 'now'});
    expectUnavailable(response);
    assert.equal(fixture.h.state.creates.length, 0);
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS n FROM er_reservations')).rows[0].n, 0);
    if (secret?.trim()) {
      assert.ok(!JSON.stringify(response.body).includes(secret));
      assert.ok(!fixture.h.state.logs.join('\n').includes(secret));
    }
    const hook = await fixture.h.webhook({id: 'cs_mock_unavailable'});
    assert.equal(hook.status, 503);
  });
}

test('a blank Stripe API key blocks Pay Now and preserves Pay Later', pg, async t => {
  const fixture = await setup(t, {...tollsOff, STRIPE_SECRET_KEY: ' \t'});
  expectUnavailable(await fixture.post('/api/checkout', {...guestBooking, paymentChoice: 'now'}));
  const later = await reserve(fixture, 'later');
  assert.equal((await fixture.store.get(later.body.bookingId)).paymentStatus, 'unpaid');
  assert.equal(fixture.h.state.creates.length, 0);
});

for (const signedIn of [false, true]) {
  test((signedIn ? 'signed-in' : 'guest') + ' Pay Later stays valid while Complete Payment is unavailable', pg, async t => {
    const fixture = await setup(t, {...tollsOff, STRIPE_WEBHOOK_SECRET: undefined});
    const account = signedIn ? await fixture.register() : '';
    const response = await reserve(fixture, 'later', {}, account);
    const id = response.body.bookingId;
    const credentials = account || accessCookie(response);
    assert.ok(credentials);
    const route = signedIn ? accountPayment(id) : guestPayment(id);
    const before = await fixture.store.get(id);
    assert.equal(before.paymentStatus, 'unpaid');
    assert.equal(before.quote.total, 100);
    assert.equal(before.deferredPayment, true);

    expectUnavailable(await fixture.post(route, {}, credentials));
    assert.deepEqual(await fixture.store.get(id), before);
    assert.equal(fixture.h.state.creates.length, 0);
    assert.deepEqual(await ledger(fixture, id), []);
  });
}

for (const [vehicle, name, amount] of [
  ['suv', 'Luxury SUV — Chevrolet Suburban Premier', 8000],
  ['escalade', 'Luxury SUV — Cadillac Escalade ESV', 10000]
]) {
  test('payment links require webhook configuration and preserve the ' + vehicle + ' fare and label', pg, async t => {
    const fixture = await setup(t, {...tollsOff, STRIPE_WEBHOOK_SECRET: ' '});
    const response = await reserve(fixture, 'later', {vehicle});
    const id = response.body.bookingId;
    const admin = await fixture.adminLogin();
    const before = await fixture.store.get(id);
    expectUnavailable(await fixture.post(paymentLink(id, 'copy'), {}, admin));
    expectUnavailable(await fixture.post(paymentLink(id, 'email'), {confirmed: true}, admin));
    assert.equal(fixture.h.state.creates.length, 0);
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS n FROM er_admin_payment_links')).rows[0].n, 0);
    assert.deepEqual(await fixture.store.get(id), before);

    const worker = await restart(t, fixture);
    vm.runInContext(
      "const createMockSession = stripe.checkout.sessions.create;" +
      "stripe.checkout.sessions.create = async (...args) => {" +
      "const session = await createMockSession(...args);" +
      "session.url = 'https://checkout.stripe.com/c/pay/' + session.id + '#isolated'; return session;};",
      worker.context
    );
    const adminLogin = await post(worker, fixture.h.url, '/api/admin/login', {token: 'local-test-token'});
    assert.equal(adminLogin.status, 200);
    const link = await post(worker, fixture.h.url, paymentLink(id, 'copy'), {}, cookie(adminLogin, 'er_admin_session'));
    assert.equal(link.status, 200);
    assert.equal(worker.state.creates.length, 1);
    const {line_items, metadata} = worker.state.creates[0].params;
    assert.equal(line_items[0].price_data.product_data.name, name);
    assert.equal(line_items[0].price_data.unit_amount, amount);
    assert.equal(metadata.bookingId, id);
    assert.deepEqual((await fixture.store.get(id)).quote, before.quote);
  });
}

test('valid raw signatures settle once, and missing, invalid or late failure events cannot overwrite payment', pg, async t => {
  const fixture = await setup(t, tollsOff);
  const response = await reserve(fixture, 'now');
  const id = response.body.bookingId;
  const session = [...fixture.h.state.sessions.values()][0];
  const original = await fixture.store.get(id);
  assert.equal(session.amount_total, Math.round(original.quote.total * 100));
  const payload = JSON.stringify({
    id: 'evt_fixture_paid',
    type: 'checkout.session.async_payment_succeeded',
    data: {object: paid(session)}
  }, null, 2);
  const signature = fixture.h.signatureSdk.webhooks.generateTestHeaderString({payload, secret: 'whsec_local_mock'});

  assert.equal((await fixture.post('/api/stripe-webhook', payload)).status, 400);
  assert.equal((await fixture.post('/api/stripe-webhook', payload + '\n', '', {'stripe-signature': signature})).status, 400);
  assert.equal((await fixture.h.webhook({...session, status: 'complete'})).status, 200);
  assert.equal((await fixture.store.get(id)).paymentStatus, 'unpaid');
  assert.deepEqual(await ledger(fixture, id), []);

  assert.equal((await fixture.post('/api/stripe-webhook', payload, '', {'stripe-signature': signature})).status, 200);
  assert.equal((await fixture.post('/api/stripe-webhook', payload, '', {'stripe-signature': signature})).status, 200);
  assert.equal((await fixture.h.webhook(session, 'checkout.session.async_payment_failed')).status, 200);
  const settled = await fixture.store.get(id);
  assert.equal(settled.paymentStatus, 'paid');
  assert.equal(settled.status, 'confirmed');
  assert.deepEqual(settled.quote, original.quote);
  assert.deepEqual(await ledger(fixture, id), [{amount_cents: 10000, currency: 'usd', stripe_session_id: session.id}]);
});

test('a temporary webhook storage failure can retry without duplicate settlement', pg, async t => {
  const fixture = await setup(t, tollsOff);
  const response = await reserve(fixture, 'now');
  const id = response.body.bookingId;
  const session = paid([...fixture.h.state.sessions.values()][0]);
  const update = fixture.store.update;
  let failOnce = true;
  fixture.store.update = (bookingId, change, options) => {
    if (bookingId === id && options?.paymentEmail && failOnce) {
      failOnce = false;
      throw new StorageError();
    }
    return update(bookingId, change, options);
  };

  assert.equal((await fixture.h.webhook(session)).status, 503);
  assert.equal((await fixture.store.get(id)).paymentStatus, 'unpaid');
  assert.deepEqual(await ledger(fixture, id), []);
  assert.equal((await fixture.h.webhook(session)).status, 200);
  assert.equal((await fixture.h.webhook(session)).status, 200);
  assert.equal((await fixture.store.get(id)).paymentStatus, 'paid');
  assert.equal((await ledger(fixture, id)).length, 1);
});

test('a well-formed secret for the wrong endpoint still rejects the expected endpoint signature', pg, async t => {
  const fixture = await setup(t, {...tollsOff, STRIPE_WEBHOOK_SECRET: 'whsec_other_synthetic_endpoint'});
  const response = await reserve(fixture, 'now');
  const id = response.body.bookingId;
  assert.equal((await fixture.h.webhook(paid([...fixture.h.state.sessions.values()][0]))).status, 400);
  assert.equal((await fixture.store.get(id)).paymentStatus, 'unpaid');
  assert.deepEqual(await ledger(fixture, id), []);
});

test('an existing Checkout stays unpaid during configuration loss and settles after restart and webhook retry', pg, async t => {
  const fixture = await setup(t, tollsOff);
  const response = await reserve(fixture, 'now');
  const id = response.body.bookingId;
  const access = accessCookie(response);
  const origin = fixture.h.url;
  const original = await fixture.store.get(id);
  const session = [...fixture.h.state.sessions.values()][0];

  const offline = await restart(t, fixture, {STRIPE_WEBHOOK_SECRET: undefined});
  expectUnavailable(await post(offline, origin, guestPayment(id), {}, access));
  assert.equal((await offline.webhook(paid(session))).status, 503);
  const shown = await offline.request('/api/booking/' + id + '?paid=true', undefined, {cookie: access});
  assert.equal(shown.status, 200);
  assert.equal(shown.body.paymentStatus, 'unpaid');
  assert.deepEqual(await fixture.store.get(id), original);
  assert.equal(offline.state.creates.length, 0);

  const online = await restart(t, fixture);
  const resumed = await post(online, origin, guestPayment(id), {}, access);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.url, response.body.url);
  assert.equal(online.state.creates.length, 0);
  assert.equal((await online.webhook(paid(session))).status, 200);
  assert.equal((await online.webhook(paid(session))).status, 200);
  assert.equal((await fixture.store.get(id)).paymentStatus, 'paid');
  assert.equal((await ledger(fixture, id)).length, 1);
});

test('an expired Checkout cannot create a replacement until verification configuration is restored', pg, async t => {
  const fixture = await setup(t, tollsOff);
  const response = await reserve(fixture, 'now', {vehicle: 'suv'});
  const id = response.body.bookingId;
  const original = await fixture.store.get(id);
  const access = accessCookie(response);
  const session = [...fixture.h.state.sessions.values()][0];
  session.status = 'expired';

  const offline = await restart(t, fixture, {STRIPE_WEBHOOK_SECRET: 'whsec_'});
  expectUnavailable(await post(offline, fixture.h.url, guestPayment(id), {}, access));
  assert.equal(offline.state.sessions.size, 1);
  assert.equal(offline.state.creates.length, 0);
  assert.deepEqual(await fixture.store.get(id), original);

  const online = await restart(t, fixture);
  assert.equal((await post(online, fixture.h.url, guestPayment(id), {}, access)).status, 200);
  assert.equal(online.state.creates.length, 1);
  assert.equal(online.state.sessions.size, 2);
  const item = online.state.creates[0].params.line_items[0].price_data;
  assert.equal(item.unit_amount, 8000);
  assert.equal(item.product_data.name, 'Luxury SUV — Chevrolet Suburban Premier');
  assert.deepEqual((await fixture.store.get(id)).quote, original.quote);
});

test('an interrupted Checkout keeps its idempotency identity through a configuration outage', pg, async t => {
  const fixture = await setup(t, tollsOff);
  const response = await reserve(fixture, 'later');
  const id = response.body.bookingId;
  const access = accessCookie(response);
  const route = guestPayment(id);
  fixture.h.state.loseResponse = true;
  assert.equal((await fixture.post(route, {}, access)).status, 503);
  assert.equal(fixture.h.state.sessions.size, 1);
  const attempt = await fixture.store.get(id);
  const submitted = fixture.h.state.creates[0];

  const offline = await restart(t, fixture, {STRIPE_WEBHOOK_SECRET: ''});
  expectUnavailable(await post(offline, fixture.h.url, route, {}, access));
  assert.equal(offline.state.creates.length, 0);
  assert.deepEqual(await fixture.store.get(id), attempt);

  const online = await restart(t, fixture);
  assert.equal((await post(online, fixture.h.url, route, {}, access)).status, 200);
  assert.equal(online.state.sessions.size, 1);
  assert.equal(online.state.creates.length, 1);
  assert.equal(online.state.creates[0].options.idempotencyKey, submitted.options.idempotencyKey);
  assert.deepEqual(structuredClone(online.state.creates[0].params), structuredClone(submitted.params));
  assert.equal((await fixture.store.get(id)).paymentStatus, 'unpaid');
});

test('a Stripe API error with valid signing configuration fails safely without marking the reservation paid', pg, async t => {
  const fixture = await setup(t, tollsOff);
  const privateDetail = 'synthetic private Stripe API diagnostic';
  fixture.h.state.fail = new Error(privateDetail);
  const result = await fixture.post('/api/checkout', {...guestBooking, paymentChoice: 'now'});
  assert.equal(result.status, 503);
  assert.match(result.body.error, /^Checkout is temporarily unavailable\. Please try again\./);
  assert.ok(!JSON.stringify(result.body).includes(privateDetail));
  assert.ok(!fixture.h.state.logs.join('\n').includes(privateDetail));
  assert.equal(fixture.h.state.sessions.size, 0);
  const [booking] = await fixture.store.list();
  assert.equal(booking.paymentStatus, 'unpaid');
  assert.equal(booking.quote.total, 100);
  assert.deepEqual(await ledger(fixture, booking.id), []);
});
