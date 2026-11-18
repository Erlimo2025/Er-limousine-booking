'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const {Pool} = require('pg');
const OTPAuth = require('otpauth');
const {createStore} = require('../../storage/postgres');
const {hashPassword} = require('../../auth/customers');
const {installDispatchOwner} = require('../../auth/dispatch-owner');
const {createDispatchSecurityLogger} = require('../../services/dispatch-security-logging');

// Every fixture gets an isolated schema in an explicitly local test database.
// Two independently installed apps use separate pools against that same schema.
async function ownerFixture(t, options = {}) {
  const database = new URL(process.env.ER_TEST_DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(database.protocol));
  assert.ok(['127.0.0.1', 'localhost'].includes(database.hostname));
  assert.match(database.pathname, /^\/er_test_[a-z0-9_]+$/);
  assert.equal(database.search + database.hash, '');
  const schema = 'dispatch_owner_' + crypto.randomBytes(10).toString('hex');
  const admin = new Pool({connectionString: database.href});
  const pools = [], stores = [], servers = [], apps = [], access = [];
  const lines = [], pending = new Set();
  let clock = Date.parse('2026-11-18T12:00:00.000Z');
  const now = () => clock;
  const key = crypto.randomBytes(32).toString('base64');
  const owner = {id: crypto.randomUUID(), name: 'Synthetic Owner', email: 'owner@example.test', password: 'Synthetic owner password for tests'};
  let seed;
  t.after(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => {server.closeAllConnections?.();server.close(resolve);})));
    await Promise.allSettled([...pending]);
    await Promise.all(stores.map(store => store.close()));
    try {await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');}
    finally {await admin.end();}
  });
  await admin.query('CREATE SCHEMA ' + schema);
  for (let index = 0; index < 2; index++) {
    const pool = new Pool({connectionString: database.href, options: '-c search_path=' + schema});
    pools.push(pool);stores.push(createStore({}, pool));
  }
  await stores[0].migrate();
  if (options.provision !== false) await stores[0].dispatchProvisionOwner({...owner, passwordHash: await hashPassword(owner.password), now: now()});

  for (let index = 0; index < 2; index++) {
    const app = express();
    let origin;
    app.use(express.json({limit: '16kb'}));
    app.use((req, res, next) => {req.referenceId = crypto.randomUUID();res.set('X-Request-ID', req.referenceId);next();});
    const route = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
    const emit = createDispatchSecurityLogger({now, write: line => {
      lines.push(line);
      const task = stores[index].dispatchAppendAudit(JSON.parse(line));
      pending.add(task);task.finally(() => pending.delete(task)).catch(() => {});
      return task;
    }});
    const auth = installDispatchOwner(app, {
      store: stores[index], route, now, secure: false, emit,
      clientKey: req => req.socket.remoteAddress,
      validOrigin: req => (!req.get('origin') || req.get('origin') === origin) &&
        (!req.get('sec-fetch-site') || ['same-origin', 'none'].includes(req.get('sec-fetch-site'))),
      env: {DISPATCH_OWNER_ENABLED: 'true', DISPATCH_MFA_KEY: key}
    });
    access.push(auth);
    const publicOwner = req => {const value = auth.current(req);return value && {id: value.id, name: value.name, email: value.email, mfaEnabled: true};};
    app.get('/api/admin/owner/config', (req, res) => res.set('Cache-Control', 'no-store').json({enabled: true, legacyLoginEnabled: false}));
    app.get('/api/protected', route(auth.requireOwner), (req, res) => res.json({ok: true, owner: publicOwner(req)}));
    app.get('/api/bookings/search', route(auth.requireOwner), (req, res) => res.json({bookings: [], nextCursor: null}));
    app.get('/api/admin/session', route(auth.requireOwner), (req, res) => res.json({authenticated: true, owner: publicOwner(req)}));
    app.use(express.static(path.join(__dirname, '../../public')));
    app.use((error, req, res, next) => {
      if (res.headersSent) return res.destroy();
      res.status(Number.isInteger(error.status) ? error.status : 500).json({error: 'Operation unavailable.', referenceId: req.referenceId});
    });
    const server = await new Promise(resolve => {const value = app.listen(0, '127.0.0.1', () => resolve(value));});
    origin = 'http://127.0.0.1:' + server.address().port;
    apps.push({app, url: origin});servers.push(server);
  }
  async function flush() {await Promise.allSettled([...pending]);}
  function client(instance = 0) {
    const jar = new Map();
    return {
      jar, instance,
      get cookie() {return [...jar].map(([name, value]) => name + '=' + value).join('; ');},
      async request(resource, body, settings = {}) {
        const method = settings.method || (body === undefined ? 'GET' : 'POST');
        const response = await fetch(apps[instance].url + resource, {
          method, headers: {origin: apps[instance].url, 'sec-fetch-site': 'same-origin',
            'content-type': 'application/json', cookie: this.cookie, ...settings.headers},
          ...(body !== undefined && {body: JSON.stringify(body)})
        });
        for (const cookie of response.headers.getSetCookie()) {
          const [name, ...value] = cookie.split(';')[0].split('=');
          if (value.join('=')) jar.set(name, value.join('='));else jar.delete(name);
        }
        const text = await response.text();
        let result;try {result = JSON.parse(text);} catch (_) {result = text;}
        await flush();
        return {status: response.status, headers: response.headers, body: result};
      }
    };
  }
  const code = (secret = seed, advance = true) => {
    if (advance) clock += 30_000;
    return new OTPAuth.TOTP({secret}).generate({timestamp: now()});
  };
  async function enroll(person = client()) {
    const login = await person.request('/api/admin/owner/login', {email: owner.email, password: owner.password});
    assert.equal(login.status, 200);assert.equal(login.body.step, 'enroll');
    const begin = await person.request('/api/admin/owner/enrollment/start', {});
    assert.equal(begin.status, 200);seed = begin.body.secret;
    const confirmation = await person.request('/api/admin/owner/enrollment/confirm', {code: code(seed)});
    assert.equal(confirmation.status, 200);
    return {client: person, seed, recoveryCodes: confirmation.body.recoveryCodes};
  }
  async function login(instance = 0, secret = seed) {
    const person = client(instance);
    const first = await person.request('/api/admin/owner/login', {email: owner.email, password: owner.password});
    assert.equal(first.status, 200);assert.equal(first.body.step, 'mfa');
    const second = await person.request('/api/admin/owner/verify', {code: code(secret)});
    assert.equal(second.status, 200);
    return person;
  }
  return {owner, pools, stores, access, apps, servers, lines, client, enroll, login, code, now, flush, key,
    url: apps[0].url, get seed() {return seed;}, advance(ms) {clock += ms;}, setTime(value) {clock = value;}};
}

module.exports = {ownerFixture};
