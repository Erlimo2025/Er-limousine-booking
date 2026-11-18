'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {ownerProcessFixture} = require('./helpers/dispatch-owner-process.cjs');
const {hashToken} = require('../auth/customers');
const OTPAuth = require('otpauth');
const pg = {skip: !process.env.ER_TEST_DATABASE_URL, timeout: 120000};
const base = '/api/admin/owner';
const copy = (from, to) => {for (const [key, value] of from.jar) to.jar.set(key, value);};

test('two separate real-server Node processes share MFA sessions, revocation and durable state after restart', pg, async t => {
  const f = await ownerProcessFixture(t), first = await f.enroll();
  const shared = f.client(1);copy(first.client, shared);
  assert.equal((await shared.request('/api/bookings/search')).status, 200);
  const second = await f.login(1), secondOnFirst = f.client(0);copy(second, secondOnFirst);
  assert.equal((await secondOnFirst.request('/api/bookings/search')).status, 200);
  const initialPid = f.workers[1].process.pid;
  await f.restart(1);
  assert.notEqual(f.workers[1].process.pid, initialPid);
  assert.equal((await second.request('/api/bookings/search')).status, 200, 'The original session survives an actual Node process restart');
  assert.equal((await shared.request('/api/admin/session?mode=charts')).status, 200);

  const revokedCookies = [...second.jar];
  assert.equal((await first.client.request(base + '/sessions/revoke-others', {
    password: f.owner.password, code: await f.code()
  })).status, 200);
  for (const person of [second, secondOnFirst]) {
    assert.equal((await person.request('/api/bookings/search')).status, 401);
    assert.equal((await person.request(base + '/audit')).status, 401);
  }
  assert.equal((await first.client.request('/api/bookings/search')).status, 200);
  assert.equal((await shared.request('/api/bookings/search')).status, 200, 'Reusing the retained current session across a worker remains allowed');
  await f.restart(1);
  // A 401 clears the browser jar. Explicitly replay the old opaque cookie so
  // this proves persistent revocation, rather than merely anonymous denial.
  for (const [name, value] of revokedCookies) second.jar.set(name, value);
  assert.equal((await second.request('/api/bookings/search')).status, 401, 'Restart cannot resurrect a revoked session');
  assert.equal((await shared.request('/api/bookings/search')).status, 200);
  const sessions = await first.client.request(base + '/sessions');
  assert.equal(sessions.status, 200);assert.equal(sessions.body.sessions.length, 1);
  assert.equal((await shared.request(base + '/logout', {})).status, 200);
  assert.equal((await first.client.request('/api/bookings/search')).status, 401);
  assert.doesNotMatch(f.output(), /password_hash|mfa_cipher|token_hash|process-owner@example|Synthetic process owner password/);
});

test('login, MFA and recovery budgets are shared by separate Node processes and survive process restarts', pg, async t => {
  const f = await ownerProcessFixture(t), enrolled = await f.enroll();
  await f.advance(6 * 60000);
  const pending = f.client(0), other = f.client(1);
  assert.equal((await pending.request(base + '/login', {email: f.owner.email, password: f.owner.password})).body.step, 'mfa');
  copy(pending, other);
  const correct = await f.code(enrolled.seed), verifier = new OTPAuth.TOTP({secret: enrolled.seed});
  let wrong;
  for (let value = 0; value < 1000000; value++) {
    const candidate = String(value).padStart(6, '0');
    if (verifier.validate({token: candidate, timestamp: f.now(), window: 1}) === null) {wrong = candidate;break;}
  }
  assert.ok(wrong);
  const firstBatch = await Promise.all([pending, other].map(person => person.request(base + '/verify', {code: wrong})));
  assert.deepEqual(firstBatch.map(response => response.status), [401, 401]);
  await f.restart(1);
  const remainder = await Promise.all(Array.from({length: 6}, (_, index) =>
    (index % 2 ? other : pending).request(base + '/verify', {code: wrong})));
  assert.ok(remainder.every(response => response.status === 401));
  assert.equal((await other.request(base + '/verify', {code: correct})).status, 429);
  assert.equal((await pending.request(base + '/verify', {code: correct})).status, 429);
  await f.restart(0);
  assert.equal((await pending.request(base + '/verify', {code: correct})).status, 429, 'MFA limits remain enforced after both workers have restarted');

  // After identity exhaustion, the shared source limiter must still bound the
  // request stream. Its 31st attempt stops before incrementing identity state.
  for (let index = 0; index < 19; index++) assert.equal((await (index % 2 ? other : pending).request(base + '/verify', {code: wrong})).status, 429);
  assert.equal((await other.request(base + '/verify', {code: wrong})).status, 429);
  const mfaCounters = (await f.pool.query("SELECT scope,attempts FROM er_dispatch_auth_limits WHERE scope IN ('mfa_source','mfa_identity')")).rows;
  assert.equal(mfaCounters.find(row => row.scope === 'mfa_source').attempts, 31);
  assert.equal(mfaCounters.find(row => row.scope === 'mfa_identity').attempts, 30);

  await f.advance(16 * 60000);
  // Password work is intentionally bounded in production. Keep no more than
  // two requests active per process while using both independent workers.
  for (let batch = 0; batch < 5; batch++) {
    const responses = await Promise.all(Array.from({length: 4}, (_, index) =>
      f.client(index % 2).request(base + '/login', {email: f.owner.email, password: 'Invalid synthetic owner password'})));
    assert.ok(responses.every(response => response.status === 401));
    if (batch === 1) await f.restart(1);
  }
  assert.equal((await f.client(0).request(base + '/login', {email: f.owner.email, password: f.owner.password})).status, 429);
  await f.restart(0);
  assert.equal((await f.client(1).request(base + '/login', {email: f.owner.email, password: f.owner.password})).status, 429);
  assert.equal((await f.client(0).request(base + '/login', {email: f.owner.email, password: f.owner.password})).status, 429);
  // Vary the claimed identity to isolate the shared source budget as well.
  for (let index = 0; index < 7; index++) assert.equal((await f.client(index % 2).request(base + '/login', {
    email: 'synthetic-source-' + index + '@example.test', password: 'Invalid synthetic owner password'
  })).status, 401);
  const unusedIdentity = 'synthetic-source-final@example.test';
  assert.equal((await f.client(1).request(base + '/login', {email: unusedIdentity, password: 'Invalid synthetic owner password'})).status, 429);
  assert.equal((await f.pool.query("SELECT attempts FROM er_dispatch_auth_limits WHERE scope='login_source'")).rows[0].attempts, 31);
  assert.equal((await f.pool.query("SELECT 1 FROM er_dispatch_auth_limits WHERE scope='login_identity' AND identity_hash=$1", [hashToken(unusedIdentity)])).rowCount, 0);
  await f.restart(1);
  assert.equal((await f.client(1).request(base + '/login', {email: unusedIdentity, password: f.owner.password})).status, 429);

  await f.advance(16 * 60000);
  for (let batch = 0; batch < 2; batch++) {
    const responses = await Promise.all(Array.from({length: 4}, (_, index) =>
      f.client(index % 2).request(base + '/recover', {
        email: f.owner.email, password: f.owner.password, recoveryCode: 'Invalid synthetic recovery code'
      })));
    assert.ok(responses.every(response => response.status === 401));
    if (batch === 0) await f.restart(1);
  }
  const validRecovery = {email: f.owner.email, password: f.owner.password, recoveryCode: enrolled.recoveryCodes[0]};
  assert.equal((await f.client(0).request(base + '/recover', validRecovery)).status, 429);
  await f.restart(0);
  assert.equal((await f.client(0).request(base + '/recover', validRecovery)).status, 429);
  assert.equal((await f.pool.query('SELECT 1 FROM er_dispatch_recovery_codes WHERE owner_id=$1 AND code_hash=$2',
    [f.owner.id, hashToken(enrolled.recoveryCodes[0])])).rowCount, 1, 'Rate-limited recovery must not consume a valid code');
  // Recovery has its own 20-source budget; exhaustion is shared too.
  for (let index = 0; index < 10; index++) assert.equal((await f.client(index % 2).request(base + '/recover', validRecovery)).status, 429);
  assert.equal((await f.client(1).request(base + '/recover', validRecovery)).status, 429);
  const recoveryCounters = (await f.pool.query("SELECT scope,attempts FROM er_dispatch_auth_limits WHERE scope IN ('recovery_source','recovery_identity')")).rows;
  assert.equal(recoveryCounters.find(row => row.scope === 'recovery_source').attempts, 21);
  assert.equal(recoveryCounters.find(row => row.scope === 'recovery_identity').attempts, 20);
  assert.doesNotMatch(f.output(), /password_hash|mfa_cipher|token_hash|process-owner@example|Synthetic process owner password/);
});
