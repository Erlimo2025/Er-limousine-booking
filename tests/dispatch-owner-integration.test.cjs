'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const OTPAuth = require('otpauth');
const {hashPassword, hashToken} = require('../auth/customers');
const {setup, guestBooking, initialClock, cookie} = require('./helpers/reservation-management.cjs');
const pg = {skip: !process.env.ER_TEST_DATABASE_URL};
const prefix = '/api/admin/owner';

async function fixture(t) {
  const f = await setup(t, {DISPATCH_OWNER_ENABLED: 'true', DISPATCH_MFA_KEY: crypto.randomBytes(32).toString('base64')});
  const owner = {id: crypto.randomUUID(), name: 'Synthetic Owner', email: 'private-owner@example.test', password: 'Synthetic owner integration password'};
  await f.store.dispatchProvisionOwner({...owner, passwordHash: await hashPassword(owner.password), now: initialClock});
  const login = await f.post(prefix + '/login', {email: owner.email, password: owner.password});
  assert.equal(login.status, 200);
  const challenge = cookie(login, 'er_dispatch_challenge');
  const setupResponse = await f.post(prefix + '/enrollment/start', {}, challenge);
  assert.equal(setupResponse.status, 200);
  const seed = setupResponse.body.secret;
  const code = new OTPAuth.TOTP({secret: seed}).generate({timestamp: initialClock});
  const enrolled = await f.post(prefix + '/enrollment/confirm', {code}, challenge);
  assert.equal(enrolled.status, 200);
  const credentials = cookie(enrolled, 'er_dispatch_owner_session');
  return {...f, owner, credentials, challenge};
}

test('actual server owner mode rejects legacy and incomplete authority while preserving signed payment and driver privacy', pg, async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.get(prefix + '/config')).body, {enabled: true, legacyLoginEnabled: false});
  assert.equal((await f.post('/api/admin/login', {token: 'local-test-token'})).status, 403);
  const customer = await f.register();
  for (const credentials of [undefined, f.challenge, customer, 'er_admin_session=' + crypto.randomBytes(32).toString('base64url')]) {
    assert.equal((await f.get('/api/bookings/search', credentials)).status, 401);
    assert.equal((await f.get(prefix + '/audit', credentials)).status, 401);
  }
  assert.equal((await f.get('/api/bookings/search', f.credentials)).status, 200);
  const charts = await f.get('/api/admin/session?mode=charts', f.credentials);
  assert.equal(charts.status, 200);assert.equal(charts.body.owner.id, f.owner.id);
  const reserved = await f.post('/api/checkout', {...guestBooking, paymentChoice: 'now'});
  assert.equal(reserved.status, 200);
  const id = reserved.body.bookingId;
  const guest = cookie(reserved, 'er_booking_access_' + id);
  const parameters = f.h.state.creates.at(-1).params;
  assert.equal(parameters.line_items[0].price_data.product_data.description, 'ER Limousine transportation service');
  assert.equal(new URL(parameters.success_url).searchParams.get('booking'), id);
  assert.equal(new URL(parameters.success_url).searchParams.has('session_id'), false);
  const session = [...f.h.state.sessions.values()].at(-1);
  session.status = 'complete';session.payment_status = 'paid';
  assert.equal((await f.h.webhook(session, undefined, true)).status, 400);
  assert.equal((await f.store.get(id)).paymentStatus, 'unpaid');
  assert.equal((await f.h.webhook(session)).status, 200);
  assert.equal((await f.store.get(id)).paymentStatus, 'paid');
  const assignment = {driver: 'Synthetic Driver', driverPhone: '2015550148', vehicle: 'Synthetic SUV', plate: 'SYNTHETIC'};
  const headers = {cookie: f.credentials, origin: f.h.url, 'sec-fetch-site': 'same-origin'};
  const assigned = await f.h.request('/api/bookings/' + id, {status: 'assigned', dispatch: assignment, actorId: crypto.randomUUID()}, headers, 'PATCH');
  assert.equal(assigned.status, 200);
  assert.deepEqual((await f.get('/api/booking/' + id, guest)).body.dispatch, assignment);
  assert.equal((await f.h.request('/api/bookings/' + id, {status: 'completed'}, headers, 'PATCH')).status, 200);
  const completed = await f.get('/api/booking/' + id, guest);
  assert.equal(completed.status, 200);
  const {driverPhone, ...allowed} = assignment;
  assert.deepEqual(completed.body.dispatch, allowed);
  const account = await f.get(prefix + '/session', f.credentials);
  assert.equal(account.body.owner.id, f.owner.id);
  const events = await f.get(prefix + '/audit', f.credentials);
  assert.equal(events.status, 200);
  const mutation = events.body.events.find(event => event.referenceId === assigned.headers.get('x-request-id') && event.action === 'driver_assignment_update');
  assert.ok(mutation);assert.equal(mutation.staffId, f.owner.id);assert.equal(mutation.staffName, f.owner.name);assert.equal(mutation.outcome, 'succeeded');
  assert.doesNotMatch(JSON.stringify(events.body), /private-owner@example|2015550148|Synthetic Driver|SYNTHETIC|cs_mock|pi_mock|token_hash|password_hash/);
});

test('actual server rechecks database revocation after a delayed booking read and does not renew idle Charts polling', pg, async t => {
  const f = await fixture(t);
  const raw = f.credentials.split('=')[1], hash = hashToken(raw);
  const before = (await f.pool.query('SELECT last_seen_at FROM er_dispatch_sessions WHERE token_hash=$1', [hash])).rows[0].last_seen_at.getTime();
  f.h.advance(5 * 60_000);
  assert.equal((await f.get('/api/admin/session?mode=charts', f.credentials)).status, 200);
  assert.equal((await f.pool.query('SELECT last_seen_at FROM er_dispatch_sessions WHERE token_hash=$1', [hash])).rows[0].last_seen_at.getTime(), before);
  const search = f.store.searchAdminReservations;
  let entered, release;
  const ready = new Promise(resolve => {entered = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  f.store.searchAdminReservations = async (...args) => {const result = await search(...args);entered();await gate;return result;};
  const pending = f.get('/api/bookings/search', f.credentials);
  await ready;
  try {await f.store.dispatchRevokeSession(hash);} finally {release();}
  const response = await pending;
  f.store.searchAdminReservations = search;
  assert.equal(response.status, 401);assert.equal(Object.hasOwn(response.body, 'bookings'), false);
  assert.equal((await f.get(prefix + '/audit', f.credentials)).status, 401);
});

test('revocation during a delayed Dispatch write denies status changes and cancellation without a false failure or mutation', pg, async t => {
  for (const status of ['assigned', 'cancelled']) {
    const f = await fixture(t), id = await f.reserve();
    const original = await f.store.get(id), update = f.store.update;
    let entered, release;
    const ready = new Promise(resolve => {entered = resolve;});
    const gate = new Promise(resolve => {release = resolve;});
    f.store.update = async (...args) => {entered();await gate;return update(...args);};
    const pending = f.h.request('/api/bookings/' + id, {status},
      {cookie: f.credentials, origin: f.h.url, 'sec-fetch-site': 'same-origin'}, 'PATCH');
    await ready;
    try {await f.store.dispatchRevokeSession(hashToken(f.credentials.split('=')[1]));} finally {release();}
    const response = await pending;
    f.store.update = update;
    assert.equal(response.status, 401);
    assert.deepEqual(await f.store.get(id), original);
    const events = f.h.state.logs.flatMap(line => {try {return [JSON.parse(line)];} catch (_) {return [];}})
      .filter(entry => entry.category === 'dispatch_security' && entry.referenceId === response.headers.get('x-request-id'));
    assert.equal(events.length, 1);
    assert.equal(events[0].action, status === 'cancelled' ? 'reservation_cancellation' : 'reservation_status_update');
    assert.equal(events[0].outcome, 'denied');
    assert.equal(events[0].staffId, f.owner.id);
  }
});

test('revocation during sensitive request and settlement queue reads prevents a late customer-data response', pg, async t => {
  for (const [path, method] of [
    ['/api/admin/reservation-requests', 'listReservationRequests'],
    ['/api/admin/reservation-requests/settlements', 'listManagedCancellations']
  ]) {
    const f = await fixture(t), original = f.store[method];
    let entered, release;
    const ready = new Promise(resolve => {entered = resolve;});
    const gate = new Promise(resolve => {release = resolve;});
    f.store[method] = async (...args) => {const rows = await original(...args);entered();await gate;return rows;};
    const pending = f.get(path, f.credentials);
    await ready;
    try {await f.store.dispatchRevokeSession(hashToken(f.credentials.split('=')[1]));} finally {release();}
    const response = await pending;
    f.store[method] = original;
    assert.equal(response.status, 401);
    assert.equal(Object.hasOwn(response.body, 'requests'), false);
    assert.equal(Object.hasOwn(response.body, 'settlements'), false);
  }
});
