'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const {fork} = require('node:child_process');
const {Pool} = require('pg');
const OTPAuth = require('otpauth');
const {createStore} = require('../../storage/postgres');
const {hashPassword} = require('../../auth/customers');

function testDatabase(value) {
  const url = new URL(value);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.match(url.pathname, /^\/er_test_[a-z0-9_]+$/);
  assert.equal(url.search + url.hash, '');
  assert.ok(Number(url.port) >= 1024 && Number(url.port) <= 65535);
  return url;
}

// This helper is a child entry point only with an explicit marker. It installs
// the real server through the existing synthetic Google/Stripe/email harness;
// it never starts an application worker or contacts a live provider.
async function childMain() {
  assert.equal(process.argv[2], '--owner-process-fixture');
  assert.ok(process.send);
  const database = testDatabase(process.env.ER_OWNER_PROCESS_DATABASE_URL);
  const schema = process.env.ER_OWNER_PROCESS_SCHEMA;
  assert.match(schema, /^owner_process_[a-f0-9]{20}$/);
  const key = process.env.ER_OWNER_PROCESS_MFA_KEY;
  const start = Number(process.env.ER_OWNER_PROCESS_NOW);
  assert.ok(Number.isFinite(start));
  const pool = new Pool({connectionString: database.href, options: '-c search_path=' + schema,
    connectionTimeoutMillis: 5000, statement_timeout: 15000});
  const store = createStore({}, pool);
  const cleanups = [];
  let stopping = false, now = start;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const cleanup of cleanups.reverse()) await cleanup();
    await store.close();
    if (process.connected) process.send({type: 'stopped', pid: process.pid});
    if (process.connected) process.disconnect();
  };
  try {
    const identity = (await pool.query("SELECT current_database() AS name,host(inet_server_addr()) AS host,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser")).rows[0];
    assert.equal(identity.name, database.pathname.slice(1));
    assert.equal(identity.host, '127.0.0.1');assert.equal(identity.superuser, false);
    const probe = http.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const {harness} = require('./reservation-management.cjs');
    const fixture = await harness({after: fn => cleanups.push(fn)}, {
      PORT: String(port), SITE_URL: 'http://127.0.0.1:' + port,
      DISPATCH_OWNER_ENABLED: 'true', DISPATCH_MFA_KEY: key,
      BOOKING_EMAILS_ENABLED: 'false', CUSTOMER_EMAIL_RECOVERY_ENABLED: 'false'
    }, '[]', store, start);
    process.on('message', message => {
      if (!message || stopping) return;
      if (message.type === 'clock' && Number.isSafeInteger(message.id) &&
          Number.isFinite(message.now) && message.now >= now) {
        fixture.advance(message.now - now);now = message.now;
        process.send({type: 'clock', id: message.id});
      } else if (message.type === 'stop') {
        void stop().catch(() => {process.exitCode = 1;if (process.connected) process.disconnect();});
      }
    });
    process.once('disconnect', () => {void stop().catch(() => {process.exitCode = 1;});});
    process.send({type: 'ready', pid: process.pid, url: fixture.url});
  } catch (_) {
    if (process.connected) process.send({type: 'fixture_error'});
    await stop();process.exitCode = 1;
  }
}

async function ownerProcessFixture(t) {
  const database = testDatabase(process.env.ER_TEST_DATABASE_URL);
  const schema = 'owner_process_' + crypto.randomBytes(10).toString('hex');
  const admin = new Pool({connectionString: database.href, connectionTimeoutMillis: 5000});
  const pool = new Pool({connectionString: database.href, options: '-c search_path=' + schema,
    connectionTimeoutMillis: 5000, statement_timeout: 15000});
  const store = createStore({}, pool), children = new Set(), workers = [];
  const evidence = {startedPids: [], stoppedPids: [], restartPids: []};
  const key = crypto.randomBytes(32).toString('base64');
  const owner = {id: crypto.randomUUID(), name: 'Synthetic Process Owner', email: 'process-owner@example.test',
    password: 'Synthetic process owner password'};
  let clock = Date.parse('2026-10-01T16:00:00.000Z'), messageId = 0, seed;

  async function stop(worker) {
    if (worker.stopped) return;
    if (worker.process.exitCode === null && worker.process.signalCode === null) {
      const exited = new Promise(resolve => worker.process.once('exit', resolve));
      if (worker.process.connected) worker.process.send({type: 'stop'});
      let timer;
      await Promise.race([exited, new Promise(resolve => {timer = setTimeout(() => {
        worker.forced = true;worker.process.kill();resolve();
      }, 10000);})]);
      clearTimeout(timer);
      if (worker.process.exitCode === null && worker.process.signalCode === null) await exited;
    }
    worker.stopped = true;evidence.stoppedPids.push(worker.process.pid);
    assert.equal(worker.forced, false, 'Fixture child must stop through its explicit cleanup path');
    assert.equal(worker.process.exitCode, 0, 'Fixture child exited unsuccessfully');
    assert.equal(worker.shutdownAcknowledged, true, 'Child confirmed server and pool cleanup');
  }
  t.after(async () => {
    const results = await Promise.allSettled([...children].map(stop));
    await store.close();
    try {await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');}
    finally {await admin.end();}
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    t.diagnostic('Separate Node process evidence: ' + JSON.stringify(evidence));
  });
  await admin.query('CREATE SCHEMA ' + schema);
  await store.migrate();
  await store.dispatchProvisionOwner({...owner, passwordHash: await hashPassword(owner.password), now: clock});

  async function start() {
    const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'NODE_PATH']);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase())));
    Object.assign(env, {ER_OWNER_PROCESS_DATABASE_URL: database.href, ER_OWNER_PROCESS_SCHEMA: schema,
      ER_OWNER_PROCESS_MFA_KEY: key, ER_OWNER_PROCESS_NOW: String(clock)});
    const processChild = fork(__filename, ['--owner-process-fixture'], {
      env, execPath: process.execPath, execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    const worker = {process: processChild, url: null, stopped: false, forced: false,
      shutdownAcknowledged: false, output: '', pending: new Map()};
    children.add(worker);
    const collect = chunk => {worker.output += String(chunk);if (worker.output.length > 65536) processChild.kill();};
    processChild.stdout.on('data', collect);processChild.stderr.on('data', collect);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic app process startup timed out.')), 30000);
      processChild.once('error', () => {clearTimeout(timer);reject(new Error('Synthetic app process could not start.'));});
      processChild.once('exit', () => {
        clearTimeout(timer);
        if (!worker.url) reject(new Error('Synthetic app process exited before readiness.'));
        for (const pending of worker.pending.values()) pending.reject(new Error('Synthetic app process exited.'));
      });
      processChild.on('message', message => {
        if (message?.type === 'ready') {
          try {
            assert.equal(message.pid, processChild.pid);assert.notEqual(message.pid, process.pid);
            const url = new URL(message.url);assert.equal(url.hostname, '127.0.0.1');
            worker.url = url.origin;evidence.startedPids.push(message.pid);clearTimeout(timer);resolve();
          } catch (_) {clearTimeout(timer);reject(new Error('Synthetic app process identity was invalid.'));}
        } else if (message?.type === 'clock') {
          const pending = worker.pending.get(message.id);if (pending) {clearTimeout(pending.timer);worker.pending.delete(message.id);pending.resolve();}
        } else if (message?.type === 'stopped') worker.shutdownAcknowledged = message.pid === processChild.pid;
        else if (message?.type === 'fixture_error') {clearTimeout(timer);reject(new Error('Synthetic app process initialization failed.'));}
      });
    });
    return worker;
  }
  workers.push(await start(), await start());
  assert.notEqual(workers[0].process.pid, workers[1].process.pid);

  async function advance(ms) {
    assert.ok(Number.isSafeInteger(ms) && ms >= 0);clock += ms;
    await Promise.all(workers.filter(worker => !worker.stopped).map(worker => new Promise((resolve, reject) => {
      const id = ++messageId;
      const timer = setTimeout(() => {worker.pending.delete(id);reject(new Error('Synthetic clock update timed out.'));}, 10000);
      worker.pending.set(id, {resolve, reject, timer});worker.process.send({type: 'clock', id, now: clock});
    })));
  }
  async function restart(index) {
    const old = workers[index].process.pid;await stop(workers[index]);workers[index] = await start();
    assert.notEqual(workers[index].process.pid, old);evidence.restartPids.push({before: old, after: workers[index].process.pid});
    return workers[index];
  }
  function client(index = 0) {
    const jar = new Map();
    return {jar, get cookie() {return [...jar].map(([name, value]) => name + '=' + value).join('; ');},
      async request(resource, body, extra = {}) {
        const url = workers[index].url;
        const response = await fetch(url + resource, {method: body === undefined ? 'GET' : 'POST',
          headers: {origin: url, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', cookie: this.cookie, ...extra},
          ...(body === undefined ? {} : {body: JSON.stringify(body)})});
        for (const value of response.headers.getSetCookie()) {
          const [name, ...parts] = value.split(';')[0].split('=');
          if (parts.join('=')) jar.set(name, parts.join('='));else jar.delete(name);
        }
        const text = await response.text();let result;
        try {result = JSON.parse(text);} catch (_) {result = null;}
        return {status: response.status, body: result, headers: response.headers};
      }};
  }
  async function code(value = seed) {await advance(30000);return new OTPAuth.TOTP({secret: value}).generate({timestamp: clock});}
  async function enroll() {
    const person = client();
    assert.equal((await person.request('/api/admin/owner/login', {email: owner.email, password: owner.password})).body.step, 'enroll');
    const setup = await person.request('/api/admin/owner/enrollment/start', {});assert.equal(setup.status, 200);seed = setup.body.secret;
    const response = await person.request('/api/admin/owner/enrollment/confirm', {code: await code()});
    assert.equal(response.status, 200);return {client: person, seed, recoveryCodes: response.body.recoveryCodes};
  }
  async function login(index) {
    const person = client(index);
    assert.equal((await person.request('/api/admin/owner/login', {email: owner.email, password: owner.password})).body.step, 'mfa');
    assert.equal((await person.request('/api/admin/owner/verify', {code: await code()})).status, 200);return person;
  }
  return {workers, evidence, owner, pool, store, client, enroll, login, code, advance, restart, now: () => clock,
    get seed() {return seed;}, output: () => [...children].map(worker => worker.output).join('')};
}

if (require.main === module) {
  childMain().catch(() => {if (process.connected) {process.send({type: 'fixture_error'});process.disconnect();}process.exitCode = 1;});
}
module.exports = {ownerProcessFixture};
