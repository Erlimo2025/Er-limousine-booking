'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {createRequire} = require('node:module');
const {setTimeout: delay} = require('node:timers/promises');
const {Pool} = require('pg');
const {createStore} = require('../../storage/postgres');
const anchor = path.resolve(__dirname, '../security-abuse.test.cjs');
const source = fs.readFileSync(anchor, 'utf8').replace(
  'server.listen(0, "127.0.0.1", resolve)',
  'server.listen(Number(env.PORT || 0), "127.0.0.1", resolve)'
);
const {harness, booking} = new Function('require', '__dirname',
  source.slice(0, source.indexOf('test("approved prices')) + '\nreturn {harness, booking};'
)(createRequire(anchor), path.dirname(anchor));

const base = '/api/booking/manage';
const queue = '/api/admin/reservation-requests';
const guestBooking = {...booking, email: 'manage-guest@example.test', time: '13:00'};
const account = {fullName: 'Test Owner', email: 'manage-owner@example.test', phone: '2015550182', password: 'Synthetic reservation owner password'};
const cookie = (response, name) => response.headers.getSetCookie().find(value => value.includes(name + '='))?.split(';')[0];
const initialClock = Date.parse('2026-10-01T16:00:00Z');
const invitationSubject = 'Verify access to your ER Limousine reservation';

async function setup(t, overrides = {}) {
  const url = new URL(process.env.ER_TEST_DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && /^\/er_test_[a-z0-9_]+$/.test(url.pathname));
  assert.equal(url.search + url.hash, '');
  const schema = 'reservation_management_' + crypto.randomBytes(8).toString('hex');
  const admin = new Pool({connectionString: url.href});
  let store;
  t.after(async () => {
    try {
      await store?.close();
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    }
    finally { await admin.end(); }
  });
  await admin.query('CREATE SCHEMA ' + schema);
  const pool = new Pool({connectionString: url.href, options: '-c search_path=' + schema});
  store = createStore({}, pool);
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = String(probe.address().port);
  await new Promise(resolve => probe.close(resolve));
  const h = await harness(t, {
    PORT: port, SITE_URL: 'http://127.0.0.1:' + port,
    BOOKING_EMAILS_ENABLED: 'true', RESEND_API_KEY: 'synthetic-resend-credential',
    CUSTOMER_RECOVERY_FROM: 'test@erlimousineservice.com', ...overrides
  }, '[]', store);
  const origin = overrides.SITE_URL || h.url;
  const headers = {origin, 'sec-fetch-site': 'same-origin'};
  const post = (path, body, credentials, extra) => h.request(path, body, {...headers, cookie: credentials || '', ...extra});
  const get = (path, credentials) => h.request(path, undefined, {cookie: credentials || ''});
  async function register(details = {}) {
    const result = await post('/api/customer/register', {...account, ...details});
    assert.equal(result.status, 201);
    return cookie(result, 'er_customer_session');
  }
  async function reserve(credentials, details = {}) {
    const result = await post('/api/checkout', {...guestBooking, paymentChoice: 'later', ...details}, credentials);
    assert.equal(result.status, 200);
    return result.body.bookingId;
  }
  async function adminLogin() {
    const result = await post('/api/admin/login', {token: 'local-test-token'});
    assert.equal(result.status, 200);
    return cookie(result, 'er_admin_session');
  }
  const invitations = () => h.state.bookingMessages.filter(message => message.subject === invitationSubject);
  async function waitForInvitation(index = 0) {
    for (let i = 0; i < 100 && !invitations()[index]; i++) await delay(20);
    const message = invitations()[index];
    assert.ok(message, 'Expected a synthetic verification email');
    const link = new URL(message.text.split('\n\n')[1]);
    assert.equal(link.pathname, '/manage-reservation.html');
    assert.equal(link.search, '');
    assert.match(link.hash, /^#verify=[A-Za-z0-9_-]{43}$/);
    return {message, link, token: link.hash.slice(8)};
  }
  async function requestVerification(reference, email = guestBooking.email) {
    const result = await post(base + '/verification/request', {reference, email});
    assert.equal(result.status, 202);
    return result;
  }
  async function verify(reference, email, index = 0) {
    await requestVerification(reference, email);
    const {token} = await waitForInvitation(index);
    const result = await post(base + '/verification/exchange', {token});
    assert.equal(result.status, 200);
    return cookie(result, 'er_reservation_management') || cookie(result, '__Secure-er_reservation_management');
  }
  return {h, store, pool, get, post, register, reserve, adminLogin, invitations, waitForInvitation, requestVerification, verify};
}

module.exports = {setup, harness, base, queue, account, guestBooking, initialClock, cookie};
