'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {randomBytes} = require('node:crypto');
const {setTimeout: delay} = require('node:timers/promises');
const {createEmailProvider} = require('../services/email');
const {harness, cookie} = require('./helpers/reservation-management.cjs');

const origin = 'http://localhost:3000';
const headers = {origin, 'sec-fetch-site': 'same-origin'};
const enrollment = {
  firstName: 'Example', lastName: 'Rider', email: 'Enrollment@example.test',
  phone: '2015550183', password: 'Synthetic enrollment password'
};

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('Expected asynchronous enrollment delivery to complete');
}

test('Resend verification messages use the configured HTTPS origin and separate verification and recovery purposes', async () => {
  const calls = [];
  const options = {
    enabled: true, apiKey: 'synthetic-resend-credential', from: 'test@erlimousineservice.com',
    siteUrl: 'https://erlimousineservice.com', production: true,
    fetchImpl: async (url, request) => { calls.push({url, request}); return {ok: true}; }
  };
  const provider = createEmailProvider(options);
  const token = randomBytes(32).toString('base64url');
  const attemptId = randomBytes(32).toString('hex');
  const payload = {email: enrollment.email, token, attemptId};
  await provider.sendEnrollmentLink(payload);
  await provider.sendEnrollmentLink({...payload, existing: true});
  await provider.sendResetLink(payload);
  assert.equal(calls.length, 3);
  calls.forEach(({url, request}, index) => {
    assert.equal(url, 'https://api.resend.com/emails');
    const path = index === 2 ? '/reset-password.html' : '/verify-customer-email.html';
    const fragment = index === 1 ? 'verify-profile' : 'token';
    const expected = 'https://erlimousineservice.com' + path + '#' + fragment + '=' + token;
    const message = JSON.parse(request.body);
    assert.deepEqual(message.to, [enrollment.email]);
    assert.ok(message.text.includes(expected));
    assert.ok(message.html.includes('href="' + expected + '"'));
    assert.ok(!message.html.includes(enrollment.email) && !message.html.includes(enrollment.password));
    assert.equal(request.headers['Idempotency-Key'],
      (index === 2 ? 'customer-recovery/' : 'customer-email-verification/') + attemptId);
  });
  assert.throws(() => createEmailProvider({...options, siteUrl: 'http://example.test'}), /configuration unavailable/);
  await assert.rejects(provider.sendEnrollmentLink({...payload, token: 'invalid'}), /^Error: Email delivery unavailable\.$/);
  const failing = createEmailProvider({...options, fetchImpl: async () => { throw new Error('private provider details'); }});
  await assert.rejects(failing.sendEnrollmentLink(payload), /^Error: Email delivery unavailable\.$/);
});

test('a delivery failure leaves no account and a later same-browser resend can finish registration', async t => {
  const h = await harness(t, {BOOKING_EMAILS_ENABLED: 'true'});
  h.state.enrollmentFail = true;
  const result = await h.requestRaw('/api/customer/register', enrollment, headers);
  assert.equal(result.status, 202);
  const proof = cookie(result, 'er_customer_enrollment');
  assert.ok(proof);
  await waitFor(() => h.state.enrollmentCalls.length === 1);
  assert.equal(h.state.enrollmentMessages.length, 0);
  assert.equal(h.testStore.shared.customers.size, 0);
  assert.ok(!h.state.logs.join('\n').includes(enrollment.email));
  const firstToken = h.state.enrollmentCalls[0].token;
  assert.ok(!h.state.logs.join('\n').includes(firstToken));
  assert.equal((await h.requestRaw('/api/customer/enrollment/confirm', {token: firstToken}, {...headers, cookie: proof})).status, 400);
  h.advance(61_000);
  h.state.enrollmentFail = false;
  const resent = await h.requestRaw('/api/customer/enrollment/resend', {}, {...headers, cookie: proof});
  assert.equal(resent.status, 202);
  assert.deepEqual(resent.body, result.body);
  await waitFor(() => h.state.enrollmentMessages.length === 1);
  const {token} = h.state.enrollmentMessages[0];
  assert.notEqual(token, firstToken);
  assert.equal(h.state.enrollmentMessages[0].email, enrollment.email);
  const activation = await h.requestRaw('/api/customer/enrollment/confirm', {token}, {...headers, cookie: proof});
  assert.equal(activation.status, 201);
  assert.equal(activation.body.customer.emailVerified, true);
  assert.equal(activation.body.customer.email, enrollment.email);
  assert.equal(h.testStore.shared.customers.size, 1);
});

test('an existing account can verify its own email while other customer and guest sessions are denied', async t => {
  const h = await harness(t, {BOOKING_EMAILS_ENABLED: 'true'});
  const owner = await h.seedCustomer({...enrollment, fullName: 'Example Rider'});
  const other = await h.seedCustomer({...enrollment, fullName: 'Another Rider', email: 'other@example.test', phone: '2015550184'});
  const ownerCookie = cookie(owner, 'er_customer_session');
  const otherCookie = cookie(other, 'er_customer_session');
  assert.equal((await h.requestRaw('/api/customer/profile', undefined, {cookie: ownerCookie})).body.customer.emailVerified, null);
  assert.equal((await h.requestRaw('/api/customer/email-verification/request', {}, headers)).status, 401);

  const requested = await h.requestRaw('/api/customer/email-verification/request', {}, {...headers, cookie: ownerCookie});
  assert.equal(requested.status, 202);
  await waitFor(() => h.state.enrollmentMessages.length === 1);
  const {token, existing} = h.state.enrollmentMessages[0];
  assert.equal(existing, true);
  const body = {token};
  assert.equal((await h.requestRaw('/api/customer/enrollment/confirm', body, {...headers, cookie: ownerCookie})).status, 400);
  assert.equal((await h.requestRaw('/api/customer/email-verification/confirm', body, {...headers, cookie: otherCookie})).status, 400);
  const confirmed = await h.requestRaw('/api/customer/email-verification/confirm', body, {...headers, cookie: ownerCookie});
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.customer.emailVerified, true);
  assert.equal(confirmed.headers.getSetCookie().length, 0);
  assert.equal((await h.requestRaw('/api/customer/profile', undefined, {cookie: ownerCookie})).body.customer.emailVerified, true);
  assert.equal((await h.requestRaw('/api/customer/profile', undefined, {cookie: otherCookie})).body.customer.emailVerified, null);
  assert.equal((await h.requestRaw('/api/customer/email-verification/confirm', body, {...headers, cookie: ownerCookie})).status, 400);
});
