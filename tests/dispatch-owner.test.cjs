'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {hashPassword} = require('../auth/customers');
const {ownerFixture} = require('./helpers/dispatch-owner.cjs');
const pg = {skip: !process.env.ER_TEST_DATABASE_URL};
const base = '/api/admin/owner';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const copyCookies = (from, to) => {for (const [name, value] of from.jar) to.jar.set(name, value);};
const noSecrets = (value, secrets = []) => {
  const text = JSON.stringify(value);
  for (const secret of secrets.filter(Boolean)) assert.equal(text.includes(secret), false, 'Sensitive value was disclosed');
  assert.doesNotMatch(text, /password_hash|mfa_cipher|pending_cipher|code_hash|token_hash|PRIVATE-/);
};

test('owner provisioning is private, singleton, separate from customer identities, and migration is repeatable', pg, async t => {
  const f = await ownerFixture(t, {provision: false});
  const input = {...f.owner, passwordHash: await hashPassword(f.owner.password), now: f.now(), audit: {
    timestamp: new Date(f.now()).toISOString(), referenceId: crypto.randomUUID(), action: 'owner_provisioned', outcome: 'succeeded'
  }};
  const provisioned = await f.stores[0].dispatchProvisionOwner(input);
  assert.equal(provisioned.id, f.owner.id);
  const provisioning = (await f.stores[1].dispatchAuditPage({action: 'owner_provisioned'})).events;
  assert.equal(provisioning.length, 1);
  assert.equal(provisioning[0].staffId, null, 'Private operator provisioning is not a signed-in owner action');
  assert.equal(provisioning[0].actorId, null);
  assert.equal(provisioning[0].recordId, f.owner.id);
  await assert.rejects(f.stores[1].dispatchProvisionOwner({...input, id: crypto.randomUUID(), email: 'second@example.test'}), {status: 409});
  await Promise.all(f.stores.map(store => store.migrate()));
  assert.equal((await f.pools[0].query('SELECT 1 FROM er_dispatch_owners')).rowCount, 1);
  assert.equal((await f.pools[0].query('SELECT 1 FROM er_customers')).rowCount, 0);
  assert.equal((await f.pools[0].query('SELECT 1 FROM er_schema_migrations WHERE version=20')).rowCount, 1);
  const anonymous = f.client();
  for (const resource of ['/register', '/provision', '/emergency-recovery']) {
    assert.equal((await anonymous.request(base + resource, {email: f.owner.email})).status, 404);
  }
});

test('owner enrollment grants no Dispatch authority until MFA is verified and exposes no reusable secret afterward', pg, async t => {
  const f = await ownerFixture(t), person = f.client();
  const first = await person.request(base + '/login', {email: f.owner.email, password: f.owner.password});
  assert.equal(first.status, 200);assert.equal(first.body.step, 'enroll');
  noSecrets(first.body, [f.owner.password]);
  const cookies = first.headers.getSetCookie().join(';');
  assert.match(cookies, /HttpOnly/);assert.match(cookies, /SameSite=Strict/i);
  assert.equal((await person.request('/api/protected')).status, 401);
  assert.equal((await person.request(base + '/audit')).status, 401);
  const start = await person.request(base + '/enrollment/start', {});
  assert.equal(start.status, 200);assert.match(start.body.secret, /^[A-Z2-7]+$/);
  assert.ok(start.body.uri.startsWith('otpauth://totp/'));
  const repeated = await person.request(base + '/enrollment/start', {});
  assert.equal(repeated.body.secret, start.body.secret);
  const record = (await f.pools[0].query('SELECT pending_cipher FROM er_dispatch_challenges')).rows[0];
  assert.ok(record.pending_cipher);assert.equal(record.pending_cipher.includes(start.body.secret), false);
  const confirm = await person.request(base + '/enrollment/confirm', {code: f.code(start.body.secret)});
  assert.equal(confirm.status, 200);assert.equal(confirm.body.owner.id, f.owner.id);
  assert.ok(confirm.body.recoveryCodes.length >= 8);
  assert.equal(new Set(confirm.body.recoveryCodes).size, confirm.body.recoveryCodes.length);
  assert.equal((await person.request('/api/protected')).status, 200);
  assert.notEqual((await person.request(base + '/enrollment/start', {})).status, 200);
  const session = await person.request(base + '/session');
  assert.equal(session.status, 200);assert.equal(session.body.owner.name, f.owner.name);
  noSecrets(session.body, [start.body.secret, ...confirm.body.recoveryCodes, f.owner.password]);
});

test('wrong MFA and cross-origin challenges fail without leaking passwords, codes, seeds or raw errors', pg, async t => {
  const f = await ownerFixture(t), person = f.client();
  const denied = await person.request(base + '/login', {email: 'PRIVATE-LOGIN@example.test', password: 'PRIVATE-PASSWORD'});
  assert.equal(denied.status, 401);noSecrets(denied.body);
  const cross = await person.request(base + '/login', {email: f.owner.email, password: f.owner.password}, {headers: {origin: 'https://cross.example.test'}});
  assert.equal(cross.status, 403);
  await person.request(base + '/login', {email: f.owner.email, password: f.owner.password});
  const start = await person.request(base + '/enrollment/start', {});
  const correct = f.code(start.body.secret);
  const wrong = correct === '000000' ? '999999' : '000000';
  const fail = await person.request(base + '/enrollment/confirm', {code: wrong});
  assert.ok([400, 401].includes(fail.status));
  assert.equal((await person.request('/api/protected')).status, 401);
  noSecrets(f.lines, [start.body.secret, f.owner.password, correct, wrong]);
  assert.equal((await f.pools[0].query('SELECT 1 FROM er_dispatch_sessions')).rowCount, 0);
});

test('MFA challenges expire, are single use across instances, and reject accepted TOTP step replay', pg, async t => {
  const f = await ownerFixture(t);
  const enrollment = await f.enroll();
  const person = f.client(), other = f.client(1);
  await person.request(base + '/login', {email: f.owner.email, password: f.owner.password});
  copyCookies(person, other);
  const code = f.code(enrollment.seed);
  const results = await Promise.all([person, other].map(client => client.request(base + '/verify', {code})));
  assert.deepEqual(results.map(value => value.status).sort(), [200, 401]);
  const replay = f.client();
  await replay.request(base + '/login', {email: f.owner.email, password: f.owner.password});
  assert.equal((await replay.request(base + '/verify', {code})).status, 401);
  f.advance(5 * 60_000);
  assert.equal((await replay.request(base + '/verify', {code: f.code(enrollment.seed)})).status, 401);
});

test('database sessions survive another app instance and retain bounded idle and absolute expiry', pg, async t => {
  const f = await ownerFixture(t), enrolled = await f.enroll();
  const other = f.client(1);copyCookies(enrolled.client, other);
  assert.equal((await other.request('/api/protected')).status, 200);
  const sessions = await other.request(base + '/sessions');
  assert.equal(sessions.status, 200);assert.equal(sessions.body.sessions.length, 1);
  assert.match(sessions.body.sessions[0].id, uuid);
  const stored = (await f.pools[0].query('SELECT token_hash,actor_id FROM er_dispatch_sessions')).rows[0];
  assert.match(stored.token_hash, /^[a-f0-9]{64}$/);
  assert.equal([...other.jar.values()].includes(stored.token_hash), false);
  noSecrets(sessions.body, [...other.jar.values()]);
  f.advance(30 * 60_000);
  assert.equal((await other.request('/api/protected')).status, 401);
  const fresh = await f.login(1, enrolled.seed);
  f.advance(8 * 60 * 60_000);
  assert.equal((await fresh.request('/api/protected')).status, 401);
});

test('sign out other sessions requires fresh MFA and revokes the other app while preserving the current owner', pg, async t => {
  const f = await ownerFixture(t), enrolled = await f.enroll(), first = enrolled.client;
  const other = await f.login(1);
  const before = await first.request(base + '/sessions');
  assert.equal(before.body.sessions.length, 2);
  assert.equal(before.body.sessions.filter(session => session.current).length, 1);
  const denied = await first.request(base + '/sessions/revoke-others', {});
  assert.equal(denied.status, 403);
  assert.equal((await first.request('/api/protected')).status, 200);
  assert.equal((await other.request('/api/protected')).status, 200);
  const done = await first.request(base + '/sessions/revoke-others', {password: f.owner.password, code: f.code()});
  assert.equal(done.status, 200);
  assert.equal((await other.request('/api/protected')).status, 401);
  assert.equal((await first.request('/api/protected')).status, 200);
  const event = (await first.request(base + '/audit?action=owner_sessions_revoked')).body.events;
  assert.equal(event.length, 2);
  assert.equal(event.filter(entry => entry.outcome === 'succeeded').length, 1);
  assert.equal(event.filter(entry => entry.outcome === 'denied').length, 1);
  assert.ok(event.every(entry => entry.staffId === f.owner.id));
});

test('failed fresh verification preserves valid owner sessions while concurrent revocation returns 401', pg, async t => {
  const f = await ownerFixture(t), enrolled = await f.enroll(), person = enrolled.client;
  const correct = f.code(), wrong = correct === '000000' ? '999999' : '000000';
  const passwordFailure = await person.request(base + '/recovery-codes', {password: 'Invalid synthetic owner password', code: correct});
  assert.equal(passwordFailure.status, 403);
  const codeFailure = await person.request(base + '/recovery-codes', {password: f.owner.password, code: wrong});
  assert.equal(codeFailure.status, 403);
  assert.equal((await person.request('/api/protected')).status, 200);
  assert.equal((await f.client().request(base + '/recover', {email: f.owner.email, password: f.owner.password,
    recoveryCode: 'invalid recovery code'})).status, 401);
  const original = f.stores[0].dispatchSensitiveAction;
  f.stores[0].dispatchSensitiveAction = async (...args) => {
    await f.stores[1].dispatchRevokeSession(args[0]);
    return original(...args);
  };
  const revoked = await person.request(base + '/recovery-codes', {password: f.owner.password, code: f.code()});
  f.stores[0].dispatchSensitiveAction = original;
  assert.equal(revoked.status, 401);
  assert.equal(Object.hasOwn(revoked.body, 'recoveryCodes'), false);
  assert.equal((await person.request('/api/protected')).status, 401);
});

test('logout revokes the same database session on both application instances', pg, async t => {
  const f = await ownerFixture(t), enrolled = await f.enroll(), other = f.client(1);
  copyCookies(enrolled.client, other);
  const result = await enrolled.client.request(base + '/logout', {});
  assert.equal(result.status, 200);
  assert.equal((await other.request('/api/protected')).status, 401);
  const events = (await f.stores[1].dispatchAuditPage({action: 'dispatch_logout'})).events;
  assert.equal(events.length, 1);assert.equal(events[0].staffId, f.owner.id);assert.match(events[0].actorId, uuid);
});

test('logout revokes pending enrollment and MFA challenges as well as an existing session', pg, async t => {
  const f = await ownerFixture(t), pending = f.client();
  assert.equal((await pending.request(base + '/login', {email: f.owner.email, password: f.owner.password})).status, 200);
  const start = await pending.request(base + '/enrollment/start', {});
  assert.equal(start.status, 200);
  const replay = f.client(1);copyCookies(pending, replay);
  assert.equal((await pending.request(base + '/logout', {})).status, 200);
  assert.equal((await replay.request(base + '/enrollment/start', {})).status, 401);
  assert.equal((await replay.request(base + '/enrollment/confirm', {code: f.code(start.body.secret)})).status, 401);
  assert.equal((await replay.request('/api/protected')).status, 401);

  const enrolled = await f.enroll();
  assert.equal((await enrolled.client.request(base + '/login', {email: f.owner.email, password: f.owner.password})).body.step, 'mfa');
  const authenticatedReplay = f.client(1);copyCookies(enrolled.client, authenticatedReplay);
  assert.equal((await enrolled.client.request(base + '/logout', {})).status, 200);
  assert.equal((await authenticatedReplay.request('/api/protected')).status, 401);
  assert.equal((await authenticatedReplay.request(base + '/verify', {code: f.code(enrolled.seed)})).status, 401);
  assert.equal((await f.pools[0].query('SELECT 1 FROM er_dispatch_sessions')).rowCount, 0);
  assert.equal((await f.pools[0].query('SELECT 1 FROM er_dispatch_challenges')).rowCount, 0);
});

test('logout with a retained challenge revokes an MFA session committed before its cookie response arrives', pg, async t => {
  const f = await ownerFixture(t), enrolled = await f.enroll();
  const signingIn = f.client(), signingOut = f.client(1);
  assert.equal((await signingIn.request(base + '/login', {email: f.owner.email, password: f.owner.password})).body.step, 'mfa');
  copyCookies(signingIn, signingOut);
  const original = f.stores[0].dispatchCompleteChallenge;
  let entered, release;
  const committed = new Promise(resolve => {entered = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  f.stores[0].dispatchCompleteChallenge = async (...args) => {const value = await original(...args);entered();await gate;return value;};
  const verification = signingIn.request(base + '/verify', {code: f.code(enrolled.seed)});
  await committed;
  let loggedOut;
  try {loggedOut = await signingOut.request(base + '/logout', {});}
  finally {release();f.stores[0].dispatchCompleteChallenge = original;}
  assert.equal(loggedOut.status, 200);
  const late = await verification;
  assert.equal(late.status, 200, 'A completed authentication response can arrive after logout');
  assert.equal((await signingIn.request('/api/protected')).status, 401, 'The late cookie must not resurrect a logged-out session');
  assert.equal((await signingOut.request(base + '/verify', {code: f.code(enrolled.seed)})).status, 401);
  assert.equal((await enrolled.client.request('/api/protected')).status, 200, 'An unrelated owner session remains signed in');
});

test('single-use recovery across instances revokes old sessions and requires replacement MFA before access', pg, async t => {
  const f = await ownerFixture(t), enrolled = await f.enroll(), old = await f.login(1);
  const one = f.client(), two = f.client(1);
  const input = {email: f.owner.email, password: f.owner.password, recoveryCode: enrolled.recoveryCodes[0]};
  const attempts = await Promise.all([one, two].map(client => client.request(base + '/recover', input)));
  assert.deepEqual(attempts.map(value => value.status).sort(), [200, 401]);
  const recovered = attempts[0].status === 200 ? one : two;
  assert.equal((await old.request('/api/protected')).status, 401);
  assert.equal((await enrolled.client.request('/api/protected')).status, 401);
  assert.equal((await recovered.request('/api/protected')).status, 401);
  const start = await recovered.request(base + '/enrollment/start', {});
  assert.equal(start.status, 200);assert.notEqual(start.body.secret, enrolled.seed);
  const finish = await recovered.request(base + '/enrollment/confirm', {code: f.code(start.body.secret)});
  assert.equal(finish.status, 200);assert.equal((await recovered.request('/api/protected')).status, 200);
  assert.equal((await f.client().request(base + '/recover', {...input, recoveryCode: enrolled.recoveryCodes[1]})).status, 401);
  noSecrets(f.lines, [f.owner.password, enrolled.seed, start.body.secret, ...enrolled.recoveryCodes, ...finish.body.recoveryCodes]);
});

test('recovery code rotation needs fresh authentication and never discloses codes in later account reads', pg, async t => {
  const f = await ownerFixture(t), enrolled = await f.enroll();
  const wrong = await enrolled.client.request(base + '/recovery-codes', {password: 'PRIVATE-WRONG', code: f.code()});
  assert.equal(wrong.status, 403);
  assert.equal((await enrolled.client.request('/api/protected')).status, 200);
  const renewed = await enrolled.client.request(base + '/recovery-codes', {password: f.owner.password, code: f.code()});
  assert.equal(renewed.status, 200);assert.ok(renewed.body.recoveryCodes.length >= 8);
  const hashes = (await f.pools[0].query('SELECT code_hash FROM er_dispatch_recovery_codes')).rows.map(row => row.code_hash);
  for (const value of renewed.body.recoveryCodes) assert.equal(hashes.includes(value), false);
  assert.equal((await f.client().request(base + '/recover', {email: f.owner.email, password: f.owner.password, recoveryCode: enrolled.recoveryCodes[0]})).status, 401);
  noSecrets((await enrolled.client.request(base + '/session')).body, renewed.body.recoveryCodes);
});

test('login, MFA and recovery attempt budgets are atomic and shared between instances', pg, async t => {
  const f = await ownerFixture(t), enrolled = await f.enroll();
  // Enrollment consumes the same MFA budget. Start this boundary check in a
  // fresh window rather than accidentally granting extra enrollment attempts.
  f.advance(6 * 60_000);
  const fresh = f.client();
  await fresh.request(base + '/login', {email: f.owner.email, password: f.owner.password});
  const replica = f.client(1);copyCookies(fresh, replica);
  const correct = f.code(enrolled.seed);
  const wrong = correct === '000000' ? '999999' : '000000';
  for (let index = 0; index < 8; index++) assert.equal((await (index % 2 ? replica : fresh).request(base + '/verify', {code: wrong})).status, 401);
  assert.equal((await fresh.request(base + '/verify', {code: correct})).status, 429);
  f.advance(16 * 60_000);
  for (let index = 0; index < 20; index++) assert.equal((await f.client(index % 2).request(base + '/login', {email: f.owner.email, password: 'Invalid synthetic password'})).status, 401);
  assert.equal((await f.client(1).request(base + '/login', {email: f.owner.email, password: f.owner.password})).status, 429);
  f.advance(16 * 60_000);
  for (let index = 0; index < 8; index++) assert.equal((await f.client(index % 2).request(base + '/recover', {email: f.owner.email, password: f.owner.password, recoveryCode: 'Invalid recovery code'})).status, 401);
  assert.equal((await f.client(1).request(base + '/recover', {email: f.owner.email, password: f.owner.password, recoveryCode: enrolled.recoveryCodes[0]})).status, 429);
  const identity = crypto.createHash('sha256').update('synthetic concurrent attempt identity').digest('hex');
  const concurrent = await Promise.all(Array.from({length: 24}, (_, index) =>
    f.stores[index % 2].dispatchAuthLimit('mfa_identity', identity, f.now(), 8, 5 * 60_000)));
  assert.equal(concurrent.filter(Boolean).length, 8, 'Atomic budget is shared across both database pools');
});

test('authentication metadata cleanup is bounded and preserves every live attempt budget', pg, async t => {
  const f = await ownerFixture(t);
  for (let index = 0; index < 300; index++) await f.pools[0].query(
    'INSERT INTO er_dispatch_auth_limits(scope,identity_hash,attempts,reset_at) VALUES($1,$2,1,$3)',
    ['login_identity', crypto.createHash('sha256').update('expired-' + index).digest('hex'), new Date(f.now() - 1)]);
  const live = crypto.createHash('sha256').update('live-budget').digest('hex');
  await f.pools[0].query('INSERT INTO er_dispatch_auth_limits(scope,identity_hash,attempts,reset_at) VALUES($1,$2,8,$3)',
    ['mfa_identity', live, new Date(f.now() + 5 * 60_000)]);
  const source = crypto.createHash('sha256').update('synthetic-source').digest('hex');
  assert.equal(await f.stores[0].dispatchAuthLimit('login_source', source, f.now(), 30, 15 * 60_000), true);
  assert.equal((await f.pools[0].query('SELECT count(*)::int AS count FROM er_dispatch_auth_limits WHERE reset_at<=$1', [new Date(f.now())])).rows[0].count, 50);
  assert.equal(await f.stores[1].dispatchAuthLimit('mfa_identity', live, f.now(), 8, 5 * 60_000), false);
  assert.equal((await f.pools[0].query('SELECT attempts FROM er_dispatch_auth_limits WHERE scope=$1 AND identity_hash=$2', ['mfa_identity', live])).rows[0].attempts, 9);
});

test('expired recovery enrollment cannot be replaced by password-only login or restored access', pg, async t => {
  const f = await ownerFixture(t), enrolled = await f.enroll();
  const person = f.client();
  const recovered = await person.request(base + '/recover', {email: f.owner.email, password: f.owner.password, recoveryCode: enrolled.recoveryCodes[0]});
  assert.equal(recovered.status, 200);
  const stranger = f.client(1);
  assert.equal((await stranger.request(base + '/login', {email: f.owner.email, password: f.owner.password})).status, 401);
  f.advance(6 * 60_000);
  assert.equal((await person.request(base + '/enrollment/start', {})).status, 401);
  assert.equal((await person.request('/api/protected')).status, 401);
  assert.equal((await stranger.request(base + '/login', {email: f.owner.email, password: f.owner.password})).status, 401);
});

test('database errors fail closed and do not expose storage messages or credentials', pg, async t => {
  const f = await ownerFixture(t), enrolled = await f.enroll();
  const original = f.stores[0].dispatchResolveSession;
  f.stores[0].dispatchResolveSession = async () => {throw Object.assign(new Error('PRIVATE-DATABASE-ERROR'), {status: 503});};
  try {
    const denied = await enrolled.client.request('/api/protected');
    assert.equal(denied.status, 503);assert.notEqual(denied.body.ok, true);
    noSecrets(denied.body, [f.owner.password, enrolled.seed, ...enrolled.recoveryCodes]);
  } finally {f.stores[0].dispatchResolveSession = original;}
  assert.equal((await enrolled.client.request('/api/protected')).status, 200);
});

test('authorization rechecks inside a reservation action do not commit its unfinished transaction', pg, async t => {
  const f = await ownerFixture(t);await f.enroll();
  const session = (await f.pools[0].query('SELECT token_hash FROM er_dispatch_sessions')).rows[0];
  const id = crypto.randomUUID(), createdAt = new Date(f.now()).toISOString();
  const record = {id, createdAt, status: 'confirmed', paymentStatus: 'unpaid', stripeSessionId: null,
    customer: {firstName: 'Synthetic', lastName: 'Rider', email: 'rider@example.test', phone: '2015550140'},
    trip: {date: '2026-12-01', time: '12:00', pickup: 'Synthetic pickup', dropoff: 'Synthetic destination', vehicle: 'suv', tripType: 'oneway', passengers: 1},
    quote: {total: 150, currency: 'usd', vehicle: 'Luxury SUV / Suburban', vehicleKey: 'suv'},
    dispatch: {driver: '', driverPhone: '', vehicle: '', plate: ''}};
  await f.pools[0].query('INSERT INTO er_reservations(id,record,created_at) VALUES($1,$2,$3)', [id, record, createdAt]);
  const before = (await f.pools[0].query('SELECT record,version FROM er_reservations WHERE id=$1', [id])).rows[0];
  await assert.rejects(f.stores[0].withActionLock('reservation:' + id, () => f.stores[0].update(id, async (value, client) => {
    await client.query("INSERT INTO er_storage_audit(event_type,inserted_count,skipped_count) VALUES('legacy_import',1,0)");
    assert.ok(await f.stores[0].dispatchResolveSession(session.token_hash, f.now(), false));
    value.status = 'assigned';
    throw new Error('Synthetic transaction rollback');
  })));
  assert.equal((await f.pools[0].query('SELECT 1 FROM er_storage_audit')).rowCount, 0);
  assert.deepEqual((await f.pools[0].query('SELECT record,version FROM er_reservations WHERE id=$1', [id])).rows[0], before);
});

test('owner APIs reject anonymous, customer, guest and forged session identities', pg, async t => {
  const f = await ownerFixture(t), enrolled = await f.enroll();
  const other = f.client();
  for (const cookie of ['', 'er_customer_session=' + crypto.randomBytes(32).toString('base64url'),
    'er_booking_access_' + crypto.randomUUID() + '=' + crypto.randomBytes(32).toString('base64url'),
    'er_admin_session=local-test-token']) {
    for (const path of ['/session', '/sessions', '/audit']) {
      const denied = await other.request(base + path, undefined, {headers: {cookie, 'x-staff-id': f.owner.id}});
      assert.equal(denied.status, 401);noSecrets(denied.body, [f.owner.email, f.owner.name]);
    }
  }
  assert.equal((await enrolled.client.request(base + '/audit')).status, 200);
  const before = (await f.stores[0].dispatchAuditPage({action: 'dispatch_sign_in'})).events.length;
  const cross = await enrolled.client.request(base + '/audit', undefined, {headers: {origin: 'https://cross.example.test'}});
  assert.equal(cross.status, 403);
  assert.equal((await f.stores[1].dispatchAuditPage({action: 'dispatch_sign_in'})).events.length, before,
    'A denied audit read must not be mislabeled as a sign-in attempt');
});

test('new audit entries have stable named attribution, safe outcomes, filtered cursor pages and no secret payloads', pg, async t => {
  const f = await ownerFixture(t), enrolled = await f.enroll();
  const one = await f.login(1);
  const initial = await one.request(base + '/audit?limit=1');
  assert.equal(initial.status, 200);assert.equal(initial.body.events.length, 1);
  assert.ok(initial.body.nextCursor);assert.ok(initial.body.coverageStartedAt);
  const ids = new Set();
  let page = initial.body;
  for (let count = 0; count < 8; count++) {
    for (const event of page.events) {assert.equal(ids.has(event.id), false);ids.add(event.id);}
    if (!page.nextCursor) break;
    page = (await one.request(base + '/audit?limit=1&cursor=' + encodeURIComponent(page.nextCursor))).body;
  }
  assert.ok(ids.size >= 2);
  const byOwner = await one.request(base + '/audit?staffId=' + f.owner.id + '&action=dispatch_sign_in&from=2026-11-18&to=2026-11-18');
  assert.equal(byOwner.status, 200);assert.ok(byOwner.body.events.length >= 1);
  for (const event of byOwner.body.events) {assert.equal(event.staffId, f.owner.id);assert.equal(event.staffName, f.owner.name);assert.equal(event.action, 'dispatch_sign_in');assert.equal(event.outcome, 'succeeded');}
  assert.notEqual(byOwner.body.events[0].actorId, byOwner.body.events.at(-1).actorId);
  noSecrets(initial.body, [...enrolled.recoveryCodes, enrolled.seed, f.owner.password, ...one.jar.values()]);
  for (const invalid of ['limit=101', 'limit=0', 'cursor=PRIVATE-CURSOR', 'action=PRIVATE-ACTION', 'staffId=PRIVATE-STAFF', 'from=2026-02-30', 'from=2026-12-01&to=2026-11-01']) {
    const response = await one.request(base + '/audit?' + invalid);
    assert.equal(response.status, 400);noSecrets(response.body);
  }
  assert.match(initial.headers.get('cache-control'), /no-store/);
});

test('audit records are append only and named attribution survives session revocation', pg, async t => {
  const f = await ownerFixture(t), enrolled = await f.enroll();
  const events = await enrolled.client.request(base + '/audit');
  const id = events.body.events[0].id;
  await assert.rejects(f.pools[0].query('UPDATE er_dispatch_audit_events SET outcome=$1 WHERE id=$2', ['failed', id]));
  await assert.rejects(f.pools[0].query('DELETE FROM er_dispatch_audit_events WHERE id=$1', [id]));
  await enrolled.client.request(base + '/logout', {});
  const stored = await f.stores[1].dispatchAuditPage({staffId: f.owner.id});
  assert.ok(stored.events.length >= 1);
  assert.ok(stored.events.every(event => event.staffId === f.owner.id && event.staffName === f.owner.name));
});

test('operator emergency recovery revokes every session and factor without creating public recovery authority', pg, async t => {
  const f = await ownerFixture(t), enrolled = await f.enroll(), other = await f.login(1);
  const replacement = 'Replacement synthetic owner password';
  await f.stores[1].dispatchEmergencyRecovery({email: f.owner.email, passwordHash: await hashPassword(replacement), audit: {
    timestamp: new Date(f.now()).toISOString(), referenceId: crypto.randomUUID(), action: 'owner_emergency_recovery', outcome: 'succeeded'
  }});
  assert.equal((await enrolled.client.request('/api/protected')).status, 401);
  assert.equal((await other.request('/api/protected')).status, 401);
  assert.equal((await f.pools[0].query('SELECT 1 FROM er_dispatch_recovery_codes')).rowCount, 0);
  const person = f.client();
  assert.equal((await person.request(base + '/login', {email: f.owner.email, password: f.owner.password})).status, 401);
  const login = await person.request(base + '/login', {email: f.owner.email, password: replacement});
  assert.equal(login.status, 200);assert.equal(login.body.step, 'enroll');
  assert.equal((await person.request('/api/protected')).status, 401);
  assert.equal((await f.stores[0].dispatchAuditPage({action: 'owner_emergency_recovery'})).events.length, 1);
});
