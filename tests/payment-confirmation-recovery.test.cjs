'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const {setup, harness, guestBooking} = require('./helpers/reservation-management.cjs');

const postgres = {skip: !process.env.ER_TEST_DATABASE_URL && 'Requires isolated PostgreSQL'};
const env = {ROUTE_TOLLS_ENABLED: 'false'};
const minute = 60_000;
const recoveryPath = id => '/api/bookings/' + id + '/reconcile';
const guestPayment = id => '/api/booking/' + id + '/checkout';
const ownerPayment = id => '/api/customer/trips/' + id + '/payment';
const paymentLink = id => '/api/bookings/' + id + '/payment-link/copy';

function bookingCookie(response) {
  const value = response.headers.getSetCookie().find(header => header.startsWith('er_booking_access_'));
  assert.ok(value);
  return value.split(';')[0];
}

async function book(fixture, paymentChoice, credentials = '', details = {}) {
  const response = await fixture.post('/api/checkout', {...guestBooking, ...details, paymentChoice}, credentials);
  assert.equal(response.status, 200);
  const id = response.body.bookingId;
  return {id, access: bookingCookie(response), original: await fixture.store.get(id)};
}

async function accounting(fixture, id) {
  const {rows: [counts]} = await fixture.pool.query(`SELECT
    (SELECT count(*)::int FROM er_payment_ledger WHERE booking_id=$1) AS ledger,
    (SELECT count(*)::int FROM er_booking_email_outbox
      WHERE booking_id=$1 AND kind IN ('payment_confirmed','admin_payment_confirmed')) AS email,
    (SELECT count(*)::int FROM er_reservation_refunds WHERE booking_id=$1) AS refunds,
    (SELECT count(*)::int FROM er_managed_cancellations WHERE booking_id=$1 AND stripe_refund_id IS NOT NULL) AS managed`, [id]);
  return counts;
}

function providerResult(h, changes) {
  const session = [...h.state.sessions.values()].at(-1);
  assert.ok(session);
  return Object.assign(session, changes);
}

function paid(h) {
  return providerResult(h, {status: 'complete', payment_status: 'paid'});
}

function scan(h) {
  return h.context.runPaymentConfirmationRecovery();
}

function countLookups(h) {
  h.state.paymentRecoveryLookups = 0;
  vm.runInContext(`const originalRecoveryRetrieve = stripe.checkout.sessions.retrieve;
    stripe.checkout.sessions.retrieve = (...args) => {
      recordPaymentRecoveryLookup();
      return originalRecoveryRetrieve(...args);
    };`, Object.assign(h.context, {
    recordPaymentRecoveryLookup: () => h.state.paymentRecoveryLookups++
  }));
}

function staffPost(h, origin, id, staff) {
  return h.request(recoveryPath(id), {}, {origin, 'sec-fetch-site': 'same-origin', cookie: staff});
}

test('Pay Now ages into Dispatch review and settles once through a late signed event', postgres, async t => {
  const fixture = await setup(t, env);
  const {h, store, post, get} = fixture;
  const {id, access, original} = await book(fixture, 'now');
  countLookups(h);
  const session = paid(h);
  h.advance(29 * minute);
  await scan(h);
  assert.equal(h.state.paymentRecoveryLookups, 0);
  assert.equal((await store.get(id)).paymentConfirmationReview, undefined);
  h.advance(minute);
  await scan(h);
  const waiting = await store.get(id);
  assert.equal(waiting.paymentStatus, 'unpaid');
  assert.equal(waiting.status, 'awaiting_payment');
  assert.deepEqual(waiting.quote, original.quote);
  assert.equal(waiting.paymentConfirmationReview.status, 'paid_awaiting_webhook');
  assert.equal(waiting.paymentConfirmationReview.paymentIntentId, session.payment_intent);
  assert.equal(waiting.checkoutAttempt.evidence, 'verified_paid_awaiting_webhook');
  assert.deepEqual(await accounting(fixture, id), {ledger: 0, email: 0, refunds: 0, managed: 0});

  const staff = await fixture.adminLogin();
  const dispatch = await get('/api/bookings/search?payment=review&timing=all&status=all', staff);
  assert.equal(dispatch.status, 200);
  assert.equal(dispatch.headers.get('cache-control'), 'no-store');
  const [card] = dispatch.body.bookings;
  assert.equal(card.id, id);
  assert.match(card.bookingReference, /^ER-\d{6}$/);
  assert.deepEqual(card.paymentConfirmation, {
    ageMinutes: 30, checkedAt: waiting.paymentConfirmationReview.checkedAt, status: 'paid_awaiting_webhook',
    lastResult: 'paid_awaiting_webhook', needsReview: true
  });
  assert.equal(card.canRequestPaymentLink, false);
  assert.doesNotMatch(JSON.stringify(card.paymentConfirmation), /cs_mock|pi_mock|@/);

  const status = await get('/api/booking/' + id + '?paid=true&session_id=' + session.id, access);
  assert.equal(status.body.paymentStatus, 'unpaid');
  assert.equal(status.body.paymentVerificationPending, true);
  assert.equal(status.body.paymentConfirmation, undefined);
  assert.equal((await post(guestPayment(id), {}, access)).status, 409);
  assert.equal((await post(paymentLink(id), {}, staff)).status, 409);
  assert.equal((await post(recoveryPath(id), {}, staff)).status, 200);
  await scan(h);
  assert.equal(h.state.paymentRecoveryLookups, 1);
  assert.equal(h.state.creates.length, 1);
  assert.deepEqual(await accounting(fixture, id), {ledger: 0, email: 0, refunds: 0, managed: 0});

  assert.equal((await h.webhook(session, 'checkout.session.completed', true)).status, 400);
  assert.equal((await h.webhook({...session, payment_intent: 'pi_wrong'})).status, 400);
  assert.equal((await h.webhook(session)).status, 200);
  assert.equal((await h.webhook(session)).status, 200);
  assert.equal((await h.webhook({...session, payment_status: 'unpaid'}, 'checkout.session.async_payment_failed')).status, 200);
  const settled = await store.get(id);
  assert.equal(settled.paymentStatus, 'paid');
  assert.equal(settled.status, 'confirmed');
  assert.deepEqual(settled.quote, original.quote);
  assert.deepEqual(await accounting(fixture, id), {ledger: 1, email: 2, refunds: 0, managed: 0});
  const after = await get('/api/bookings/search?payment=review&timing=all&status=all', staff);
  assert.equal(after.body.bookings.length, 0);
});

for (const channel of ['guest', 'signed-in', 'Dispatch']) {
  test('Pay Later recovery covers ' + channel + ' Checkout at the accepted total', postgres, async t => {
    const fixture = await setup(t, env);
    const {h, store, post, get} = fixture;
    const owner = channel === 'signed-in' ? await fixture.register() : '';
    const {id, access, original} = await book(fixture, 'later', owner);
    h.advance(31 * minute);
    await scan(h);
    assert.equal((await store.get(id)).paymentConfirmationReview, undefined);
    assert.equal(h.state.creates.length, 0);
    const path = channel === 'guest' ? guestPayment(id) : channel === 'signed-in' ? ownerPayment(id) : paymentLink(id);
    const staff = channel === 'Dispatch' ? await fixture.adminLogin() : '';
    const credentials = owner || (channel === 'Dispatch' ? staff : access);
    if (channel === 'Dispatch') {
      vm.runInContext(`const originalRecoveryCreate = stripe.checkout.sessions.create;
        stripe.checkout.sessions.create = async (...args) => {
          const session = await originalRecoveryCreate(...args);
          session.url = 'https://checkout.stripe.com/c/pay/' + session.id + '#fixture';
          return session;
        };`, h.context);
    }
    const checkout = await post(path, {}, credentials);
    assert.equal(checkout.status, 200);
    assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount, Math.round(original.quote.total * 100));
    assert.equal((await post(path, {}, credentials)).status, 200);
    assert.equal(h.state.creates.length, 1);
    const session = paid(h);
    h.advance(31 * minute);
    await scan(h);
    assert.equal((await store.get(id)).paymentConfirmationReview.status, 'paid_awaiting_webhook');
    const retryCredentials = channel === 'Dispatch' ? await fixture.adminLogin() : credentials;
    assert.equal((await post(path, {}, retryCredentials)).status, 409);
    if (channel === 'signed-in') {
      const another = await fixture.register({email: 'different-owner@example.test', phone: '2015550119'});
      assert.equal((await post(path, {}, another)).status, 404);
    }
    const publicStatus = await get('/api/booking/' + id + '?paid=true', access);
    assert.equal(publicStatus.body.paymentVerificationPending, true);
    assert.deepEqual(await accounting(fixture, id), {ledger: 0, email: 0, refunds: 0, managed: 0});
    assert.equal((await h.webhook(session)).status, 200);
    assert.deepEqual((await store.get(id)).quote, original.quote);
    assert.deepEqual(await accounting(fixture, id), {ledger: 1, email: 2, refunds: 0, managed: 0});
  });
}

test('manual checks require Dispatch session and same origin and accept no client payment data', postgres, async t => {
  const fixture = await setup(t, env);
  const {h, store, post} = fixture;
  const {id, access} = await book(fixture, 'now');
  const staff = await fixture.adminLogin();
  const owner = await fixture.register();
  countLookups(h);
  for (const credentials of ['', access, owner]) {
    assert.equal((await post(recoveryPath(id), {}, credentials)).status, 401);
  }
  assert.equal((await post(recoveryPath(id), {}, staff, {origin: 'https://outside.example.test'})).status, 403);
  assert.equal((await post(recoveryPath(id), {}, staff, {origin: ''})).status, 403);
  assert.equal((await post(recoveryPath(id), {paymentStatus: 'paid'}, staff)).status, 403);
  assert.equal((await post(recoveryPath('32dfaa63-7d13-4591-8641-6e97484a7db6'), {}, staff)).status, 404);
  assert.equal(h.state.paymentRecoveryLookups, 0);
  assert.equal((await store.get(id)).paymentConfirmationReview, undefined);
  assert.equal((await post(recoveryPath(id), {}, staff)).status, 200);
  assert.equal((await store.get(id)).paymentConfirmationReview.status, 'session_open');
  assert.equal(h.state.paymentRecoveryLookups, 1);
});

test('unpaid, pending, failed and expired sessions never settle or cancel through recovery', postgres, async t => {
  const fixture = await setup(t, env);
  const {h, store, post} = fixture;
  const {id, access, original} = await book(fixture, 'now');
  const session = providerResult(h, {status: 'open', payment_status: 'unpaid'});
  h.advance(31 * minute);
  await scan(h);
  assert.equal((await store.get(id)).paymentConfirmationReview.status, 'session_open');
  h.advance(61 * minute);
  Object.assign(session, {status: 'complete'});
  await scan(h);
  assert.equal((await store.get(id)).paymentConfirmationReview.status, 'payment_pending');
  assert.equal((await post(guestPayment(id), {}, access)).status, 409);
  assert.equal((await h.webhook(session, 'checkout.session.async_payment_failed')).status, 200);
  const failure = await store.get(id);
  assert.equal(failure.paymentStatus, 'failed');
  assert.equal(failure.status, 'awaiting_payment');
  assert.equal(failure.paymentConfirmationReview, undefined);

  h.advance(61 * minute);
  Object.assign(session, {status: 'expired'});
  await scan(h);
  const expired = await store.get(id);
  assert.equal(expired.paymentConfirmationReview.status, 'expired_unpaid');
  assert.equal(expired.status, 'awaiting_payment');
  assert.equal(h.state.creates.length, 1);
  assert.deepEqual(await accounting(fixture, id), {ledger: 0, email: 0, refunds: 0, managed: 0});
  assert.equal((await post(guestPayment(id), {}, access)).status, 200);
  assert.equal(h.state.creates.length, 2);
  const second = await store.get(id);
  assert.notEqual(second.stripeSessionId, session.id);
  assert.notEqual(h.state.creates[0].options.idempotencyKey, h.state.creates[1].options.idempotencyKey);
  assert.deepEqual(second.quote, original.quote);
  const staff = await fixture.adminLogin();
  assert.equal((await post(recoveryPath(id), {}, staff)).status, 200);
  assert.equal((await store.get(id)).paymentConfirmationReview.status, 'session_open');
});

test('an expired session clears stale pending evidence without opening a replacement', postgres, async t => {
  const fixture = await setup(t, env);
  const {h, store, get, post} = fixture;
  const {id, access} = await book(fixture, 'now');
  const session = providerResult(h, {status: 'complete', payment_status: 'unpaid'});
  h.advance(31 * minute);
  await scan(h);
  assert.equal((await get('/api/booking/' + id, access)).body.paymentVerificationPending, true);

  h.advance(61 * minute);
  Object.assign(session, {status: 'expired'});
  await scan(h);
  const expired = await store.get(id);
  assert.equal(expired.paymentConfirmationReview.status, 'expired_unpaid');
  assert.equal(expired.paymentStatus, 'unpaid');
  assert.equal((await get('/api/booking/' + id, access)).body.paymentVerificationPending, false);
  assert.equal(h.state.creates.length, 1);
  assert.equal((await post(guestPayment(id), {}, access)).status, 200);
  assert.equal(h.state.creates.length, 2);
});

test('the scheduled check caps provider requests and makes progress across batches', postgres, async t => {
  const fixture = await setup(t, env);
  const {h, store} = fixture;
  const bookings = [];
  for (let i = 0; i < 9; i++) {
    bookings.push(await book(fixture, 'now', '', {
      email: 'recovery-batch-' + i + '@example.test', phone: '201555012' + i
    }));
    paid(h);
  }
  countLookups(h);
  h.advance(31 * minute);
  await scan(h);
  assert.equal(h.state.paymentRecoveryLookups, 8);
  await scan(h);
  assert.equal(h.state.paymentRecoveryLookups, 9);
  for (const {id} of bookings) {
    assert.equal((await store.get(id)).paymentConfirmationReview.status, 'paid_awaiting_webhook');
  }
  assert.equal(h.state.creates.length, 9);
});

test('wrong session, booking, currency or amount only records mismatch for Dispatch', postgres, async t => {
  const fixture = await setup(t, env);
  const {h, store, post} = fixture;
  const {id, original} = await book(fixture, 'now');
  const staff = await fixture.adminLogin();
  const session = paid(h);
  const correct = structuredClone(session);
  for (const change of [{id: 'cs_wrong'}, {metadata: {...session.metadata, bookingId: 'wrong'}},
    {currency: 'eur'}, {amount_total: session.amount_total + 1}]) {
    Object.assign(session, correct, change);
    assert.equal((await post(recoveryPath(id), {}, staff)).status, 200);
    const record = await store.get(id);
    assert.equal(record.paymentConfirmationReview.status, 'session_mismatch');
    assert.equal(record.stripeSessionId, original.stripeSessionId);
    assert.equal(record.paymentStatus, 'unpaid');
    assert.deepEqual(record.quote, original.quote);
    h.advance(6 * minute);
  }
  assert.deepEqual(await accounting(fixture, id), {ledger: 0, email: 0, refunds: 0, managed: 0});
  assert.equal(h.state.creates.length, 1);
});

test('provider failure and restart preserve unresolved evidence until signed redelivery', postgres, async t => {
  const fixture = await setup(t, env);
  const {h, store} = fixture;
  const {id} = await book(fixture, 'now');
  const session = paid(h);
  h.state.retrieveError = true;
  h.advance(31 * minute);
  await scan(h);
  assert.equal((await store.get(id)).paymentConfirmationReview.status, 'provider_unavailable');
  const offline = await harness(t, {...env, SITE_URL: h.url, STRIPE_WEBHOOK_SECRET: undefined}, '[]', store);
  offline.state.sessions = h.state.sessions;
  offline.advance(92 * minute);
  await scan(offline);
  const verified = await store.get(id);
  assert.equal(verified.paymentConfirmationReview.status, 'paid_awaiting_webhook');
  assert.equal(verified.paymentStatus, 'unpaid');
  assert.equal((await offline.webhook(session)).status, 503);
  assert.equal(offline.state.creates.length, 0);

  const restarted = await harness(t, {...env, SITE_URL: h.url}, '[]', store);
  restarted.state.sessions = h.state.sessions;
  restarted.state.retrieveError = true;
  restarted.advance(98 * minute);
  const login = await restarted.request('/api/admin/login', {token: 'local-test-token'}, {origin: h.url});
  const staff = login.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await staffPost(restarted, h.url, id, staff)).status, 200);
  const afterError = await store.get(id);
  assert.equal(afterError.paymentConfirmationReview.status, 'paid_awaiting_webhook');
  assert.equal(afterError.paymentConfirmationReview.lastResult, 'provider_unavailable');
  assert.deepEqual(await accounting(fixture, id), {ledger: 0, email: 0, refunds: 0, managed: 0});
  assert.equal((await restarted.webhook(session)).status, 200);
  assert.deepEqual(await accounting(fixture, id), {ledger: 1, email: 2, refunds: 0, managed: 0});
});

test('a lost Checkout response binds only a uniquely matched persisted attempt', postgres, async t => {
  const fixture = await setup(t, env);
  const {h, store, post} = fixture;
  const {id, access, original} = await book(fixture, 'later');
  h.state.loseResponse = true;
  assert.equal((await post(guestPayment(id), {}, access)).status, 503);
  const submitted = await store.get(id);
  assert.equal(submitted.stripeSessionId, null);
  assert.equal(submitted.checkoutAttempt.state, 'submitted_unknown');
  const session = paid(h);
  const duplicate = {...session, id: 'cs_duplicate_fixture'};
  h.state.sessions.set(duplicate.id, duplicate);
  h.advance(31 * minute);
  await scan(h);
  assert.equal((await store.get(id)).paymentConfirmationReview.status, 'session_unidentified');
  assert.equal((await store.get(id)).stripeSessionId, null);
  assert.equal(h.state.listCalls, 1);
  h.state.sessions.delete(duplicate.id);
  h.advance(6 * minute);
  const staff = await fixture.adminLogin();
  assert.equal((await post(recoveryPath(id), {}, staff)).status, 200);
  const recovered = await store.get(id);
  assert.equal(recovered.stripeSessionId, session.id);
  assert.equal(recovered.checkoutAttempt.key, submitted.checkoutAttempt.key);
  assert.deepEqual(recovered.checkoutAttempt.parameters, submitted.checkoutAttempt.parameters);
  assert.deepEqual(recovered.quote, original.quote);
  assert.equal(recovered.paymentConfirmationReview.status, 'paid_awaiting_webhook');
  assert.equal(recovered.paymentStatus, 'unpaid');
  assert.equal((await post(guestPayment(id), {}, access)).status, 409);
  assert.equal(h.state.creates.length, 1);
  assert.equal((await h.webhook(session)).status, 200);
  assert.deepEqual(await accounting(fixture, id), {ledger: 1, email: 2, refunds: 0, managed: 0});
});

test('concurrent manual and scheduled checks serialize and a signed webhook can win the race', postgres, async t => {
  const fixture = await setup(t, env);
  const {h, store, post} = fixture;
  const {id, access} = await book(fixture, 'now');
  const session = paid(h);
  h.advance(31 * minute);
  const staff = await fixture.adminLogin();
  let signalStart;
  let release;
  const started = new Promise(resolve => { signalStart = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  t.after(release);
  vm.runInContext(`const originalRaceRetrieve = stripe.checkout.sessions.retrieve;
    stripe.checkout.sessions.retrieve = async (...args) => {
      signalRecoveryStart();
      await holdRecoveryLookup;
      return originalRaceRetrieve(...args);
    };`, Object.assign(h.context, {signalRecoveryStart: signalStart, holdRecoveryLookup: held}));
  const scheduled = scan(h);
  await started;
  try {
    assert.equal((await post(recoveryPath(id), {}, staff)).status, 409);
    assert.equal((await post(guestPayment(id), {}, access)).status, 409);
    assert.equal((await h.webhook(session)).status, 200);
  } finally {
    release();
    await scheduled;
  }
  const settled = await store.get(id);
  assert.equal(settled.paymentStatus, 'paid');
  assert.equal(settled.paymentConfirmationReview, undefined);
  assert.equal(h.state.creates.length, 1);
  assert.deepEqual(await accounting(fixture, id), {ledger: 1, email: 2, refunds: 0, managed: 0});
});

test('FIRST15 and paid reservations with refund history stay outside ordinary recovery', postgres, async t => {
  const fixture = await setup(t, env);
  const {h, store, post} = fixture;
  const firstRide = await book(fixture, 'now', '', {promoCode: 'FIRST15'});
  const firstRideSession = paid(h);
  const {id} = await book(fixture, 'now', '', {email: 'refund-recovery@example.test', phone: '2015550107', time: '15:00'});
  const session = paid(h);
  assert.equal((await h.webhook(session)).status, 200);
  const record = await store.get(id);
  await store.withActionLock(record.checkoutFingerprint, () => store.update(id, booking => {
    booking.status = 'cancelled';
    booking.refundStatus = 'processing';
  }));
  const pending = await store.get(id);
  h.advance(31 * minute);
  await scan(h);
  const staff = await fixture.adminLogin();
  assert.equal((await store.get(firstRide.id)).paymentConfirmationReview, undefined);
  assert.deepEqual(await store.get(id), pending);
  assert.equal((await post(recoveryPath(firstRide.id), {}, staff)).status, 200);
  assert.equal((await store.get(firstRide.id)).checkoutAttempt.evidence, 'verified_paid_awaiting_webhook');
  assert.equal((await h.webhook(firstRideSession)).status, 200);
  assert.equal((await post(recoveryPath(id), {}, staff)).status, 200);
  await store.update(id, booking => { booking.refundStatus = 'confirmed'; });
  const confirmed = await store.get(id);
  await scan(h);
  assert.deepEqual(await store.get(id), confirmed);
  assert.deepEqual(await accounting(fixture, id), {ledger: 1, email: 2, refunds: 0, managed: 0});
  assert.equal(h.state.creates.length, 2);
});
