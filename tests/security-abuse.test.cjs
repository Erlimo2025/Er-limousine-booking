// Isolated HTTP regression tests: mocked Google/Stripe and in-memory booking data.
// Run: node --test tests/security-abuse.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const http = require("node:http");
const crypto = require("node:crypto");
const realExpress = require("express");
const Stripe = require("stripe");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "server.js"), "utf8");
const pricing = require("../pricing");
const booking = {
  pickup: "EWR", pickupPlaceId:"ChIJ7wzsxeFSwokRhvLXxTe087M", dropoff: "Manhattan", date: "2026-11-10", time: "12:00",
  vehicle: "escalade", passengers: 6, tripType: "oneway",
  firstName: "Test", lastName: "Customer", email: "test@example.test", phone: "2015550199"
};

async function harness(t, env = {}, saved = "[]", injectedStore) {
  const production = env.NODE_ENV === "production" || env.RENDER === "true";
  if (production && env.TRUSTED_PROXY_CIDRS === undefined && env.RENDER !== "true") env = {...env, TRUSTED_PROXY_CIDRS: "loopback"};
  let app, data = saved, clock = Date.parse("2026-10-01T16:00:00Z");
  const testPricing = JSON.parse(JSON.stringify(pricing));
  const state = { creates: [], sessions: new Map(), googleCalls: 0, routes: [], timeout: false,
    googleError: false, fail: null, retrieveError: false, createDelay: 0, timeoutMs: null };
  state.logs=[];state.emailMessages=[];state.emailFail=false;
  const storageFailures = {};
  const {memoryStore} = require("./helpers/memory-storage.cjs");
  const testStore = injectedStore || memoryStore(JSON.parse(saved), undefined, storageFailures);
  const signatureSdk = new Stripe("sk_test_not_a_real_key");
  class MockStripe {
    constructor() {
      Object.assign(this,require('./helpers/stripe-payments.cjs').stripePaymentMock(state));
      this.webhooks = signatureSdk.webhooks;
      this.checkout = {sessions: {
        create: async (params, options) => {
          state.creates.push({params, options});
          if (state.createDelay) await new Promise(resolve => setTimeout(resolve, state.createDelay));
          if (state.fail) { const failure = state.fail; state.fail = null; throw failure; }
          const previous = [...state.sessions.values()].find(item => item.key === options.idempotencyKey);
          if (previous) return previous;
          const session = {id: `cs_mock_${state.sessions.size}`, url: "https://checkout.example.test/mock",
            status: "open", payment_status: "unpaid", key: options.idempotencyKey,
            mode:params.mode,amount_total:params.line_items[0].price_data.unit_amount,currency:params.line_items[0].price_data.currency,
            metadata:params.metadata,expires_at:params.expires_at,created:Math.floor(clock/1000)};
          state.sessions.set(session.id, session);
          if(state.loseResponse){state.loseResponse=false;throw new Error("mock lost response");}
          return session;
        },
        list:async params=>{
          state.listCalls=(state.listCalls||0)+1;
          if(state.listError)throw new Error("private provider detail");
          if(state.listResult)return state.listResult;
          const all=[...state.sessions.values()].filter(x=>x.created>=params.created.gte && x.created<=params.created.lte);
          const start=params.starting_after ? all.findIndex(x=>x.id===params.starting_after)+1 : 0;
          return {data:all.slice(start,start+params.limit),has_more:start+params.limit<all.length};
        },
        expire:async id=>{const session=state.sessions.get(id);if(!session || session.status!=='open')throw new Error('mock expiry unavailable');session.status='expired';return session;},
        retrieve: async id => {
          if (state.retrieveError) throw new Error("private provider detail");
          return state.sessions.get(id);
        }
      }};
    }
  }
  const express = Object.assign(() => {
    app = realExpress();
    app.listen = (port,callback) => {state.listenCalls=(state.listenCalls||0)+1;callback();};
    return app;
  }, realExpress);
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const context = {
    __dirname: root, console:{log:(...args)=>state.logs.push(args.join(' ')),error:(...args)=>state.logs.push(args.join(' '))}, URL, Buffer, Date: TestDate,
    process: {env: {GOOGLE_MAPS_API_KEY: "mock-google-key", STRIPE_SECRET_KEY: "mock",
      STRIPE_WEBHOOK_SECRET: "whsec_local_mock", ADMIN_TOKEN: "local-test-token", ...env}},
    setInterval: () => ({unref() {}}),
    AbortSignal: {timeout(ms) {
      state.timeoutMs = ms;
      const controller = new AbortController();
      if (state.timeout) setTimeout(() => controller.abort(), 1);
      return controller.signal;
    }},
    fetch: async (url, options) => {
      state.googleCalls++;
      (state.detailsRequests ||= []);
      if(url.includes("/v1/places/")) state.detailsRequests.push(decodeURIComponent(url.split("/").at(-1)));
      if(state.rejectTerminalCDetails && url.endsWith('ChIJMYEleJSwokRawcDBeH8NVg')) throw new Error('Terminal C provider rejects this identity');
      if(state.providerTimeout)throw Object.assign(new Error('synthetic-private-timeout-marker'),{name:'TimeoutError'});
      if(state.providerNetworkFailure)throw new Error("synthetic-private-network-marker");
      if (state.onGoogle) state.onGoogle();
      if (state.timeout) return new Promise((resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(new Error("mock secret detail"))));
      return {ok: !state.googleError, status:state.providerStatus===undefined?(state.googleError?404:200):state.providerStatus, json: async () => {
        if(state.providerInvalidJson)throw new SyntaxError("synthetic-private-json-marker");
        if(state.googleBody!==undefined)return state.googleBody;
        if (url.includes("computeRoutes")) {
          const route = JSON.parse(options.body);
          state.routes.push(route);
          if (state.routeResult) return {routes: [state.routeResult(route)]};
          return {routes: [{distanceMeters: 16093.44, duration: "1200s"}]};
        }
        if (url.includes("autocomplete")) return {suggestions: [{placePrediction: {placeId:"mock_place_id",text: {text: "Mock address"}}}]};
        const airport={id:booking.pickupPlaceId,displayName:{text:"Newark Liberty International Airport"},
          formattedAddress:"3 Brewster Rd, Newark, NJ",types:["airport"],primaryType:"airport",location:{latitude:40.6895,longitude:-74.1745}};
        if(url.includes("/v1/places/"))return state.detailsById?.[decodeURIComponent(url.split("/").at(-1))] || state.placeDetails || airport;
        const query=JSON.parse(options.body).textQuery;
        if(state.searchResults && Object.hasOwn(state.searchResults,query))return {places:state.searchResults[query]};
        if(state.pickupResults && query!=="Manhattan")return {places:state.pickupResults};
        return {places: [query === "Manhattan"
          ? {addressComponents: [{types: ["administrative_area_level_2"], longText: "New York County"}]}
          : airport]};
      }};
    },
    require(name) {
      if (name === "dotenv") return {config() {}};
      if (name === "express") return express;
      if (name === "stripe") return MockStripe;
      if (name === "./services/email") return {createEmailProvider:options=>{if(env.TEST_VALIDATE_EMAIL_CONFIG)require('../services/email').createEmailProvider(options);if(env.TEST_RECOVERY_CONFIG_FAILURE)throw new Error('synthetic provider configuration');return {enabled:env.CUSTOMER_EMAIL_RECOVERY_ENABLED==='true',sendResetLink:async message=>{if(state.emailFail)throw new Error('synthetic email secret marker');state.emailMessages.push({...message});}};}};
      if (name === "./storage/customer-trips") return require("../storage/customer-trips");
      if (name === "./auth/customers") return require("../auth/customers");
      if (name === "./auth/recovery") return require("../auth/recovery");
      if (name === "./routes/customer-payment-methods") return require("../routes/customer-payment-methods");
      if (name === "./pricing") return testPricing;
      if (name === "./ewr-pickups") return require("../ewr-pickups");
      if (name === "./storage/postgres") return {createStore: () => {if(injectedStore instanceof Error)throw injectedStore;return testStore;}, StorageError: require("../storage/postgres").StorageError};
      return require(name);
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  const url = `http://127.0.0.1:${server.address().port}`;
  const checkoutJar=new Map();
  return {
    state, app, context, signatureSdk, url, testStore, storageFailures,
    checkoutCookies: () => [...checkoutJar.values()].join("; "),
    get data() { return JSON.stringify(testStore.shared.records); },
    records: () => JSON.parse(JSON.stringify(testStore.shared.records)),
    advance: ms => {clock += ms;},
    async request(route, body, headers = {}, method = body === undefined ? "GET" : "POST") {
      const response = await fetch(url + route, {
        method, headers: {"content-type": "application/json", ...(route === "/api/checkout" ? {cookie:[...checkoutJar.values()].join("; ")} : {}), ...(production ? {"x-forwarded-proto": "https"} : {}), ...headers},
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
      });
      for(const cookie of response.headers.getSetCookie()) {
        const pair=cookie.split(";")[0],name=pair.split("=")[0];
        if(name.includes("er_checkout_access_"))checkoutJar.set(name,pair);
      }
      const text = await response.text();
      let result; try {result = JSON.parse(text);} catch (_) {result = text;}
      return {status: response.status, body: result, headers: response.headers};
    },
    async webhook(session, type = "checkout.session.completed", invalid = false) {
      const payload = JSON.stringify({id: "evt_mock", type, data: {object: session}});
      const signature = signatureSdk.webhooks.generateTestHeaderString({payload, secret: "whsec_local_mock"});
      return this.request("/api/stripe-webhook", invalid ? payload + " " : payload,
        {"stripe-signature": signature});
    }
  };
}

test("approved prices, promotions, suggestions and correct admin access", async t => {
  const h = await harness(t);
  for (const [body, total] of [
    [booking, 100], [{...booking, vehicle: "suv"}, 80],
    [{...booking, tripType: "hourly", hours: 3}, 450],
    [{...booking, tripType: "hourly", hours: 3, vehicle: "suv"}, 390],
    [{...booking, promoCode: "FIRST15"}, 85],
    [{...booking, vehicle: "suv", offerCode: "EWR_MANHATTAN_SUV", promoCode: "FIRST15"}, 150]
  ]) {
    const result = await h.request("/api/quote", body);
    assert.equal(result.status, 200); assert.equal(result.body.total, total);
  }
  const hourly = await h.request("/api/quote", {...booking, tripType: "hourly", hours: 3});
  assert.equal(hourly.body.hourlyRate, 150);
  assert.equal((await h.request("/api/quote", {...booking, offerCode: "EWR_MANHATTAN_SUV"})).status, 400);
  assert.deepEqual((await h.request("/api/address-suggestions?q=Newark")).body.suggestions, [{description:"Mock address",placeId:"mock_place_id"}]);
  assert.equal(h.state.timeoutMs, 8000);
  const login = await h.request("/api/admin/login", {token: "local-test-token"});
  assert.equal(login.status, 200);
  assert.equal((await h.request("/api/bookings", undefined,
    {cookie: login.headers.get("set-cookie").split(";")[0]})).status, 200);
});

test("request limits return generic 429, recover, and do not throttle webhook", async t => {
  const h = await harness(t);
  for (const [route, body, limit] of [
    ["/api/address-suggestions?q=Newark", undefined, 120],
    ["/api/quote", {...booking, tripType: "hourly", hours: 3}, 30],
    ["/api/checkout", {...booking, vehicle: "invalid"}, 15],
    ["/api/booking/not-found", undefined, 120]
  ]) {
    for (let i = 0; i < limit; i++) assert.notEqual((await h.request(route, body)).status, 429);
    const blocked = await h.request(route, body);
    assert.equal(blocked.status, 429); assert.match(blocked.body.error, /Too many requests/);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  }
  assert.equal((await h.webhook({}, "unrelated.event")).status, 200);
  h.advance(61000);
  assert.equal((await h.request("/api/quote", {...booking, tripType: "hourly", hours: 3})).status, 200);
});

test("spoofed forwarding cannot rotate direct-client limits; Render resolves trusted chain", async t => {
  const direct = await harness(t);
  const req = {socket: {remoteAddress: "203.0.113.1"}, headers: {"x-forwarded-for": "192.0.2.123"}};
  assert.equal(realExpress.request.__lookupGetter__("ip").call({...req, app: direct.app}), "203.0.113.1");
  for (let i = 0; i < 30; i++) await direct.request("/api/quote", {...booking, tripType: "hourly", hours: 3},
    {"x-forwarded-for": `192.0.2.${i}`});
  assert.equal((await direct.request("/api/quote", booking, {"x-forwarded-for": "198.51.100.3"})).status, 429);
  const render = await harness(t, {RENDER: "true"});
  const getter = realExpress.request.__lookupGetter__("ip");
  const chain = {app: render.app, socket: {remoteAddress: "10.0.0.5"},
    headers: {"x-forwarded-for": "192.0.2.99, 203.0.113.5, 173.245.48.1"}};
  assert.equal(getter.call(chain), "203.0.113.5");
  assert.equal(getter.call({...chain, socket: {remoteAddress: "198.51.100.1"}}), "198.51.100.1");
  assert.equal(vm.runInContext('clientKey({ip:"2001:db8:1:2::1"}) === clientKey({ip:"2001:db8:1:2::ffff"})', render.context), true);
});

test("Google timeout and provider errors return generic responses with no leaked detail", async t => {
  const h = await harness(t);
  h.state.timeout = true;
  for (const [route, body, status] of [["/api/address-suggestions?q=Newark", undefined, 502],
    ["/api/quote", booking, 400]]) {
    const result = await h.request(route, body);
    assert.equal(result.status, status); assert.doesNotMatch(JSON.stringify(result.body), /mock|secret|key/);
  }
  h.state.timeout = false; h.state.googleError = true;
  assert.doesNotMatch(JSON.stringify((await h.request("/api/quote", booking)).body), /mock|secret|key/);
});

test("concurrent/sequential duplicate Checkout reuses session and reservation; expiry permits retry", async t => {
  const h = await harness(t); h.state.createDelay = 20;
  const results = await Promise.all(Array.from({length: 5}, () => h.request("/api/checkout", booking)));
  assert.equal(results.filter(result=>result.status===200).length,1);
  assert.ok(results.filter(result=>result.status!==200).every(result=>result.status===503));
  assert.equal(h.state.creates.length, 1); assert.equal(h.records().length, 1);
  await h.request("/api/checkout", {...booking, total: 0, nonce: "ignored"});
  assert.equal(h.state.creates.length, 1);
  assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount, 10000);
  const oldKey = h.state.creates[0].options.idempotencyKey;
  h.state.sessions.get(h.records()[0].stripeSessionId).status = "expired";
  assert.equal((await h.request("/api/checkout", booking)).status, 200);
  assert.equal(h.records().length, 1); assert.equal(h.state.creates.length, 2);
  assert.notEqual(h.state.creates[1].options.idempotencyKey, oldKey);
  h.state.retrieveError = true;
  assert.equal((await h.request("/api/checkout", booking)).status, 503);
  assert.equal(h.state.creates.length, 2);
});

test("ambiguous Stripe failure retries same key, including restart; definitive failure can retry", async t => {
  const h = await harness(t); h.state.fail = new Error("mock network timeout");
  assert.equal((await h.request("/api/checkout", booking)).status, 503);
  const key = h.state.creates[0].options.idempotencyKey;
  assert.equal((await h.request("/api/checkout", booking)).status, 200);
  assert.equal(h.state.creates[1].options.idempotencyKey, key);
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.creates[0].params)), JSON.parse(JSON.stringify(h.state.creates[1].params)));
  assert.equal(h.records().length, 1);
  const failure = await harness(t); failure.state.fail = new Error("mock network timeout");
  await failure.request("/api/checkout", booking);
  const restarted = await harness(t, {}, failure.data);
  await restarted.request("/api/checkout", booking,{cookie:failure.checkoutCookies()});
  assert.equal(restarted.state.creates[0].options.idempotencyKey, failure.state.creates[0].options.idempotencyKey);
  assert.equal(restarted.records().length, 1);
  const rejected = await harness(t);
  rejected.state.fail = Object.assign(new Error("mock invalid request"), {type: "StripeInvalidRequestError",statusCode:400,code:"parameter_missing"});
  assert.equal((await rejected.request("/api/checkout", booking)).status, 503);
  assert.equal((await rejected.request("/api/checkout", booking)).status, 200);
  assert.equal(rejected.records().length, 1);
  assert.notEqual(rejected.state.creates[0].options.idempotencyKey, rejected.state.creates[1].options.idempotencyKey);
});

test("pending reservation spam is limited by customer and client; retries do not consume budget", async t => {
  const h = await harness(t);
  for (let i = 0; i < 6; i++) assert.equal((await h.request("/api/checkout", {...booking, notes: String(i)})).status, 200);
  assert.equal((await h.request("/api/checkout", {...booking, notes: "overflow"})).status, 429);
  assert.equal(h.records().length, 6); assert.equal(h.state.creates.length, 6);
  assert.equal((await h.request("/api/checkout", {...booking, notes: "0"})).status, 200);
  h.advance(31 * 60000);
  assert.equal((await h.request("/api/checkout", {...booking, notes: "legitimate later retry"})).status, 200);
  const different = await harness(t);
  for (let i = 0; i < 12; i++) assert.equal((await different.request("/api/checkout",
    {...booking, email: `test${i}@example.test`, phone: `201555${String(i).padStart(4, "0")}`})).status, 200);
  assert.equal((await different.request("/api/checkout", {...booking, email: "new@example.test", phone: "9999999999"})).status, 429);
  assert.equal(different.records().length, 12);
});

test("invalid admin tokens throttle without blocking the correct token; cooldown resets", async t => {
  const h = await harness(t);
  for (let i = 0; i < 10; i++) assert.equal((await h.request("/api/admin/login",
    {token: `invalid${i}`})).status, 401);
  assert.equal((await h.request("/api/admin/login", {})).status, 429);
  const login = await h.request("/api/admin/login", {token: "local-test-token"});
  assert.equal(login.status, 200);
  assert.equal((await h.request("/api/bookings", undefined,
    {cookie: login.headers.get("set-cookie").split(";")[0]})).status, 200);
  assert.equal((await h.request("/api/admin/login", {token: "invalid"})).status, 429);
  h.advance(15 * 60000 + 1);
  assert.equal((await h.request("/api/admin/login", {token: "invalid"})).status, 401);
});

test("admin sessions authorize all protected APIs and bearer credentials no longer work", async t => {
  const h = await harness(t, {}, JSON.stringify([{id: "mock-reservation", dispatch: {},
    customer: {firstName: "Test", lastName: "Customer"}, trip: {}, quote: {total: 100}}]));
  for (const headers of [{}, {cookie: "er_admin_session=invalid"},
    {cookie: `er_admin_session=${"a".repeat(43)}`}, {authorization: "Bearer local-test-token"}]) {
    const denied = await h.request("/api/bookings", undefined, headers);
    assert.equal(denied.status, 401); assert.equal(denied.body.error, "Unauthorized");
    assert.equal(denied.headers.get("cache-control"), "no-store");
    assert.equal((await h.request("/api/bookings/mock-reservation", {status: "confirmed"}, headers, "PATCH")).status, 401);
  }
  const login = await h.request("/api/admin/login", {token: "local-test-token"});
  assert.deepEqual(login.body, {authenticated: true});
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const loaded = await h.request("/api/bookings", undefined, {cookie});
  assert.equal(loaded.status, 200); assert.equal(loaded.headers.get("cache-control"), "no-store");
  assert.equal((await h.request("/api/bookings/mock-reservation", {status: "confirmed"}, {cookie}, "PATCH")).status, 200);
  assert.equal((await h.request("/api/admin/session", undefined, {cookie})).status, 200);
  assert.equal((await h.request("/api/bookings", undefined, {cookie: `${cookie}; ${cookie}`})).status, 401);
});

test("production admin cookies are secure, HttpOnly, strict, scoped and expiring", async t => {
  for (const env of [{NODE_ENV: "production"}, {RENDER: "true"}]) {
    const h = await harness(t, env);
    const login = await h.request("/api/admin/login", {token: "local-test-token"});
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie");
    assert.match(cookie, /^__Host-er_admin_session=[A-Za-z0-9_-]{43};/);
    for (const flag of [/HttpOnly/, /; Secure/, /SameSite=Strict/, /Path=\//, /Max-Age=28800/, /Expires=/])
      assert.match(cookie, flag);
    assert.doesNotMatch(cookie, /Domain=/);
    assert.deepEqual(login.body, {authenticated: true});
    assert.equal(login.headers.get("cache-control"), "no-store");
  }
});

test("admin absolute and idle expiration are enforced server-side", async t => {
  const idle = await harness(t);
  const login = await idle.request("/api/admin/login", {token: "local-test-token"});
  const cookie = login.headers.get("set-cookie").split(";")[0];
  idle.advance(29 * 60000);
  assert.equal((await idle.request("/api/bookings", undefined, {cookie})).status, 200);
  idle.advance(29 * 60000);
  assert.equal((await idle.request("/api/bookings", undefined, {cookie})).status, 200);
  idle.advance(30 * 60000);
  assert.equal((await idle.request("/api/bookings", undefined, {cookie})).status, 401);
  const absolute = await harness(t);
  const absoluteLogin = await absolute.request("/api/admin/login", {token: "local-test-token"});
  const absoluteCookie = absoluteLogin.headers.get("set-cookie").split(";")[0];
  for (let i = 0; i < 16; i++) {
    absolute.advance(29 * 60000);
    assert.equal((await absolute.request("/api/admin/session", undefined, {cookie: absoluteCookie})).status, 200);
  }
  absolute.advance(16 * 60000);
  assert.equal((await absolute.request("/api/admin/session", undefined, {cookie: absoluteCookie})).status, 401);
  const restarted = await harness(t);
  assert.equal((await restarted.request("/api/admin/session", undefined, {cookie})).status, 401);
});

test("logout revokes current session, clears cookie and rejects replay", async t => {
  const h = await harness(t);
  const login = await h.request("/api/admin/login", {token: "local-test-token"});
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const logout = await h.request("/api/admin/logout", {}, {cookie});
  assert.equal(logout.status, 200); assert.deepEqual(logout.body, {authenticated: false});
  assert.match(logout.headers.get("set-cookie"), /er_admin_session=;/);
  assert.match(logout.headers.get("set-cookie"), /Expires=Thu, 01 Jan 1970/);
  assert.equal((await h.request("/api/bookings", undefined, {cookie})).status, 401);
  assert.equal((await h.request("/api/admin/session", undefined, {cookie})).status, 401);
  const next = await h.request("/api/admin/login", {token: "local-test-token"});
  const nextCookie = next.headers.get("set-cookie").split(";")[0];
  assert.notEqual(nextCookie, cookie);
  const rotated = await h.request("/api/admin/login", {token: "local-test-token"}, {cookie: nextCookie});
  assert.equal((await h.request("/api/bookings", undefined, {cookie: nextCookie})).status, 401);
  assert.equal((await h.request("/api/bookings", undefined,
    {cookie: rotated.headers.get("set-cookie").split(";")[0]})).status, 200);
  const restarted = await harness(t);
  assert.equal((await restarted.request("/api/bookings", undefined,
    {cookie: rotated.headers.get("set-cookie").split(";")[0]})).status, 401);
});

test("cookie-authenticated admin writes reject cross-origin requests; legacy storage is cleanup-only", async t => {
  const h = await harness(t);
  assert.equal((await h.request("/api/admin/login", {token: "local-test-token"}, {origin: "https://other.example.test"})).status, 403);
  assert.equal((await h.request("/api/admin/login", {token: "local-test-token"}, {"sec-fetch-site": "same-site"})).status, 403);
  const login = await h.request("/api/admin/login", {token: "local-test-token"}, {origin: "http://localhost:3000"});
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await h.request("/api/bookings/not-found", {}, {cookie, origin: "https://other.example.test"}, "PATCH")).status, 403);
  assert.equal((await h.request("/api/admin/logout", {}, {cookie, origin: "https://other.example.test"})).status, 403);
  assert.equal((await h.request("/api/admin/session", undefined, {cookie})).status, 200);
  const javascript = fs.readFileSync(path.join(root, "public/admin.js"), "utf8");
  assert.doesNotMatch(javascript, /(?:localStorage|sessionStorage)\s*\.\s*(?:getItem|setItem)/);
  assert.doesNotMatch(javascript, /Bearer|authorization|document\.cookie/i);
  assert.match(javascript, /removeItem\("er_admin_token"\)/);
});

test("customer request limits survive changing IPs; persisted daily booking budgets work", async t => {
  const h = await harness(t, {RENDER: "true"});
  for (let i = 0; i < 30; i++) assert.equal((await h.request("/api/checkout", booking,
    {"x-forwarded-for": `203.0.113.${i + 1}`})).status, 200);
  assert.equal((await h.request("/api/checkout", booking, {"x-forwarded-for": "203.0.113.100"})).status, 429);
  assert.equal(h.state.creates.length, 1); assert.equal(h.records().length, 1);
  const daily = await harness(t);
  for (let i = 0; i < 20; i++) {
    if (i && i % 5 === 0) daily.advance(31 * 60000);
    assert.equal((await daily.request("/api/checkout", {...booking, notes: `daily-${i}`})).status, 200);
  }
  assert.equal((await daily.request("/api/checkout", {...booking, notes: "daily-overflow"})).status, 429);
  const restarted = await harness(t, {}, daily.data);
  assert.equal((await restarted.request("/api/checkout", {...booking, notes: "restart-overflow"})).status, 429);
  assert.equal(restarted.records().length, 20);
});

test("longer Checkout request window and IP daily pending-reservation budget work", async t => {
  const h = await harness(t);
  for (let batch = 0; batch < 4; batch++) {
    if (batch) h.advance(61000);
    for (let i = 0; i < 15; i++) assert.equal((await h.request("/api/checkout", {...booking, vehicle: "invalid"})).status, 400);
  }
  h.advance(61000);
  assert.equal((await h.request("/api/checkout", {...booking, vehicle: "invalid"})).status, 429);
  const daily = await harness(t);
  for (let i = 0; i < 40; i++) {
    if (i && i % 10 === 0) daily.advance(31 * 60000);
    assert.equal((await daily.request("/api/checkout", {...booking,
      email: `daily${i}@example.test`, phone: `201555${String(i).padStart(4, "0")}`})).status, 200);
  }
  assert.equal((await daily.request("/api/checkout", {...booking, email: "extra@example.test", phone: "9999999999"})).status, 429);
  assert.equal(daily.records().length, 40);
});

test("different concurrent bookings are preserved and async webhook success remains valid", async t => {
  const h = await harness(t); h.state.createDelay = 20;
  const results = await Promise.all([h.request("/api/checkout", booking),
    h.request("/api/checkout", {...booking, vehicle: "suv"})]);
  assert.ok(results.every(result => result.status === 200));
  assert.equal(h.records().length, 2);
  assert.ok(h.records().every(record => record.stripeSessionId));
  const record = h.records().find(item => item.trip.vehicle === "suv");
  const session = {id: record.stripeSessionId, metadata: {bookingId: record.id},
    amount_total: 8000, currency: "usd", mode: "payment", payment_status: "unpaid"};
  assert.equal((await h.webhook(session, "checkout.session.async_payment_failed")).status, 200);
  assert.equal(h.records().find(item => item.id === record.id).paymentStatus, "failed");
  assert.equal((await h.webhook({...session, payment_status: "paid"}, "checkout.session.async_payment_succeeded")).status, 200);
  assert.equal(h.records().find(item => item.id === record.id).paymentStatus, "paid");
});

test("Checkout pricing and webhook signature/payment security remain intact", async t => {
  const h = await harness(t);
  const result = await h.request("/api/checkout", {...booking, tripType: "hourly", hours: 3, total: 0});
  assert.equal(result.status, 200);
  assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount, 45000);
  const record = h.records()[0];
  const session = {id: record.stripeSessionId, metadata: {bookingId: record.id},
    amount_total: 45000, currency: "usd", mode: "payment", payment_status: "paid"};
  assert.equal((await h.webhook(session, undefined, true)).status, 400);
  for (const change of [{id: "wrong"}, {amount_total: 0}, {currency: "eur"}, {mode: "setup"}])
    assert.equal((await h.webhook({...session, ...change})).status, 400);
  assert.equal((await h.webhook({...session, payment_status: "unpaid"})).status, 200);
  assert.equal(h.records()[0].paymentStatus, "unpaid");
  assert.equal((await h.webhook(session)).status, 200);
  assert.equal(h.records()[0].paymentStatus, "paid");
  const saved = h.data;
  await h.webhook(session); await h.webhook({...session, payment_status: "unpaid"}, "checkout.session.async_payment_failed");
  assert.equal(h.data, saved);
  assert.equal((await h.request("/api/checkout", {...booking, tripType: "hourly", hours: 3})).status, 409);
  const special = await h.request("/api/checkout", {...booking, vehicle: "suv", offerCode: "EWR_MANHATTAN_SUV", promoCode: "FIRST15"});
  assert.equal(special.status, 200);
  assert.equal(h.state.creates.at(-1).params.line_items[0].price_data.unit_amount, 15000);
  const promo = await h.request("/api/checkout", {...booking, promoCode: "FIRST15", email: "new@example.test", phone: "5555555555"});
  assert.equal(promo.status, 200);
  assert.equal(h.state.creates.at(-1).params.line_items[0].price_data.unit_amount, 8500);
  for (const vehicle of ["constructor", "toString", "__proto__", "sedan", "", null, {}, []]) {
    assert.equal((await h.request("/api/checkout", {...booking, vehicle})).status, 400);
  }
});

test("valid trip types, return information, hourly rules and approved prices", async t => {
  const h = await harness(t);
  const cases = [
    [{...booking, vehicle: "suv"}, 80],
    [booking, 100],
    [{...booking, tripType: "airport", flightNumber: "UA 1234"}, 100],
    [{...booking, tripType: "airport", flightNumber: ""}, 100],
    [{...booking, tripType: "roundtrip", returnDate: "2026-11-10", returnTime: "14:00"}, 200],
    [{...booking, tripType: "hourly", hours: "3"}, 450],
    [{...booking, vehicle: "suv", tripType: "hourly", hours: 3}, 390],
    [{...booking, vehicle: "suv", tripType: "airport", offerCode: "EWR_MANHATTAN_SUV", promoCode: "FIRST15"}, 150],
    [{...booking, vehicle: "suv", tripType: "oneway", offerCode: "EWR_MANHATTAN_SUV"}, 150],
    [{...booking, promoCode: "FIRST15"}, 85]
  ];
  for (const [body, total] of cases) {
    const quote = await h.request("/api/quote", body);
    assert.equal(quote.status, 200); assert.equal(quote.body.total, total);
    assert.equal((await h.request("/api/checkout", {...body, total: 0})).status, 200);
    assert.equal(h.state.creates.at(-1).params.line_items[0].price_data.unit_amount, total * 100);
    h.advance(31 * 60000);
  }
  // Both directions use the same approved vehicle pricing independently.
  for (const hours of [3, 3.5, 4, 4.5, 5, 5.5, 6, 7, 8]) {
    const result = await h.request("/api/quote", {...booking, tripType: "hourly", hours});
    assert.equal(result.status, 200); assert.equal(result.body.total, hours * 150);
  }
});

test("invalid trips/customer inputs fail both quote and checkout before Google, storage or Stripe", async t => {
  const h = await harness(t);
  const cases = [
    {date: "2026-09-30"}, {date: "2026-10-01", time: "11:59"},
    {date: "2026-10-01", time: "12:00"}, {date: "2026-02-30"},
    {date: "2027-02-29"}, {date: "2026-13-01"}, {date: "2026-11-31"},
    {date: "2026-11-00"}, {date: "2026-11-1"}, {date: "11/10/2026"},
    {date: "2027-03-14", time: "02:30"}, {time: "24:00"}, {time: "12:60"},
    {time: "12:30:00"}, {time: "9:00"}, {time: "NaN"},
    ...["unknown", "Round Trip", "oneway ", "constructor", "", null, [], {}, 1, true, undefined]
      .map(tripType => ({tripType})),
    ...[0, -1, 1.5, 7, "0", "1.5", "1e0", "NaN", "Infinity", NaN, Infinity, [], {}, true, null, undefined]
      .map(passengers => ({passengers})),
    {tripType: "roundtrip"}, {tripType: "roundtrip", returnDate: "2026-11-10"},
    {tripType: "roundtrip", returnTime: "14:00"},
    {tripType: "roundtrip", returnDate: "2026-11-09", returnTime: "14:00"},
    {tripType: "roundtrip", returnDate: "2026-11-10", returnTime: "12:00"},
    {tripType: "roundtrip", returnDate: "2026-11-10", returnTime: "11:59"},
    {tripType: "roundtrip", returnDate: "2026-11-31", returnTime: "14:00"},
    {tripType: "roundtrip", returnDate: "2026-11-10", returnTime: "24:00"},
    {tripType: "roundtrip", returnDate: "2026-11-10", returnTime: "14:00", vehicle: "suv", offerCode: "EWR_MANHATTAN_SUV"},
    {tripType: "hourly", hours: 3, vehicle: "suv", offerCode: "EWR_MANHATTAN_SUV"},
    ...[0, -3, 2, 3.1, 6.5, 9, "3e0", "0x3", "NaN", "Infinity", NaN, Infinity, [], {}, true, null, undefined]
      .map(hours => ({tripType: "hourly", hours})),
    ...["", "123", "<script>", "a".repeat(81), {}, [], 123, null]
      .map(firstName => ({firstName})),
    {lastName: ""}, {lastName: "123"}, {lastName: {}},
    ...["", "invalid", "a@@example.test", "a@example..test", ".a@example.test", "a b@example.test", {}, [], 1]
      .map(email => ({email})),
    ...["", "abc", "123456", "1".repeat(18), "++12015550199", {}, [], 1]
      .map(phone => ({phone})),
    ...["", "!!", "!!!", "<script>", "a".repeat(201), {}, [], 123]
      .map(pickup => ({pickup})),
    {dropoff: ""}, {dropoff: {}}, {flightNumber: "<UA123>"},
    {flightNumber: "a".repeat(41)}, {flightNumber: {}}, {notes: {}}, {notes: "a".repeat(701)},
    {promoCode: {}}, {offerCode: []}, {firstName: "Test\u0000Name"}
  ];
  for (const change of cases) {
    const body = {...booking, ...change};
    const label = JSON.stringify(change);
    assert.equal((await h.request("/api/quote", body)).status, 400, `quote ${label}`);
    assert.equal((await h.request("/api/checkout", body)).status, 400, `checkout ${label}`);
    h.advance(61000);
  }
  assert.equal(h.state.googleCalls, 0);
  assert.equal(h.state.creates.length, 0);
  assert.equal(h.records().length, 0);
});

test("international names/phone formats are accepted and persisted input is trimmed", async t => {
  const h = await harness(t);
  const body = {...booking, firstName: "  李  ", lastName: "  O’Neill-García  ",
    email: " customer+ride@example.test ", phone: " +44 (20) 7946-0958 ext. 123 ",
    pickup: " EWR ", dropoff: " Manhattan ", flightNumber: " UA 1234 ",
    date: " 2026-11-10 ", time: " 12:00 ", passengers: "6", notes: "  Bags\nPlease meet us  "};
  assert.equal((await h.request("/api/checkout", body)).status, 200);
  const record = h.records()[0];
  assert.equal(record.customer.firstName, "李"); assert.equal(record.customer.lastName, "O’Neill-García");
  assert.equal(record.customer.email, "customer+ride@example.test");
  assert.equal(record.trip.pickup, "EWR"); assert.equal(record.trip.flightNumber, "UA 1234");
  for (const phone of ["(973) 732-7020", "+1 973 732 7020", "0044 20 7946 0958", "+81-3-1234-5678"]) {
    assert.equal((await h.request("/api/quote", {...booking, phone})).status, 200);
  }
});

test("New York timezone, valid leap dates and DST conversion are deterministic", async t => {
  const h = await harness(t);
  for (const [date, time, expected] of [
    ["2026-11-10", "12:00", "2026-11-10T17:00:00Z"],
    ["2027-07-10", "12:00", "2027-07-10T16:00:00Z"],
    ["2028-02-29", "12:00", "2028-02-29T17:00:00Z"],
    ["2026-11-01", "01:30", "2026-11-01T05:30:00Z"]
  ]) {
    h.context.testDate = date; h.context.testTime = time;
    assert.equal(vm.runInContext('parseServiceDateTime(testDate, testTime, "pickup")', h.context), Date.parse(expected));
    assert.equal((await h.request("/api/quote", {...booking, date, time})).status, 200);
  }
  const boundary = await h.request("/api/quote", {...booking, date: "2026-10-01", time: "12:01"});
  assert.equal(boundary.status, 200);
  h.advance(61000);
  assert.equal((await h.request("/api/checkout", {...booking, date: "2026-10-01", time: "12:01"})).status, 400);
  assert.equal(h.state.creates.length, 0);
});

test("unsafe calculated Checkout amounts still fail with the stronger trip validation", async t => {
  const h = await harness(t);
  for (const total of [0, -1, NaN, Infinity, -Infinity, 0.001, Number.MAX_VALUE]) {
    h.context.badAmount = total;
    vm.runInContext('calculateQuote = async body => ({vehicleKey: body.vehicle, total: badAmount, currency: "usd"})', h.context);
    assert.equal((await h.request("/api/checkout", booking)).status, 400);
  }
  assert.equal(h.state.creates.length, 0); assert.equal(h.records().length, 0);
});

test("pickup that passes during route lookup is rejected before reservation/payment creation", async t => {
  const h = await harness(t);
  h.state.onGoogle = () => h.advance(61000);
  assert.equal((await h.request("/api/checkout", {...booking, date: "2026-10-01", time: "12:01"})).status, 400);
  assert.equal(h.state.creates.length, 0); assert.equal(h.records().length, 0);
});

test("Round Trip requests both directions at selected NY times and prices unequal legs", async t => {
  const h = await harness(t);
  h.state.routeResult = route => route.origin.address === "EWR"
    ? {distanceMeters: 10 * 1609.344, duration: "1200s"}
    : {distanceMeters: 20 * 1609.344, duration: "1800s"};
  const body = {...booking, tripType: "roundtrip", returnDate: "2026-11-11", returnTime: "14:00"};
  const result = await h.request("/api/quote", body);
  assert.equal(result.status, 200);
  assert.equal(result.body.roundTrip.outbound.fare, 100);
  assert.equal(result.body.roundTrip.return.fare, 157.5);
  assert.equal(result.body.roundTrip.subtotal, 257.5);
  assert.equal(result.body.total, 257.5);
  assert.equal(result.body.miles, 30); assert.equal(result.body.minutes, 50);
  assert.deepEqual(h.state.routes.map(route => [route.origin.address, route.destination.address, route.departureTime]),
    [["EWR", "Manhattan", "2026-11-10T17:00:00.000Z"],
      ["Manhattan", "EWR", "2026-11-11T19:00:00.000Z"]]);
  assert.equal(result.body.roundTrip.outbound.vehicleKey, "escalade");
  assert.equal(result.body.roundTrip.return.vehicleKey, "escalade");
  const checkout = await h.request("/api/checkout", {...body, total: 1, outboundFare: 0, returnFare: 0});
  assert.equal(checkout.status, 200);
  assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount, 25750);
  assert.equal(h.state.routes.length, 4);
  const suv = await h.request("/api/quote", {...body, vehicle: "suv"});
  assert.equal(suv.body.roundTrip.outbound.fare, 80);
  assert.equal(suv.body.roundTrip.return.fare, 130);
  assert.equal(suv.body.total, 210);
});

test("Round Trip FIRST15 discounts combined eligible fare once and remains first-ride-only", async t => {
  const h = await harness(t);
  h.state.routeResult = route => route.origin.address === "EWR"
    ? {distanceMeters: 10 * 1609.344, duration: "1200s"}
    : {distanceMeters: 20 * 1609.344, duration: "1800s"};
  const body = {...booking, tripType: "roundtrip", returnDate: "2026-11-11", returnTime: "14:00", promoCode: "FIRST15"};
  const result = await h.request("/api/quote", body);
  assert.equal(result.body.baseTotal, 257.5);
  assert.equal(result.body.discount, 38.63);
  assert.equal(result.body.total, 218.87);
  assert.equal(result.body.roundTrip.outbound.fare, 100);
  assert.equal(result.body.roundTrip.return.fare, 157.5);
  assert.equal((await h.request("/api/checkout", body)).status, 200);
  assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount, 21887);
  const previous = await harness(t, {}, JSON.stringify([{id: "prior", paymentStatus: "paid",
    customer: {email: booking.email, phone: booking.phone}}]));
  assert.equal((await previous.request("/api/quote", body)).status, 400);
  assert.equal((await previous.request("/api/checkout", body)).status, 400);
  assert.equal(previous.state.creates.length, 0);
});

test("per-leg minimums, tolls and surcharges use each leg's own time", async t => {
  const h = await harness(t);
  vm.runInContext('pricing.airportSurcharge = 10; pricing.lateNightSurcharge = 25; pricing.tollAllowance = 5;', h.context);
  h.state.routeResult = route => route.origin.address === "EWR"
    ? {distanceMeters: 10 * 1609.344, duration: "1200s"}
    : {distanceMeters: 20 * 1609.344, duration: "1800s"};
  const result = await h.request("/api/quote", {...booking, tripType: "roundtrip",
    returnDate: "2026-11-11", returnTime: "23:30"});
  assert.equal(result.body.roundTrip.outbound.fare, 115);
  assert.equal(result.body.roundTrip.return.fare, 197.5);
  assert.equal(result.body.total, 312.5);
  h.state.routeResult = () => ({distanceMeters: 0, duration: "0s"});
  vm.runInContext('pricing.airportSurcharge = 0; pricing.lateNightSurcharge = 0; pricing.tollAllowance = 0;', h.context);
  const minimum = await h.request("/api/quote", {...booking, vehicle: "suv", tripType: "roundtrip",
    returnDate: "2026-11-11", returnTime: "14:00"});
  assert.equal(minimum.body.roundTrip.outbound.fare, 20);
  assert.equal(minimum.body.roundTrip.return.fare, 20);
  assert.equal(minimum.body.total, 40);
});

test("independent checkout checks reject corrupted Round Trip fares/promo/total before Stripe", async t => {
  const h = await harness(t);
  const body = {...booking, tripType: "roundtrip", returnDate: "2026-11-11", returnTime: "14:00", promoCode: "FIRST15"};
  const valid = (await h.request("/api/quote", body)).body;
  for (const mutate of [
    quote => {quote.roundTrip.outbound.fare = 0;},
    quote => {quote.roundTrip.return.fare = 1;},
    quote => {quote.roundTrip.return.vehicleKey = "suv";},
    quote => {quote.roundTrip.return.time = "15:00";},
    quote => {quote.roundTrip.subtotal = 1;},
    quote => {quote.baseTotal = 1;},
    quote => {quote.discount = 0;},
    quote => {quote.promotion.percentOff = 50;},
    quote => {quote.total = 1;},
    quote => {quote.fixedOffer = {price: 150};},
    quote => {delete quote.roundTrip;}
  ]) {
    const corrupt = JSON.parse(JSON.stringify(valid)); mutate(corrupt);
    h.context.corruptQuote = corrupt;
    vm.runInContext('calculateQuote = async () => corruptQuote', h.context);
    assert.equal((await h.request("/api/checkout", body)).status, 400);
  }
  assert.equal(h.state.creates.length, 0); assert.equal(h.records().length, 0);
});

test("customer reservation requires a booking-specific token; IDs, wrong or malformed tokens fail generically", async t => {
  const h = await harness(t);
  const checkout = await h.request("/api/checkout", booking);
  assert.equal(checkout.status, 200);
  assert.deepEqual(Object.keys(checkout.body).sort(), ["bookingId", "url"]);
  const cookie = checkout.headers.get("set-cookie").split(";")[0];
  const name = cookie.split("=")[0];
  const token = cookie.slice(name.length + 1);
  const record = h.records()[0];
  assert.equal(record.customerAccess.tokenHash, crypto.createHash("sha256").update(token).digest("hex"));
  assert.equal(JSON.stringify(record).includes(token), false);
  const route = `/api/booking/${record.id}`;
  const good = await h.request(route, undefined, {cookie});
  assert.equal(good.status, 200);
  assert.equal(good.body.id, record.id);
  for (const headers of [{}, {cookie: `${name}=${"a".repeat(43)}`},
    {cookie: `${name}=short`}, {cookie: `${name}=${"!".repeat(43)}`},
    {cookie: `${name}=${"a".repeat(44)}`}, {cookie: `${cookie}; ${cookie}`},
    {authorization: `Bearer ${token}`}]) {
    const result = await h.request(route, undefined, headers);
    assert.equal(result.status, 401);
    assert.equal(result.body.error, "Reservation access unavailable.");
    assert.equal(result.body.referenceId, result.headers.get("x-request-id"));
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(result.headers.get("referrer-policy"), "no-referrer");
  }
  assert.equal((await h.request(`${route}?token=${token}`)).status, 401);
  const unknown = await h.request("/api/booking/unknown", undefined, {cookie});
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error, "Reservation access unavailable.");
  assert.equal(unknown.body.referenceId, unknown.headers.get("x-request-id"));
  const other = await h.request("/api/checkout", {...booking, notes: "second reservation"});
  const otherCookie = other.headers.get("set-cookie").split(";")[0];
  const otherToken = otherCookie.slice(otherCookie.indexOf("=") + 1);
  assert.equal((await h.request(route, undefined, {cookie: otherCookie})).status, 401);
  assert.equal((await h.request(route, undefined, {cookie: `${name}=${otherToken}`})).status, 401);
});

test("customer tokens expire after final service plus 7 days, with minimum 30 days from issue", async t => {
  for (const [body, expires] of [
    [booking, "2026-11-17T17:00:00Z"],
    [{...booking, tripType: "roundtrip", returnDate: "2026-11-11", returnTime: "14:00"}, "2026-11-18T19:00:00Z"],
    [{...booking, tripType: "hourly", hours: 3}, "2026-11-17T20:00:00Z"],
    [{...booking, date: "2026-10-02"}, "2026-10-31T16:00:00Z"]
  ]) {
    const h = await harness(t);
    const result = await h.request("/api/checkout", body);
    const cookie = result.headers.get("set-cookie").split(";")[0];
    const record = h.records()[0];
    assert.equal(record.customerAccess.expiresAt, Date.parse(expires));
    const route = `/api/booking/${record.id}`;
    assert.equal((await h.request(route, undefined, {cookie})).status, 200);
    h.advance(Date.parse(expires) - Date.parse("2026-10-01T16:00:00Z") - 1);
    assert.equal((await h.request(route, undefined, {cookie})).status, 200);
    h.advance(1);
    assert.equal((await h.request(route, undefined, {cookie})).status, 401);
    assert.equal(h.records()[0].customerAccess.expiresAt, record.customerAccess.expiresAt);
  }
});

test("reservation response whitelists fields and preserves driver visibility rules", async t => {
  const h = await harness(t);
  const checkout = await h.request("/api/checkout", booking);
  const cookie = checkout.headers.get("set-cookie").split(";")[0];
  const record = h.records()[0];
  record.trip.notes = "private requests";
  record.trip.flightNumber = "UA123";
  record.dispatch = {driver: "Mock chauffeur", driverPhone: "2015550199", vehicle: "Mock SUV", plate: "TEST",
    internalNotes: "private dispatch notes"};
  const visible = ["assigned", "driver_en_route", "passenger_on_board", "completed"];
  for (const status of ["awaiting_payment", "confirmed", ...visible, "cancelled"]) {
    record.status = status;
    h.context.fixtureRecords = [record];
    h.testStore.fixtures(h.context.fixtureRecords);
    const result = await h.request(`/api/booking/${record.id}`, undefined, {cookie});
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), ["dispatch", "id", "paymentStatus", "paymentVerificationPending", "quote", "status", "trip"]);
    assert.deepEqual(Object.keys(result.body.trip).sort(), ["date", "dropoff", "pickup", "time"]);
    assert.deepEqual(Object.keys(result.body.quote).sort(), ["currency", "total", "vehicle"]);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(result.headers.get("referrer-policy"), "no-referrer");
    if (visible.includes(status)) {
      assert.deepEqual(Object.keys(result.body.dispatch).sort(), ["driver", "driverPhone", "plate", "vehicle"]);
      assert.equal(result.body.dispatch.driver, "Mock chauffeur");
    } else assert.equal(result.body.dispatch, null);
    assert.equal(JSON.stringify(result.body).includes(record.customerAccess.tokenHash), false);
    assert.equal(Object.hasOwn(result.body, "customer"), false);
    assert.equal(Object.hasOwn(result.body, "stripeSessionId"), false);
    assert.equal(Object.hasOwn(result.body, "checkoutAttempt"), false);
  }
});

test("legacy records deny access and do not get credentials through duplicate checkout", async t => {
  const h = await harness(t);
  const checkout = await h.request("/api/checkout", booking);
  const cookie = checkout.headers.get("set-cookie").split(";")[0];
  const record = h.records()[0];
  delete record.customerAccess;
  h.context.fixtureRecords = [record]; h.testStore.fixtures(h.context.fixtureRecords);
  assert.equal((await h.request(`/api/booking/${record.id}`, undefined, {cookie})).status, 401);
  const retried = await h.request("/api/checkout", booking);
  assert.equal(retried.status, 503);
  assert.equal(retried.headers.get("set-cookie"), null);
  assert.equal(Object.hasOwn(h.records()[0], "customerAccess"), false);
  for (const customerAccess of [{}, {tokenHash: "bad", expiresAt: Date.now()},
    {tokenHash: "a".repeat(64), expiresAt: "invalid"}, {tokenHash: "a".repeat(64), expiresAt: null}]) {
    h.context.fixtureRecords = [{...record, customerAccess}]; h.testStore.fixtures(h.context.fixtureRecords);
    assert.equal((await h.request(`/api/booking/${record.id}`, undefined, {cookie})).status, 401);
  }
});

test("customer access survives restart; authenticated retries preserve the original credential", async t => {
  const h=await harness(t), first=await h.request("/api/checkout",booking);
  const cookie=first.headers.getSetCookie()[0].split(";")[0];
  const route=`/api/booking/${first.body.bookingId}`;
  const restarted=await harness(t,{},h.data);
  assert.equal((await restarted.request(route,undefined,{cookie})).status,200);
  restarted.state.sessions=h.state.sessions;
  const retry=await restarted.request("/api/checkout",booking,{cookie:h.checkoutCookies()});
  assert.equal(retry.status,200);assert.equal(retry.headers.get("set-cookie"),null);
  assert.equal((await restarted.request(route,undefined,{cookie})).status,200);
  assert.equal(restarted.state.creates.length,0);
});

test("customer cookie and confirmation page prevent browser/script/referrer leakage", async t => {
  const h = await harness(t, {NODE_ENV: "production"});
  const checkout = await h.request("/api/checkout", booking);
  const cookie = checkout.headers.get("set-cookie");
  assert.match(cookie, /^__Secure-er_booking_access_/);
  for (const flag of [/HttpOnly/, /; Secure/, /SameSite=Strict/, /Max-Age=/, /Expires=/]) assert.match(cookie, flag);
  assert.ok(cookie.includes(`Path=/api/booking/${checkout.body.bookingId}`));
  assert.doesNotMatch(cookie, /Domain=/);
  assert.equal(checkout.headers.get("cache-control"), "no-store");
  assert.equal(checkout.headers.get("referrer-policy"), "no-referrer");
  const page = await h.request("/success.html?booking=mock-reference");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(page.body, /<meta name="referrer" content="no-referrer">/);
  assert.match(page.body, /credentials:\s*['"]same-origin['"],\s*cache:\s*['"]no-store['"],\s*referrerPolicy:\s*['"]no-referrer['"]/);
});


test("application-wide browser security headers and exact confirmation script hash", async t => {
  const h = await harness(t);
  for (const route of ["/api/public-config", "/api/booking/unknown", "/"]) {
    const r = await h.request(route);
    const csp = r.headers.get("content-security-policy");
    for (const directive of ["default-src 'self'", "script-src 'self'", "script-src-attr 'none'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"]) assert.ok(csp.includes(directive));
    assert.ok(!csp.includes("unsafe-eval"));
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.equal(r.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    assert.equal(r.headers.get("x-powered-by"), null);
    assert.equal(r.headers.get("strict-transport-security"), null);
    const script = fs.readFileSync(path.join(root,"public/success.html"),"utf8").match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\r\n/g,"\n");
    assert.ok(csp.includes("'sha256-" + crypto.createHash("sha256").update(script).digest("base64") + "'"));
  }
});

test("production HTTPS uses only trusted proxy protocol and canonical redirects", async t => {
  for (const env of [{NODE_ENV:"production", TRUSTED_PROXY_CIDRS:"loopback"}, {RENDER:"true"}]) {
    const h=await harness(t,{...env,SITE_URL:"https://limousine.example.test"});
    const secure=await h.request("/api/quote",booking);
    assert.equal(secure.status,200);
    assert.equal(secure.headers.get("strict-transport-security"),"max-age=31536000");
    const response=await fetch(h.url+"/api/quote?test=1",{redirect:"manual",headers:{"x-forwarded-proto":"http",host:"attacker.example.test","x-forwarded-host":"attacker.example.test"}});
    assert.equal(response.status,308);
    assert.equal(response.headers.get("location"),"https://limousine.example.test/api/quote?test=1");
    assert.equal(response.headers.get("strict-transport-security"),null);
  }
  const untrusted=await harness(t,{NODE_ENV:"production",TRUSTED_PROXY_CIDRS:"192.0.2.0/24",SITE_URL:"https://limousine.example.test"});
  const spoof=await fetch(untrusted.url+"/",{redirect:"manual",headers:{"x-forwarded-proto":"https"}});
  assert.equal(spoof.status,308);
  const missing=await harness(t,{NODE_ENV:"production"});
  const unavailable=await fetch(missing.url+"/",{redirect:"manual"});
  assert.equal(unavailable.status,503);
  const dev=await harness(t);
  assert.equal((await dev.request("/api/quote",booking,{"x-forwarded-proto":"https"})).status,200);
});


test("storage failures are generic 503 and never interpreted as first-ride eligibility", async t => {
  for(const failure of ['read','write']) {
    const h=await harness(t);h.storageFailures[failure]=true;
    if(failure==='read') {
      assert.equal((await h.request('/api/quote',{...booking,promoCode:'FIRST15'})).status,503);
      assert.equal((await h.request('/api/booking/unknown')).status,503);
      const login=await h.request('/api/admin/login',{token:'local-test-token'});
      assert.equal((await h.request('/api/bookings',undefined,{cookie:login.headers.get('set-cookie').split(';')[0]})).status,503);
    }
    const checkout=await h.request('/api/checkout',booking);
    assert.equal(checkout.status,503);assert.equal(h.state.creates.length,0);
    assert.match(checkout.body.error,/temporarily unavailable/);
    assert.equal(h.records().length,0);
  }
});


const referenceUuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const leakMarker='SYNTHETIC_PRIVATE_SECRET_PII_PATH_STACK';
function verifySafeFailure(h,response) {
  assert.ok(response.status>=400);
  assert.match(response.body.referenceId,referenceUuid);
  assert.equal(response.body.referenceId,response.headers.get('x-request-id'));
  assert.doesNotMatch(JSON.stringify(response.body),new RegExp(leakMarker+'|STRIPE_SECRET_KEY|DATABASE_URL|ADMIN_TOKEN|No signatures|Unexpected token|SyntaxError|TypeError|\\n.*at '));
  const log=h.state.logs.map(line=>{try{return JSON.parse(line);}catch(_){return null;}}).find(item=>item?.referenceId===response.body.referenceId);
  assert.ok(log);assert.equal(log.status,response.status);
  assert.ok(Object.keys(log).every(key=>['timestamp','referenceId','operation','category','status','provider'].includes(key)));
  assert.doesNotMatch(h.state.logs.join('\n'),new RegExp(leakMarker+'|STRIPE_SECRET_KEY|DATABASE_URL|ADMIN_TOKEN|mock-google-key|whsec_local_mock|local-test-token|test@example.test|2015550199|checkout.example.test|\\bat \\w+'));
  return log;
}

test('Finding 11: unexpected quote/Checkout errors and forged statuses never expose exception details',async t=>{
  for(const route of ['/api/quote','/api/checkout'])for(const status of [undefined,400,503]) {
    const h=await harness(t);h.context.privateMarker=leakMarker;h.context.forgedStatus=status;
    vm.runInContext('calculateQuote=async()=>{throw Object.assign(new Error(privateMarker),{status:forgedStatus});}',h.context);
    const response=await h.request(route,booking,{'x-request-id':leakMarker});
    const log=verifySafeFailure(h,response);assert.equal(log.category,'unexpected_error');
    assert.notEqual(response.body.referenceId,leakMarker);assert.match(response.body.error,/Reference:/);
    assert.equal(h.state.creates.length,0);
  }
});

test('Finding 11: malformed JSON and oversized bodies never echo parser/request details',async t=>{
  const h=await harness(t);
  for(const body of ['{"'+leakMarker+'":BAD_JSON}',JSON.stringify({notes:leakMarker+'x'.repeat(60000)})]) {
    const response=await h.request('/api/quote',body);
    assert.ok([400,413].includes(response.status));verifySafeFailure(h,response);
    assert.match(response.body.error,/Invalid request/);
  }
});

test('Finding 11: invalid/missing webhook signatures and missing configuration are generic',async t=>{
  const h=await harness(t);
  verifySafeFailure(h,await h.webhook({marker:leakMarker},undefined,true));
  verifySafeFailure(h,await h.request('/api/stripe-webhook',{marker:leakMarker}));
  const missing=await harness(t,{STRIPE_WEBHOOK_SECRET:''});
  const rejected=await missing.request('/api/stripe-webhook',{});assert.equal(rejected.status,503);verifySafeFailure(missing,rejected);
  const noStripe=await harness(t,{STRIPE_SECRET_KEY:''});
  const checkout=await noStripe.request('/api/checkout',booking);assert.equal(checkout.status,503);
  assert.equal(verifySafeFailure(noStripe,checkout).category,'configuration_unavailable');
});

test('Finding 11: Google errors/malformed responses and Stripe failures remain safe and correlated',async t=>{
  for(const path of ['/api/address-suggestions?q=mock','/api/quote']) {
    const h=await harness(t);h.state.onGoogle=()=>{throw new Error(leakMarker);};
    verifySafeFailure(h,await h.request(path,path.startsWith('/api/quote')?booking:undefined));
    h.state.onGoogle=null;h.state.googleBody=null;
    verifySafeFailure(h,await h.request(path,path.startsWith('/api/quote')?booking:undefined));
  }
  const h=await harness(t);h.state.fail=new Error(leakMarker);
  assert.equal(verifySafeFailure(h,await h.request('/api/checkout',booking)).provider,'stripe');
});

test('Finding 11: pricing/configuration invariants are hidden but trusted booking messages remain useful',async t=>{
  for(const expression of ['pricing.vehicleRates.escalade=null','pricing.promotions.FIRST15.percentOff=0']) {
    const h=await harness(t);vm.runInContext(expression,h.context);
    const response=await h.request('/api/quote',{...booking,promoCode:'FIRST15'});verifySafeFailure(h,response);
    assert.doesNotMatch(response.body.error,/configured|Calculated|Round Trip|pricing/i);
  }
  const invariant=await harness(t);
  const body={...booking,tripType:'roundtrip',returnDate:'2026-11-11',returnTime:'14:00'};
  invariant.context.corruptedQuote=(await invariant.request('/api/quote',body)).body;
  vm.runInContext('corruptedQuote.roundTrip.subtotal=1;calculateQuote=async()=>corruptedQuote;',invariant.context);
  const rejected=await invariant.request('/api/checkout',body);verifySafeFailure(invariant,rejected);
  assert.doesNotMatch(rejected.body.error,/Round Trip|subtotal|invariant/);
  const h=await harness(t);
  for(const [body,pattern] of [[{...booking,tripType:'invalid'},/valid trip type/],[{...booking,passengers:7},/between 1 and 6/],
    [{...booking,vehicle:'suv',offerCode:'EWR_MANHATTAN_SUV',tripType:'roundtrip'},/returnDate/]]) {
    const response=await h.request('/api/quote',body);verifySafeFailure(h,response);assert.match(response.body.error,pattern);
  }
});

test('Finding 11: storage errors and reference IDs cannot bypass reservation or admin authentication',async t=>{
  const h=await harness(t);h.storageFailures.read=true;
  const failed=await h.request('/api/quote',{...booking,promoCode:'FIRST15'});
  assert.equal(failed.status,503);assert.equal(verifySafeFailure(h,failed).provider,'postgresql');
  h.storageFailures.read=false;
  const result=await h.request('/api/checkout',booking);
  const referenceId=result.headers.get('x-request-id');assert.match(referenceId,referenceUuid);
  const denied=await h.request('/api/booking/'+result.body.bookingId,undefined,{'x-request-id':referenceId,authorization:'Bearer '+referenceId});
  assert.equal(denied.status,401);verifySafeFailure(h,denied);
  assert.notEqual(denied.body.referenceId,referenceId);
  assert.equal((await h.request('/api/bookings',undefined,{authorization:'Bearer '+referenceId})).status,401);
});

test('Finding 11: headers-sent errors destroy the response without forwarding raw exceptions',async t=>{
  const h=await harness(t),handler=h.app._router.stack.at(-1).handle;
  let destroyed=false,nextCalled=false;
  const req={referenceId:crypto.randomUUID(),route:{path:'/api/quote'}};
  const res={headersSent:true,destroy:()=>{destroyed=true;},status:()=>{throw new Error('second response');}};
  handler(Object.assign(new Error(leakMarker),{status:400}),req,res,()=>{nextCalled=true;});
  assert.equal(destroyed,true);assert.equal(nextCalled,false);
  const log=JSON.parse(h.state.logs.at(-1));assert.equal(log.referenceId,req.referenceId);assert.equal(log.category,'response_interrupted');
  assert.doesNotMatch(h.state.logs.join('\n'),new RegExp(leakMarker));
  assert.equal((await h.request('/api/quote',booking)).status,200);
});

test('Finding 11: startup logging is fixed and storage startup failures fail closed without raw stacks',async t=>{
  const h=await harness(t,{SITE_URL:'https://'+leakMarker+'@synthetic.example.test'});
  assert.equal(h.state.listenCalls,1);assert.ok(h.state.logs.includes('ER Limousine Service started.'));
  assert.doesNotMatch(h.state.logs.join('\n'),new RegExp(leakMarker));
  const missing=await harness(t,{},'[]',new Error(leakMarker));
  assert.equal(missing.context.process.exitCode,1);assert.equal(missing.state.listenCalls,undefined);
  assert.doesNotMatch(missing.state.logs.join('\n'),new RegExp(leakMarker+'|\\n.*at '));
  const failedStore={migrate:async()=>{throw new Error(leakMarker);},close:async()=>{}};
  const unavailable=await harness(t,{},'[]',failedStore);
  assert.equal(unavailable.context.process.exitCode,1);assert.equal(unavailable.state.listenCalls,undefined);
  assert.doesNotMatch(unavailable.state.logs.join('\n'),new RegExp(leakMarker+'|\\n.*at '));
});

test('Finding 11: PostgreSQL errors with forged HTTP status stay private at the API boundary',async t=>{
  const {createStore}=require('../storage/postgres');
  const client={query:async()=>({rows:[],rowCount:0}),release:()=>{}};
  const storage=createStore({}, {connect:async()=>client,query:async()=>{throw Object.assign(new Error(leakMarker),{status:400});}});
  const h=await harness(t,{},'[]',storage);
  verifySafeFailure(h,await h.request('/api/quote',booking));
  verifySafeFailure(h,await h.request('/api/booking/11111111-1111-4111-8111-111111111111'));
});


test("New audit 1: exact-data replay without ownership cannot disclose or replace access",async t=>{
  const h=await harness(t),first=await h.request('/api/checkout',booking);
  const id=first.body.bookingId,cookie=first.headers.getSetCookie()[0].split(';')[0];
  const before=h.records()[0],name=h.checkoutCookies().split('=')[0];
  for(const supplied of ['',`${name}=${'A'.repeat(43)}`,`${name}=malformed`,
    `${h.checkoutCookies()}; ${h.checkoutCookies()}`]) {
    const result=await h.request('/api/checkout',{...booking,bookingId:id},{cookie:supplied,'x-request-id':'attacker-id'});
    assert.equal(result.status,503);assert.equal(result.headers.get('set-cookie'),null);
    assert.deepEqual(Object.keys(result.body).sort(),['error','referenceId']);
    assert.match(result.body.referenceId,/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
    assert.equal(result.headers.get('x-request-id'),result.body.referenceId);
    assert.doesNotMatch(JSON.stringify(result.body),new RegExp(id+'|cs_mock|checkout.example|pending|paid'));
    assert.deepEqual(h.records()[0],before);
    assert.equal((await h.request('/api/booking/'+id,undefined,{cookie})).status,200);
  }
  assert.equal((await h.request('/api/booking/'+id)).status,401);
  assert.equal((await h.request('/api/booking/'+id+'?email='+booking.email+'&phone='+booking.phone)).status,401);
  assert.equal(h.state.creates.length,1);
});

test("New audit 1: authenticated retry keeps cookies, hash, expiration and Stripe session",async t=>{
  const h=await harness(t,{NODE_ENV:'production'}),first=await h.request('/api/checkout',booking);
  const cookies=first.headers.getSetCookie(),before=h.records()[0];
  assert.equal(cookies.length,2);
  for(const cookie of cookies) {
    for(const flag of [/HttpOnly/,/; Secure/,/SameSite=Strict/,/Max-Age=/,/Expires=/])assert.match(cookie,flag);
    assert.doesNotMatch(cookie,/Domain=/);
  }
  assert.ok(cookies[0].includes(`Path=/api/booking/${first.body.bookingId}`));
  assert.ok(cookies[1].includes('Path=/api/checkout;'));
  for(const credential of [h.checkoutCookies(),cookies[0].split(';')[0]]) {
    const retry=await h.request('/api/checkout',booking,{cookie:credential});
    assert.equal(retry.status,200);assert.deepEqual(retry.body,first.body);
    assert.equal(retry.headers.get('set-cookie'),null);assert.deepEqual(h.records()[0],before);
  }
  assert.equal(h.state.creates.length,1);
});

test("New audit 1: concurrent anonymous creation never shares a customer credential",async t=>{
  const h=await harness(t);h.state.createDelay=30;
  const results=await Promise.all(Array.from({length:4},()=>h.request('/api/checkout',booking,{cookie:''})));
  assert.equal(results.filter(r=>r.status===200).length,1);
  for(const denied of results.filter(r=>r.status!==200)) {
    assert.equal(denied.status,503);assert.equal(denied.headers.get('set-cookie'),null);
    assert.deepEqual(Object.keys(denied.body).sort(),['error','referenceId']);
  }
  assert.equal(h.state.creates.length,1);assert.equal(h.records().length,1);
});

test("New audit 1: concurrent owner retry and anonymous replay cannot transfer access",async t=>{
  const h=await harness(t),first=await h.request('/api/checkout',booking);
  const cookie=first.headers.getSetCookie()[0].split(';')[0],before=h.records()[0].customerAccess;
  const [owner,attacker]=await Promise.all([
    h.request('/api/checkout',booking),h.request('/api/checkout',booking,{cookie:''})
  ]);
  assert.ok([200,503].includes(owner.status));assert.equal(attacker.status,503);
  assert.equal(attacker.headers.get('set-cookie'),null);
  assert.deepEqual(h.records()[0].customerAccess,before);
  assert.equal((await h.request('/api/booking/'+first.body.bookingId,undefined,{cookie})).status,200);
  assert.equal((await h.request('/api/checkout',booking)).status,200);
  assert.equal(h.state.creates.length,1);
});

test("New audit 1: ambiguous failure grants only the initiating browser safe retry",async t=>{
  const h=await harness(t);h.state.fail=new Error('synthetic provider failure');
  const failed=await h.request('/api/checkout',booking);
  assert.equal(failed.status,503);assert.equal(failed.headers.getSetCookie().length,2);
  const before=h.records()[0],key=h.state.creates[0].options.idempotencyKey;
  const attacker=await h.request('/api/checkout',booking,{cookie:''});
  assert.equal(attacker.status,503);assert.equal(attacker.headers.get('set-cookie'),null);
  assert.deepEqual(h.records()[0],before);assert.equal(h.state.creates.length,1);
  const retry=await h.request('/api/checkout',booking);
  assert.equal(retry.status,200);assert.equal(retry.headers.get('set-cookie'),null);
  assert.equal(h.state.creates[1].options.idempotencyKey,key);
  assert.deepEqual(h.records()[0].customerAccess,before.customerAccess);
});

test("New audit 1: expired and other-booking credentials cannot authorize Checkout",async t=>{
  const h=await harness(t),first=await h.request('/api/checkout',booking);
  const original=h.checkoutCookies(),other=await h.request('/api/checkout',{...booking,time:'13:00'});
  const otherCookie=h.checkoutCookies().split('; ').find(c=>c.includes(other.body.bookingId));
  const replay=await h.request('/api/checkout',booking,{cookie:otherCookie});
  assert.equal(replay.status,503);assert.equal(replay.headers.get('set-cookie'),null);
  await h.testStore.update(first.body.bookingId,r=>{r.customerAccess.expiresAt=Date.parse('2026-10-01T15:59:59Z');});
  const before=h.records().find(r=>r.id===first.body.bookingId);
  const expired=await h.request('/api/checkout',booking,{cookie:original});
  assert.equal(expired.status,503);assert.equal(expired.headers.get('set-cookie'),null);
  assert.deepEqual(h.records().find(r=>r.id===first.body.bookingId),before);
  assert.equal(h.state.creates.length,2);
});

test("New audit 1: tokens stay out of JSON, URLs, logs, Stripe data and frontend stores",async t=>{
  const h=await harness(t),first=await h.request('/api/checkout',booking);
  const tokens=first.headers.getSetCookie().map(c=>c.split(';')[0].split('=')[1]);
  const retry=await h.request('/api/checkout',booking);
  const denied=await h.request('/api/checkout',booking,{cookie:''});
  const customer=await h.request('/api/booking/'+first.body.bookingId,undefined,{cookie:first.headers.getSetCookie()[0].split(';')[0]});
  const output=JSON.stringify([first.body,retry.body,denied.body,customer.body,h.state.logs,h.state.creates,h.records()]);
  for(const token of tokens)assert.equal(output.includes(token),false);
  for(const file of ['public/app.js','public/success.html']) {
    const source=fs.readFileSync(path.join(root,file),'utf8');
    assert.doesNotMatch(source,/(?:localStorage|sessionStorage)|er_checkout_access_|er_booking_access_/);
  }
});


async function unresolvedFirstRide(t, lost=false) {
  const h=await harness(t),body={...booking,promoCode:'FIRST15'};
  if(lost)h.state.loseResponse=true;else h.state.fail=new Error('synthetic ambiguous failure');
  assert.equal((await h.request('/api/checkout',body)).status,503);
  return {h,body,record:h.records()[0]};
}

test('New audit 2: unknown submission remains durable; empty scan after pickup requires review',async t=>{
  const {h,body,record}=await unresolvedFirstRide(t);
  assert.equal(record.checkoutAttempt.state,'submitted_unknown');assert.equal(record.stripeSessionId,null);
  assert.equal(record.checkoutAttempt.submissionCount,1);
  h.advance(42*24*60*60000);
  const before=h.state.creates.length;
  await h.context.runFirstRideReconciliation();
  assert.equal(h.state.creates.length,before);
  const saved=h.records()[0];assert.equal(saved.checkoutAttempt.state,'review_required');
  assert.equal(saved.checkoutAttempt.evidence,'no_conclusive_evidence');assert.equal(h.testStore.shared.claims.size,2);
  assert.equal((await h.request('/api/checkout',body)).status,400);
  assert.equal((await h.request('/api/checkout',{...body,date:'2026-12-20'})).status,409);
  const restarted=await harness(t,{},h.data);
  assert.equal(restarted.records().find(r=>r.id===record.id).checkoutAttempt.state,'review_required');
});

test('New audit 2: lost-response session is recovered after pickup and only expired/unpaid releases',async t=>{
  const {h,body,record}=await unresolvedFirstRide(t,true),session=[...h.state.sessions.values()][0];
  h.advance(42*24*60*60000);
  session.status='expired';const before=h.state.creates.length;
  await h.context.reconcileFirstRide(record.id);
  const saved=h.records()[0];assert.equal(saved.stripeSessionId,session.id);
  assert.equal(saved.checkoutAttempt.state,'confirmed_unpaid');assert.equal(h.testStore.shared.claims.size,0);
  assert.equal(saved.trip.date,record.trip.date);assert.equal(saved.checkoutAttempt.expiresAt,record.checkoutAttempt.expiresAt);
  assert.equal(h.state.creates.length,before);
  const future=await h.request('/api/checkout',{...body,date:'2026-12-20'});
  assert.equal(future.status,200);assert.equal(h.records().find(r=>r.id===future.body.bookingId).quote.total,85);
});

test('New audit 2: saved open/processing sessions retain claims; paid state establishes permanent ineligibility',async t=>{
  for(const status of ['open','complete','paid']) {
    const h=await harness(t),body={...booking,promoCode:'FIRST15'},first=await h.request('/api/checkout',body);
    const record=h.records()[0],session=h.state.sessions.get(record.stripeSessionId);
    session.status=status==='paid'?'complete':status;session.payment_status=status==='paid'?'paid':'unpaid';
    await h.context.reconcileFirstRide(first.body.bookingId);
    const saved=h.records()[0];
    if(status==='paid') {
      assert.equal(saved.paymentStatus,'unpaid');assert.equal(saved.checkoutAttempt.evidence,'verified_paid_awaiting_webhook');
      assert.equal((await h.webhook(session)).status,200);
      assert.equal(h.testStore.shared.claims.size,0);
      assert.equal((await h.request('/api/quote',{...body,time:'13:00'})).status,400);
    }else {assert.equal(saved.checkoutAttempt.state,'session_identified');assert.equal(h.testStore.shared.claims.size,2);}
    assert.equal(h.state.creates.length,1);
  }
});

test('New audit 2: saved expired/unpaid session releases only after verification',async t=>{
  const h=await harness(t),body={...booking,promoCode:'FIRST15'};await h.request('/api/checkout',body);
  const record=h.records()[0];h.state.sessions.get(record.stripeSessionId).status='expired';
  await h.context.reconcileFirstRide(record.id);
  assert.equal(h.records()[0].checkoutAttempt.state,'confirmed_unpaid');assert.equal(h.testStore.shared.claims.size,0);
  assert.equal((await h.request('/api/checkout',{...body,time:'13:00'})).status,200);
});

test('New audit 2: failed retrieval or listing retains claims and sanitized review evidence',async t=>{
  for(const lost of [false,true]) {
    const {h,record}=await unresolvedFirstRide(t,lost);
    if(lost)h.state.retrieveError=true;else h.state.listError=true;
    await h.context.reconcileFirstRide(record.id);
    assert.equal(h.records()[0].checkoutAttempt.state,'review_required');
    assert.equal(h.records()[0].checkoutAttempt.evidence,'provider_unavailable');assert.equal(h.testStore.shared.claims.size,2);
    assert.doesNotMatch(JSON.stringify([h.records(),h.state.logs]),/private provider detail/);
  }
  const h=await harness(t);await h.request('/api/checkout',{...booking,promoCode:'FIRST15'});
  h.state.retrieveError=true;await h.context.reconcileFirstRide(h.records()[0].id);assert.equal(h.testStore.shared.claims.size,2);
});

test('New audit 2: multiple, mismatched and incomplete scan results never release or attach',async t=>{
  for(const kind of ['multiple','amount','currency','mode','expiry','incomplete','contact_only']) {
    const {h,record}=await unresolvedFirstRide(t,true),original=[...h.state.sessions.values()][0];
    let data=[original],has_more=false;
    if(kind==='multiple')data.push({...original,id:'cs_mock_extra'});
    if(kind==='amount')data=[{...original,amount_total:1}];
    if(kind==='currency')data=[{...original,currency:'eur'}];
    if(kind==='mode')data=[{...original,mode:'setup'}];
    if(kind==='expiry')data=[{...original,expires_at:original.expires_at+1}];
    if(kind==='incomplete')has_more=true;
    if(kind==='contact_only')data=[{...original,metadata:{bookingId:record.id,attemptReference:'different'}}];
    h.state.listResult={data,has_more};await h.context.reconcileFirstRide(record.id);
    const saved=h.records()[0];assert.equal(saved.stripeSessionId,null);assert.equal(saved.checkoutAttempt.state,'review_required');
    assert.equal(h.testStore.shared.claims.size,2);assert.equal(h.state.creates.length,1);
  }
});

test('New audit 2: pagination positively recovers a session and validates its retrieved state',async t=>{
  const {h,record}=await unresolvedFirstRide(t,true),original=[...h.state.sessions.values()][0];
  h.state.sessions.clear();for(let i=0;i<101;i++)h.state.sessions.set('cs_unrelated_'+i,{...original,id:'cs_unrelated_'+i,metadata:{}});
  h.state.sessions.set(original.id,original);
  await h.context.reconcileFirstRide(record.id);
  assert.ok(h.state.listCalls>=2);assert.equal(h.records()[0].stripeSessionId,original.id);
  assert.equal(h.records()[0].checkoutAttempt.state,'session_identified');assert.equal(h.testStore.shared.claims.size,2);
});

test('New audit 2: later parameter failure cannot erase an ambiguous submission',async t=>{
  const {h,body,record}=await unresolvedFirstRide(t);
  h.state.fail=Object.assign(new Error('synthetic validation failure'),{type:'StripeInvalidRequestError',statusCode:400,code:'parameter_missing'});
  assert.equal((await h.request('/api/checkout',body)).status,503);
  assert.equal(h.records()[0].checkoutAttempt.key,record.checkoutAttempt.key);
  assert.equal(h.records()[0].checkoutAttempt.state,'submitted_unknown');assert.equal(h.testStore.shared.claims.size,2);
  assert.equal(h.state.creates[0].options.idempotencyKey,h.state.creates[1].options.idempotencyKey);
});

test('New audit 2: aged/legacy attempts cannot recreate sessions using expired idempotency keys',async t=>{
  const {h,body,record}=await unresolvedFirstRide(t);h.advance(25*60*60000);
  assert.equal((await h.request('/api/checkout',body)).status,503);assert.equal(h.state.creates.length,1);
  assert.equal(h.records()[0].checkoutAttempt.state,'review_required');assert.equal(h.testStore.shared.claims.size,2);
  const old=h.records()[0];delete old.checkoutAttempt.version;delete old.checkoutAttempt.correlationId;
  h.testStore.fixtures([old]);await h.context.reconcileFirstRide(record.id);
  assert.equal(h.records()[0].checkoutAttempt.evidence,'legacy_without_correlation');assert.equal(h.testStore.shared.claims.size,2);
});

test('New audit 2: a provably unsubmitted prepared attempt can release safely',async t=>{
  const {h,record}=await unresolvedFirstRide(t);
  await h.testStore.update(record.id,r=>{r.checkoutAttempt.state='prepared';r.checkoutAttempt.firstSubmittedAt=null;r.checkoutAttempt.submissionCount=0;});
  const before=h.state.creates.length;await h.context.reconcileFirstRide(record.id);
  assert.equal(h.records()[0].checkoutAttempt.state,'confirmed_unpaid');assert.equal(h.records()[0].checkoutAttempt.evidence,'not_submitted');
  assert.equal(h.testStore.shared.claims.size,0);assert.equal(h.state.creates.length,before);
});

test('New audit 2: customer data/cookies cannot invoke admin recovery; admin sees review and can recheck',async t=>{
  const {h,body,record}=await unresolvedFirstRide(t),route='/api/bookings/'+record.id+'/reconcile';
  for(const headers of [{},{cookie:h.checkoutCookies()}])assert.equal((await h.request(route,body,headers)).status,401);
  const before=h.state.creates.length;
  const login=await h.request('/api/admin/login',{token:'local-test-token'}),cookie=login.headers.getSetCookie()[0].split(';')[0];
  const result=await h.request(route,{}, {cookie});assert.equal(result.status,200);assert.deepEqual(result.body,{ok:true});
  const list=await h.request('/api/bookings',undefined,{cookie});assert.equal(list.body[0].checkoutAttempt.state,'review_required');
  assert.equal(h.testStore.shared.claims.size,2);assert.equal(h.state.creates.length,before);
  assert.equal((await h.request(route,{}, {cookie,origin:'https://attacker.example'})).status,403);
  const source=fs.readFileSync(path.join(root,'public/admin.js'),'utf8');assert.match(source,/reconcileBtn/);assert.doesNotMatch(source,/release anyway/i);
});

test('New audit 2: new matching contact information cannot release or inspect an old claim',async t=>{
  const h=await harness(t),body={...booking,promoCode:'FIRST15'};await h.request('/api/checkout',body);
  const original=h.records()[0];h.state.sessions.get(original.stripeSessionId).status='expired';
  const attacker=await h.request('/api/checkout',{...body,time:'13:00'},{cookie:''});
  assert.equal(attacker.status,409);assert.equal(h.state.listCalls||0,0);
  assert.equal(h.testStore.shared.claims.size,2);
  assert.deepEqual(h.records().find(r=>r.id===original.id),original);
  assert.doesNotMatch(JSON.stringify(attacker.body),new RegExp(original.id+'|cs_mock|review_required|confirmed_unpaid'));
});

test('New audit 2: paid webhook winning a reconciliation race preserves paid eligibility',async t=>{
  const h=await harness(t),body={...booking,promoCode:'FIRST15'};await h.request('/api/checkout',body);
  const snapshot=h.records()[0],session=h.state.sessions.get(snapshot.stripeSessionId);
  assert.equal((await h.webhook({...session,payment_status:'paid',status:'complete'})).status,200);
  assert.equal(await h.testStore.finalizeReconciliation(snapshot,{state:'confirmed_unpaid',sessionId:session.id,evidence:'verified_expired_unpaid',at:Date.now()}),false);
  assert.equal(h.records()[0].paymentStatus,'paid');assert.equal(h.records()[0].checkoutAttempt.state,'confirmed_paid');
  assert.equal((await h.request('/api/quote',{...body,time:'13:00'})).status,400);
});

test('New audit 2: failed reconciliation write rolls back state and claim',async t=>{
  const h=await harness(t);await h.request('/api/checkout',{...booking,promoCode:'FIRST15'});
  const before=h.records()[0];h.state.sessions.get(before.stripeSessionId).status='expired';h.storageFailures.write=true;
  await assert.rejects(h.context.reconcileFirstRide(before.id),error=>error.storageFailure);
  assert.deepEqual(h.records()[0],before);assert.equal(h.testStore.shared.claims.size,2);
});

test('New audit 2: correlation is unique/nonsecret; immutable retries preserve server parameters',async t=>{
  const {h,body,record}=await unresolvedFirstRide(t);
  const parameters=h.state.creates[0].params,reference=parameters.metadata.attemptReference;
  assert.match(reference,/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  assert.equal(reference,record.checkoutAttempt.correlationId);
  assert.equal((await h.request('/api/checkout',body)).status,200);
  assert.equal(JSON.stringify(h.state.creates[1].params),JSON.stringify(parameters));
  const other=await h.request('/api/checkout',{...body,email:'other@example.test',phone:'2015550101'});
  assert.equal(other.status,200);assert.notEqual(h.records()[0].checkoutAttempt.correlationId,reference);
  const tokens=h.checkoutCookies().split('; ').map(c=>c.split('=')[1]);
  for(const token of tokens)assert.equal(JSON.stringify([h.state.creates,h.records(),h.state.logs]).includes(token),false);
  assert.equal((await h.request('/api/booking/'+record.id,undefined,{cookie:'er_booking_access_'+record.id+'='+reference})).status,401);
});


const approvedEwr=require('../ewr-pickups');
function airportResult(id=booking.pickupPlaceId, overrides={}) {
  return {id,displayName:{text:approvedEwr[id]?.label || 'Newark Liberty Airport Hotel'},
    formattedAddress:'Newark, NJ',types:['airport'],primaryType:'airport',
    location:{latitude:40.6895,longitude:-74.1745},...overrides};
}
const specialBooking={...booking,vehicle:'suv',offerCode:'EWR_MANHATTAN_SUV',promoCode:'FIRST15'};

test('New audit 3: all four approved IDs bind quote, route, Checkout and reservation to verified pickup',async t=>{
  for(const [id,entry] of Object.entries(approvedEwr)) {
    const routeId=entry.label==='Terminal C'?booking.pickupPlaceId:id;
    const h=await harness(t),place=airportResult(routeId,{types:entry.kind==='terminal' && entry.label!=='Terminal C' ? ['point_of_interest','establishment'] : ['airport']});
    h.state.pickupResults=[place];h.state.placeDetails=place;
    const body={...specialBooking,pickup:entry.label,pickupPlaceId:id};
    const quote=await h.request('/api/quote',body);assert.equal(quote.status,200);assert.equal(quote.body.total,150);
    assert.equal(quote.body.discount,0);assert.equal(quote.body.promotion,null);
    assert.equal(JSON.stringify(quote.body).includes(id),false);
    const checkout=await h.request('/api/checkout',body);assert.equal(checkout.status,200);
    assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,15000);
    assert.equal(h.records()[0].trip.pickupPlaceId,id);
    assert.equal(h.records()[0].trip.pickup,place.displayName.text+(entry.label==='Terminal C'?' (Terminal C)':'')+', '+place.formattedAddress);
    assert.ok(h.state.routes.every(route=>route.origin.placeId===routeId && !route.origin.address));
  }
});

test('New audit 3: typed airport/terminal variations work only when Google resolves the approved identity',async t=>{
  for(const pickup of ['EWR','Newark Airport','Newark Liberty International Airport']) {
    const h=await harness(t);assert.equal((await h.request('/api/quote',{...specialBooking,pickup})).status,200);
  }
});

test('New audit 3: nearby places, airport words, other airports and spoofed browser details cannot authorize',async t=>{
  for(const type of ['hotel','restaurant','corporate_office','street_address','parking','car_rental','airport']) {
    const h=await harness(t),unapproved=airportResult('not_approved_'+type,{types:[type]});
    h.state.pickupResults=[unapproved];h.state.placeDetails=unapproved;
    const body={...specialBooking,pickup:'Newark Liberty International Airport Hotel',pickupPlaceId:unapproved.id,
      types:['airport'],primaryType:'airport',latitude:40.6895,longitude:-74.1745};
    for(const endpoint of ['/api/quote','/api/checkout']) {
      const response=await h.request(endpoint,body);assert.equal(response.status,400);
      assert.equal(JSON.stringify(response.body).includes(unapproved.id),false);
    }
    assert.equal(h.state.creates.length,0);assert.equal(h.records().length,0);assert.equal(h.state.routes.length,0);
  }
});

test('New audit 3: missing, malformed, inherited and forged IDs fail; approved ID with conflicting text fails',async t=>{
  for(const pickupPlaceId of [undefined,null,'',{},[],123,'__proto__','constructor','forged_id']) {
    const h=await harness(t);assert.equal((await h.request('/api/checkout',{...specialBooking,pickupPlaceId})).status,400);
    assert.equal(h.state.creates.length,0);
  }
  const h=await harness(t);h.state.pickupResults=[airportResult('hotel_id',{types:['hotel']})];
  assert.equal((await h.request('/api/quote',{...specialBooking,pickup:'Nearby hotel'})).status,400);
  assert.equal((await h.request('/api/checkout',{...specialBooking,pickup:'Nearby hotel'})).status,400);
});

test('New audit 3: changed identity, ambiguity, inconsistent details and provider failure fail closed',async t=>{
  for(const change of [
    {placeDetails:airportResult('changed_id')},{placeDetails:airportResult(undefined,{types:['hotel']})},
    {placeDetails:airportResult(undefined,{location:{latitude:41,longitude:-73}})},
    {placeDetails:airportResult(undefined,{location:{latitude:'40.6895',longitude:-74.1745}})},
    {googleError:true}
  ]) {
    const h=await harness(t);Object.assign(h.state,change);
    for(const endpoint of ['/api/quote','/api/checkout'])assert.equal((await h.request(endpoint,specialBooking)).status,400);
    assert.equal(h.state.creates.length,0);assert.equal(h.records().length,0);
  }
});

test('New audit 3: normal hotel/street bookings remain normal; special vehicle/journey/Manhattan rules unchanged',async t=>{
  for(const pickup of ['Newark Airport Hotel','Nearby Street','Rental Car Facility','Airport Parking']) {
    const h=await harness(t);h.state.pickupResults=[airportResult('hotel_id',{types:['hotel']})];
    const result=await h.request('/api/checkout',{...booking,pickup,pickupPlaceId:'hotel_id'});
    assert.equal(result.status,200);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,10000);
    assert.equal(h.state.routes[0].origin.address,pickup);
  }
  for(const change of [{vehicle:'escalade'},{tripType:'hourly',hours:3},
    {tripType:'roundtrip',returnDate:'2026-11-11',returnTime:'12:00'},{dropoff:'Outside Manhattan'}]) {
    const h=await harness(t);assert.equal((await h.request('/api/checkout',{...specialBooking,...change})).status,400);
  }
});

test('New audit 3: autocomplete retains selected identity and manual edits clear it without redesign',()=>{
  const appSource=fs.readFileSync(path.join(root,'public/app.js'),'utf8');
  const handlers={},input={value:'EWR',dataset:{placeId:booking.pickupPlaceId},addEventListener:(event,fn)=>handlers[event]=fn};
  const context={pickup:input,dropoff:{},syncPickupTerminal(){},syncDropoffTerminal(){},suggestionTimers:{},clearTimeout(){},setTimeout(){return 1;},specialOfferActive:()=>true};
  vm.createContext(context);
  const start=appSource.indexOf('function enableAddressAutocomplete('),end=appSource.indexOf('/* =========================================',start);
  vm.runInContext(appSource.slice(start,end),context);context.enableAddressAutocomplete(input,{innerHTML:''},'pickup');
  input.value='Hotel';handlers.input();assert.equal(input.dataset.placeId,undefined);
  const clicks=[],container={innerHTML:'',appendChild:x=>clicks.push(x)};
  context.document={createElement:()=>({addEventListener(event,fn){this.click=fn;}})};context.resetQuote=()=>{};
  const renderStart=appSource.indexOf('function renderSuggestions('),renderEnd=appSource.indexOf('function enableAddressAutocomplete(',renderStart);
  vm.runInContext(appSource.slice(renderStart,renderEnd),context);
  context.renderSuggestions(container,input,[{description:'EWR',placeId:booking.pickupPlaceId}]);
  clicks[0].click({preventDefault(){}});assert.equal(input.dataset.placeId,booking.pickupPlaceId);assert.equal(input.value,'EWR');
  assert.match(appSource,/if \(pickup.dataset.placeId\) data.pickupPlaceId = pickup.dataset.placeId/);
});


test('EWR terminal selector: general/terminal autocomplete, exact dropdown IDs, clearing and mobile placement',()=>{
  const app=fs.readFileSync(path.join(root,'public/app.js'),'utf8');
  const classes=new Set(['hidden-field']),handlers={};
  const field={classList:{toggle(name,hide){if(hide)classes.add(name);else classes.delete(name);}}};
  const selector={value:'',disabled:true,addEventListener(event,fn){handlers[event]=fn;}};
  const input={value:'EWR',dataset:{placeId:booking.pickupPlaceId}};
  const context={pickup:input,document:{getElementById:id=>id==='pickupTerminal' ? selector : field},resetQuote(){}};
  vm.createContext(context);
  vm.runInContext(app.slice(app.indexOf('const pickupTerminalField ='),app.indexOf('const dropoff =')),context);
  context.syncPickupTerminal();assert.equal(classes.has('hidden-field'),false);assert.equal(selector.disabled,false);assert.equal(selector.value,'');
  for(const key of ['a','b','c','general']) {
    selector.value=key;handlers.change();
    const entry=vm.runInContext('ewrTerminalChoices["'+key+'"]',context);
    assert.equal(input.dataset.placeId,entry.id);assert.equal(input.value,entry.text);
    context.syncPickupTerminal();assert.equal(selector.value,key==='general' ? '' : key);
  }
  input.dataset.placeId='hotel_id';context.syncPickupTerminal();
  assert.equal(classes.has('hidden-field'),true);assert.equal(selector.disabled,true);assert.equal(selector.value,'');
  const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  assert.ok(html.indexOf('id="pickupTerminalField"')>html.indexOf('id="pickupSuggestions"'));
  assert.ok(html.indexOf('id="pickupTerminalField"')<html.indexOf('id="dropoffField"'));
  assert.ok(html.indexOf('id="pickupTerminalField"')<html.indexOf('id="bookingCustomerStep"'));
  assert.match(app,/if \(!pickupTerminal.disabled\) data.pickupTerminal/);
});

test('EWR terminal selector: normal and special quote/Checkout bind every selection to verified Google identity',async t=>{
  const entries=Object.entries(approvedEwr);
  for(let i=0;i<entries.length;i++) {
    const [id,entry]=entries[i],key=['general','a','b','c'][i];
    for(const special of [false,true]) {
      const routeId=entry.label==='Terminal C'?booking.pickupPlaceId:id;
      const h=await harness(t),place=airportResult(routeId);
      h.state.pickupResults=[place];h.state.placeDetails=place;
      const body={...(special ? specialBooking : booking),pickup:entry.label,pickupPlaceId:id,pickupTerminal:key};
      assert.equal((await h.request('/api/quote',body)).body.total,special ? 150 : 100);
      const result=await h.request('/api/checkout',body);assert.equal(result.status,200);
      assert.equal(h.records()[0].trip.pickupPlaceId,id);
      assert.equal(h.records()[0].trip.pickup,place.displayName.text+(entry.label==='Terminal C'?' (Terminal C)':'')+', '+place.formattedAddress);
      assert.ok(h.state.routes.every(route=>route.origin.placeId===routeId));
    }
  }
});

test('EWR terminal selector: normal Round Trip return routes to same terminal; hourly price and security unchanged',async t=>{
  const h=await harness(t),id=Object.keys(approvedEwr)[1];
  h.state.pickupResults=[airportResult(id)];h.state.placeDetails=airportResult(id);
  const body={...booking,pickup:'Terminal A',pickupPlaceId:id,pickupTerminal:'a',tripType:'roundtrip',returnDate:'2026-11-11',returnTime:'12:00'};
  const result=await h.request('/api/checkout',body);assert.equal(result.status,200);
  assert.equal(h.state.routes[0].origin.placeId,id);assert.equal(h.state.routes[1].destination.placeId,id);
  assert.equal(h.records()[0].quote.total,200);
  assert.equal((await h.request('/api/quote',{...body,tripType:'hourly',hours:3})).body.total,450);
  assert.equal((await h.request('/api/quote',{...body,pickup:'Hotel',pickupPlaceId:'hotel_id',pickupTerminal:'a'})).status,400);
});


test('EWR drop-off selector: general and A/B/C autocomplete, exact IDs, independent sides, edits and mobile steps',()=>{
  const app=fs.readFileSync(path.join(root,'public/app.js'),'utf8'),handlers={};
  const makeInput=()=>({value:'',dataset:{},addEventListener(event,fn){this[event]=fn;}});
  const pickupInput=makeInput(),dropoffInput=makeInput();
  const makeField=()=>({hidden:true,classList:{toggle(name,hide){this.owner.hidden=hide;}}});
  const pickupField=makeField(),dropoffField=makeField();pickupField.classList.owner=pickupField;dropoffField.classList.owner=dropoffField;
  const makeSelect=key=>({value:'',disabled:true,addEventListener(event,fn){handlers[key]=fn;}});
  const pickupSelect=makeSelect('pickup'),dropoffSelect=makeSelect('dropoff');
  const elements={pickupTerminal:pickupSelect,pickupTerminalField:pickupField,dropoff:dropoffInput,dropoffTerminal:dropoffSelect,dropoffTerminalField:dropoffField,bookingStepLabel:{textContent:''}};
  const context={pickup:pickupInput,document:{getElementById:id=>elements[id],createElement:()=>({addEventListener(event,fn){this.click=fn;}})},
    resetQuote(){},clearTimeout(){},setTimeout(){},suggestionTimers:{},specialOfferActive:()=>false,
    mobileBooking:{matches:true},bookingPanel:{dataset:{}}};
  vm.createContext(context);vm.runInContext(app.slice(app.indexOf('const pickupTerminalField'),app.indexOf('const dropoffField')),context);
  vm.runInContext(app.slice(app.indexOf('function renderSuggestions('),app.indexOf('async function requestQuote(',app.indexOf('function renderSuggestions('))),context);
  const rendered=[],container={innerHTML:'',appendChild:x=>rendered.push(x)};
  for(const [id,entry] of Object.entries(approvedEwr)) {
    context.renderSuggestions(container,dropoffInput,[{description:entry.label,placeId:id}]);rendered.at(-1).click({preventDefault(){}});
    assert.equal(dropoffField.hidden,false);assert.equal(dropoffSelect.disabled,false);
    assert.equal(dropoffSelect.value,entry.kind==='airport' ? '' : entry.label.slice(-1).toLowerCase());
  }
  pickupSelect.disabled=false;pickupSelect.value='a';handlers.pickup();const originalPickup={...pickupInput.dataset};
  for(const choice of ['a','b','c','general']) {
    dropoffSelect.value=choice;handlers.dropoff();
    const expected=vm.runInContext('ewrTerminalChoices["'+choice+'"]',context);
    assert.equal(dropoffInput.dataset.placeId,expected.id);assert.equal(dropoffInput.value,expected.text);
    assert.deepEqual(pickupInput.dataset,originalPickup);
  }
  const originalDropoff={...dropoffInput.dataset};pickupSelect.value='b';handlers.pickup();assert.deepEqual(dropoffInput.dataset,originalDropoff);
  const stepStart=app.indexOf('function showBookingStep('),stepEnd=app.indexOf('function continueBooking(',stepStart);
  vm.runInContext(app.slice(stepStart,stepEnd),context);
  context.showBookingStep(2);context.showBookingStep(1);assert.deepEqual(dropoffInput.dataset,originalDropoff);
  context.enableAddressAutocomplete(dropoffInput,container,'dropoff');dropoffInput.value='Hotel';dropoffInput.input();
  assert.equal(dropoffInput.dataset.placeId,undefined);assert.equal(dropoffField.hidden,true);assert.equal(dropoffSelect.value,'');
  context.renderSuggestions(container,dropoffInput,[{description:'Hotel',placeId:'hotel_id'}]);rendered.at(-1).click({preventDefault(){}});
  assert.equal(dropoffField.hidden,true);assert.equal(dropoffSelect.disabled,true);
  const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  assert.ok(html.indexOf('id="dropoffTerminalField"')>html.indexOf('id="dropoffSuggestions"'));
  assert.ok(html.indexOf('id="dropoffTerminalField"')<html.indexOf('id="bookingCustomerStep"'));
});

test('EWR drop-off selector: every terminal quotes, routes, reserves and checks out at normal pricing',async t=>{
  let index=0;
  for(const [id,entry] of Object.entries(approvedEwr)) {
    const h=await harness(t),place=airportResult(id);
    h.state.searchResults={[entry.label]:[place]};h.state.detailsById={[id]:place};
    const body={...booking,pickup:'Manhattan',dropoff:entry.label,dropoffPlaceId:id,dropoffTerminal:['general','a','b','c'][index++]};
    const quote=await h.request('/api/quote',body);assert.equal(quote.status,200);assert.equal(quote.body.total,100);assert.equal(quote.body.fixedOffer,null);
    const checkout=await h.request('/api/checkout',body);assert.equal(checkout.status,200);
    assert.equal(h.records()[0].trip.dropoffPlaceId,id);assert.equal(h.records()[0].trip.dropoff,place.displayName.text+', '+place.formattedAddress);
    assert.ok(h.state.routes.every(route=>route.destination.placeId===id));assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,10000);
    const promo=await h.request('/api/quote',{...body,promoCode:'FIRST15'});assert.equal(promo.body.total,85);
    const special=await h.request('/api/quote',{...body,vehicle:'suv',offerCode:'EWR_MANHATTAN_SUV'});assert.equal(special.status,400);
  }
});

test('EWR drop-off selector: both EWR identities stay independent in outbound and return routes',async t=>{
  const h=await harness(t),ids=Object.keys(approvedEwr),origin=airportResult(ids[1]),destination=airportResult(ids[2]);
  h.state.searchResults={'Terminal A':[origin],'Terminal B':[destination]};h.state.detailsById={[ids[1]]:origin,[ids[2]]:destination};
  const body={...booking,pickup:'Terminal A',pickupPlaceId:ids[1],pickupTerminal:'a',dropoff:'Terminal B',dropoffPlaceId:ids[2],dropoffTerminal:'b',tripType:'roundtrip',returnDate:'2026-11-11',returnTime:'12:00'};
  const checkout=await h.request('/api/checkout',body);assert.equal(checkout.status,200);
  assert.equal(h.state.routes[0].origin.placeId,ids[1]);assert.equal(h.state.routes[0].destination.placeId,ids[2]);
  assert.equal(h.state.routes[1].origin.placeId,ids[2]);assert.equal(h.state.routes[1].destination.placeId,ids[1]);
  const record=h.records()[0];assert.equal(record.trip.pickupPlaceId,ids[1]);assert.equal(record.trip.dropoffPlaceId,ids[2]);assert.equal(record.quote.total,200);
});

test('EWR drop-off selector: forged IDs, conflicting locations, changed identities and provider failures reject Checkout',async t=>{
  for(const change of [{dropoffPlaceId:'hotel_id'},{dropoffTerminal:'b'},{dropoff:'Hotel'},{dropoffPlaceId:null}]) {
    const h=await harness(t);h.state.searchResults={Hotel:[airportResult('hotel_id')]};
    const body={...booking,dropoff:'EWR',dropoffPlaceId:booking.pickupPlaceId,dropoffTerminal:'general',...change};
    for(const endpoint of ['/api/quote','/api/checkout'])assert.equal((await h.request(endpoint,body)).status,400);
    assert.equal(h.state.creates.length,0);
  }
  for(const change of [{placeDetails:airportResult('changed')},{googleError:true}]) {
    const h=await harness(t);Object.assign(h.state,change);
    assert.equal((await h.request('/api/checkout',{...booking,dropoff:'EWR',dropoffPlaceId:booking.pickupPlaceId,dropoffTerminal:'general'})).status,400);
    assert.equal(h.state.creates.length,0);
  }
});


test('EWR drop-off selector: a special request cannot attach an airport destination ID to Manhattan text',async t=>{
  const h=await harness(t);
  const forged={...specialBooking,dropoffTerminal:'general',dropoffPlaceId:booking.pickupPlaceId};
  for(const endpoint of ['/api/quote','/api/checkout'])assert.equal((await h.request(endpoint,forged)).status,400);
  assert.equal(h.state.creates.length,0);assert.equal(h.records().length,0);
});

 test('EWR direct identity verification ignores mismatched/ambiguous text search for special and normal terminals',async t=>{
  const entries=Object.entries(approvedEwr);
  for(let i=0;i<entries.length;i++){
   const [id,entry]=entries[i],key=['general','a','b','c'][i];
   for(const search of [[],[airportResult()],[airportResult(),airportResult()]]){
    const h=await harness(t);h.state.pickupResults=search;h.state.placeDetails=airportResult(entry.label==='Terminal C'?booking.pickupPlaceId:id);
    const body={...specialBooking,pickup:entry.kind==='airport'?'Newark Liberty International Airport (EWR), 3 Brewster Rd, Newark, NJ 07114':'Newark Liberty International Airport '+entry.label,pickupPlaceId:id,pickupTerminal:key};
    const quote=await h.request('/api/quote',body);assert.equal(quote.status,200);assert.equal(quote.body.total,150);
    assert.equal((await h.request('/api/checkout',body)).status,200);assert.equal(h.records()[0].quote.total,150);
    assert.ok(h.state.routes.every(route=>route.origin.placeId===(entry.label==='Terminal C'?booking.pickupPlaceId:id)));
   }
   for(const side of ['pickup','dropoff']){
    const h=await harness(t);h.state.pickupResults=[];h.state.placeDetails=airportResult(side==='pickup'&&entry.label==='Terminal C'?booking.pickupPlaceId:id);
    const body={...booking,[side]:entry.label,[side+'PlaceId']:id,[side+'Terminal']:key};
    assert.equal((await h.request('/api/quote',body)).status,200);
    assert.equal((await h.request('/api/checkout',body)).status,200);
   }
  }
 });
 test('EWR direct verification rejects conflicting terminal text and forged airport-business descriptions',async t=>{
  for(const pickup of ['Terminal B','Newark Liberty International Airport Hotel','Airport Parking','Rental Car Facility','Nearby street']){
   const h=await harness(t);const id=Object.keys(approvedEwr)[1];h.state.placeDetails=airportResult(id);
   for(const endpoint of ['/api/quote','/api/checkout'])assert.equal((await h.request(endpoint,{...specialBooking,pickup,pickupPlaceId:id})).status,400);
   assert.equal(h.state.creates.length,0);
  }
 });

test('temporary EWR diagnostics correlate all approved identities without exposing provider or customer values',async t=>{
 for(const [id,entry]of Object.entries(approvedEwr)){
  const h=await harness(t);h.state.placeDetails=airportResult(entry.label==='Terminal C'?booking.pickupPlaceId:id,{displayName:{text:'synthetic-private-name-marker'},formattedAddress:'synthetic-private-address-marker'});
  const result=await h.request('/api/quote',{...specialBooking,pickup:entry.label,pickupPlaceId:id});assert.equal(result.status,200);
  const logs=h.state.logs.map(x=>{try{return JSON.parse(x)}catch{return {}}}).filter(x=>x.operation==='ewr_verification');
  assert.ok(logs.some(x=>x.reason==='EWR_VERIFY_SUCCESS'));assert.ok(logs.every(x=>x.referenceId===result.headers.get('x-request-id')));
  assert.equal(logs.at(-1).textCompatible,true);
  const output=h.state.logs.join(' ');for(const value of ['synthetic-private',id,booking.email,booking.phone,'mock-google-key',booking.dropoff])assert.ok(!output.includes(value),value);
  assert.ok(!JSON.stringify(result.body).includes('EWR_VERIFY'));
 }
});
test('temporary EWR diagnostics identify existing rejection guards and preserve sanitized customer errors',async t=>{
 const cases=[
  [{pickupPlaceId:undefined},{},'EWR_VERIFY_PLACE_ID_MISSING'],
  [{pickupPlaceId:{}},{},'EWR_VERIFY_PLACE_ID_MALFORMED'],
  [{pickupPlaceId:'unapproved-private-marker'},{},'EWR_VERIFY_PLACE_ID_NOT_APPROVED'],
  [{},{placeDetails:airportResult('changed-private-marker')},'EWR_VERIFY_ID_MISMATCH'],
  [{},{placeDetails:airportResult(undefined,{location:{latitude:41,longitude:-73}})},'EWR_VERIFY_GEOGRAPHY_REJECTED'],
  [{pickup:'private customer hotel address'},{},'EWR_VERIFY_TEXT_CONFLICT'],
  [{},{placeDetails:airportResult(undefined,{types:['parking']})},'EWR_VERIFY_TYPE_REJECTED'],
  [{},{placeDetails:airportResult(undefined,{location:{}})},'EWR_VERIFY_LOCATION_MISSING'],
  [{},{placeDetails:airportResult(undefined,{types:[]})},'EWR_VERIFY_TYPES_MISSING_OR_INVALID'],
  [{},{placeDetails:airportResult(undefined,{types:['point_of_interest']})},'EWR_VERIFY_AIRPORT_TYPE_MISSING'],
  [{},{placeDetails:airportResult(undefined,{displayName:{}})},'EWR_VERIFY_DISPLAY_NAME_MISSING'],
  [{},{placeDetails:airportResult(undefined,{formattedAddress:''})},'EWR_VERIFY_ADDRESS_MISSING'],
  [{},{googleError:true},'EWR_VERIFY_PROVIDER_HTTP_FAILURE'],
  [{},{providerNetworkFailure:true},'EWR_VERIFY_PROVIDER_NETWORK_FAILURE'],
  [{},{providerInvalidJson:true},'EWR_VERIFY_PROVIDER_INVALID_JSON'],
  [{},{providerTimeout:true},'EWR_VERIFY_PROVIDER_TIMEOUT'],
  [{},{googleBody:null},'EWR_VERIFY_PROVIDER_BAD_RESPONSE']
 ];
 for(const [body,state,reason]of cases){const h=await harness(t);Object.assign(h.state,state);const r=await h.request('/api/quote',{...specialBooking,...body});assert.equal(r.status,400);
  const logs=h.state.logs.map(x=>{try{return JSON.parse(x)}catch{return {}}});assert.ok(logs.some(x=>x.reason===reason),reason);
  assert.ok(logs.filter(x=>x.reason).every(x=>x.referenceId===r.body.referenceId));
  assert.doesNotMatch(h.state.logs.join(' '),/private-marker|private customer|synthetic-private|mock-google-key/);
  assert.ok(!JSON.stringify(r.body).includes('EWR_VERIFY'));
 }
});

test('verified allowlisted EWR terminals accept structural Google categories formerly rejected; quote and Checkout remain $150',async t=>{
 const entries=Object.entries(approvedEwr).filter(([,entry])=>entry.kind==='terminal' && entry.label!=='Terminal C');
 for(const [id,entry]of entries){
  for(const type of ['parking','route','car_rental']){
   const h=await harness(t);h.state.placeDetails=airportResult(id,{types:[type,'point_of_interest','establishment'],primaryType:type});
   const body={...specialBooking,pickup:'Newark Liberty International Airport '+entry.label,pickupPlaceId:id,pickupTerminal:entry.label.slice(-1).toLowerCase()};
   const quote=await h.request('/api/quote',body);assert.equal(quote.status,200);assert.equal(quote.body.total,150);assert.equal(quote.body.discount,0);assert.equal(quote.body.promotion,null);
   const checkout=await h.request('/api/checkout',body);assert.equal(checkout.status,200);
   assert.equal(h.records()[0].quote.total,150);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,15000);
   assert.equal(h.records()[0].trip.pickupPlaceId,id);assert.ok(h.state.routes.every(r=>r.origin.placeId===id));
   assert.ok(h.state.logs.some(line=>{try{return JSON.parse(line).reason==='EWR_VERIFY_SUCCESS'}catch{return false}}));
  }
 }
});
test('identity-aware terminal types preserve exact ID, geography, text, provider and structural guards',async t=>{
 const id=Object.keys(approvedEwr)[1];
 for(const override of [{id:'unapproved-hotel-id'},{types:[]},{types:['parking',42]},{types:null},{location:{}},{location:{latitude:41,longitude:-73}}]){
  const h=await harness(t);h.state.placeDetails=airportResult(id,{types:['parking'],primaryType:'parking',...override});
  for(const endpoint of ['/api/quote','/api/checkout'])assert.equal((await h.request(endpoint,{...specialBooking,pickup:'Terminal A',pickupPlaceId:id})).status,400);
  assert.equal(h.state.creates.length,0);
 }
 for(const pickup of ['Terminal B','Newark Airport Hotel','Airport Parking','Rental Car Facility']){
  const h=await harness(t);h.state.placeDetails=airportResult(id,{types:['parking'],primaryType:'parking'});
  assert.equal((await h.request('/api/checkout',{...specialBooking,pickup,pickupPlaceId:id})).status,400);
 }
 const h=await harness(t);h.state.googleError=true;assert.equal((await h.request('/api/checkout',{...specialBooking,pickup:'Terminal A',pickupPlaceId:id})).status,400);
});

test('EWR HTTP failure diagnostics log only validated numeric provider status, never provider body or private values',async t=>{
 for(const status of [400,403,404,429,500,503,'404',null,-1,600,NaN]){
  const h=await harness(t);h.state.googleError=true;h.state.providerStatus=status;
  let bodyReads=0;h.state.googleBody={get privatePayload(){bodyReads++;return 'synthetic-private-provider-body';}};
  // Invalid diagnostic JSON must never leak parser details or inspect unrelated fields.
  h.state.providerInvalidJson=true;
  const result=await h.request('/api/quote',specialBooking);assert.equal(result.status,400);
  const logs=h.state.logs.map(line=>{try{return JSON.parse(line)}catch{return {}}});
  const entry=logs.find(x=>x.reason==='EWR_VERIFY_PROVIDER_HTTP_FAILURE');assert.ok(entry);
  const valid=Number.isInteger(status)&&status>=100&&status<=599;
  if(valid)assert.equal(entry.providerStatus,status);else assert.ok(!Object.hasOwn(entry,'providerStatus'));
  assert.deepEqual(Object.keys(entry).sort(),['timestamp','referenceId','operation','identity','reason',...(valid?['providerStatus']:[])].sort());
  assert.equal(entry.referenceId,result.body.referenceId);assert.equal(bodyReads,0);
  assert.ok(!logs.some(x=>x.reason==='EWR_VERIFY_PROVIDER_INVALID_JSON'));
  const output=JSON.stringify([h.state.logs,result.body]);
  for(const value of ['synthetic-private','mock-google-key',booking.email,booking.phone,booking.pickupPlaceId,booking.dropoff])assert.ok(!output.includes(value),value);
  assert.ok(!Object.hasOwn(result.body,'providerStatus'));
 }
});

test('EWR HTTP failures expose only explicitly allowlisted structured Google status in server diagnostics',async t=>{
 for(const status of ['INVALID_ARGUMENT','NOT_FOUND','PERMISSION_DENIED','UNAVAILABLE','ATTACKER_PRIVATE_MARKER','invalid_argument','INVALID_ARGUMENT private-secret','INVALID_ARGUMENT\n',null,400,{},'A'.repeat(65)]){
  const h=await harness(t);h.state.googleError=true;h.state.providerStatus=400;
  h.state.googleBody={error:{status,message:'synthetic-private-message mock-google-key '+booking.email,details:[{private:'synthetic-private-details'}]},private:'synthetic-private-body'};
  const result=await h.request('/api/quote',specialBooking);assert.equal(result.status,400);
  const entry=h.state.logs.map(line=>{try{return JSON.parse(line)}catch{return {}}}).find(x=>x.reason==='EWR_VERIFY_PROVIDER_HTTP_FAILURE');
  assert.equal(entry.providerStatus,400);
  const approved=['INVALID_ARGUMENT','NOT_FOUND','PERMISSION_DENIED','UNAVAILABLE'].includes(status);
  if(approved)assert.equal(entry.providerErrorStatus,status);else assert.ok(!Object.hasOwn(entry,'providerErrorStatus'));
  assert.deepEqual(Object.keys(entry).sort(),['timestamp','referenceId','operation','identity','reason','providerStatus',...(approved?['providerErrorStatus']:[])].sort());
  assert.equal(entry.referenceId,result.body.referenceId);
  const output=JSON.stringify([h.state.logs,result.body]);assert.doesNotMatch(output,/synthetic-private|ATTACKER_PRIVATE_MARKER|mock-google-key/);
  for(const value of [booking.email,booking.phone,booking.pickupPlaceId])assert.ok(!output.includes(value));
  assert.ok(!Object.hasOwn(result.body,'providerErrorStatus'));assert.ok(!Object.hasOwn(result.body,'providerStatus'));
 }
 for(const body of [{},null,{error:{message:'synthetic-private-message'}}]){
  const h=await harness(t);h.state.googleError=true;h.state.googleBody=body;
  assert.equal((await h.request('/api/quote',specialBooking)).status,400);
  const entry=h.state.logs.map(line=>{try{return JSON.parse(line)}catch{return {}}}).find(x=>x.reason==='EWR_VERIFY_PROVIDER_HTTP_FAILURE');
  assert.ok(!Object.hasOwn(entry,'providerErrorStatus'));
 }
});


test('Trip Summary displays Luxury SUV while quote/request keep the internal suv key and original provider label',async()=>{
 const app=fs.readFileSync(path.join(root,'public/app.js'),'utf8'),cell=()=>({textContent:''});
 const context={sumVehicle:cell(),sumMiles:cell(),sumMinutes:cell(),sumTotal:cell(),sumMilesLabel:cell(),sumMinutesLabel:cell(),sumTotalLabel:cell(),
  currentQuote:null,promoSummary:{hidden:false},payBtn:{},quoteBtn:{},quoteArea:{classList:{contains:()=>false,remove(){},add(){}}},
  vehicle:{value:'suv',disabled:false,options:[{textContent:'Cadillac Escalade ESV'}],selectedIndex:0},form:{reportValidity:()=>true},
  clearNotice(){},showNotice(){},showPromoResult(){},formatMoney:value=>String(value),getFormData(){return {vehicle:this.vehicle.value};}};
 context.getFormData=()=>({vehicle:context.vehicle.value});
 let sent;const data={vehicle:'Black SUV',vehicleKey:'suv',miles:10,minutes:20,total:150,currency:'usd',fixedOffer:{}};
 context.fetch=async(url,options)=>{sent=JSON.parse(options.body);return {ok:true,json:async()=>data};};vm.createContext(context);
 vm.runInContext(app.slice(app.indexOf('function resetQuote()'),app.indexOf('/* =========================================',app.indexOf('function resetQuote()'))),context);
 context.resetQuote();assert.equal(context.sumVehicle.textContent,'Luxury SUV');assert.equal(context.vehicle.value,'suv');
 vm.runInContext(app.slice(app.indexOf('async function requestQuote('),app.indexOf('quoteBtn.addEventListener(',app.indexOf('async function requestQuote('))),context);
 const quote=await context.requestQuote();assert.equal(context.sumVehicle.textContent,'Luxury SUV');assert.equal(sent.vehicle,'suv');assert.equal(quote.vehicleKey,'suv');assert.equal(quote.vehicle,'Black SUV');assert.equal(quote.total,150);
 data.vehicleKey='escalade';data.vehicle='Cadillac Escalade ESV';context.vehicle.value='escalade';await context.requestQuote();assert.equal(context.sumVehicle.textContent,'Cadillac Escalade ESV');
});


test('Terminal C-only fallback verifies and routes General EWR, preserves pickup instructions and never probes Terminal C',async t=>{
 const c='ChIJMYEleJSwokRawcDBeH8NVg',general=booking.pickupPlaceId;
 for(const special of [true,false]){
  const h=await harness(t);h.state.rejectTerminalCDetails=true;
  const body={...(special?specialBooking:booking),pickup:'Newark Liberty International Airport Terminal C',pickupPlaceId:c,pickupTerminal:'c'};
  const quote=await h.request('/api/quote',body);assert.equal(quote.status,200);assert.equal(quote.body.total,special?150:100);assert.equal(quote.body.vehicleKey,special?'suv':'escalade');
  if(special){assert.equal(quote.body.discount,0);assert.equal(quote.body.promotion,null);}
  const out=await h.request('/api/checkout',body);assert.equal(out.status,200);
  assert.deepEqual(h.state.detailsRequests,[general,general]);assert.ok(h.state.routes.every(r=>r.origin.placeId===general));
  const record=h.records()[0];assert.equal(record.trip.pickupPlaceId,c);assert.match(record.trip.pickup,/Newark Liberty International Airport \(Terminal C\)/);
  const {tripDto}=require('../storage/customer-trips');assert.equal(tripDto(record).pickupTerminal,'Terminal C');
  const admin=fs.readFileSync(path.join(root,'public/admin.js'),'utf8'),context={esc:value=>String(value||'').replaceAll('<','&lt;')};vm.createContext(context);
  vm.runInContext(admin.slice(admin.indexOf('function renderBooking('),admin.indexOf('bookingsEl.addEventListener("click"')),context);assert.ok(context.renderBooking(record).includes(record.trip.pickup));
  const session=[...h.state.sessions.values()][0];assert.equal((await h.webhook({...session,payment_status:'paid'})).status,200);assert.equal(h.records()[0].trip.pickup,record.trip.pickup);assert.equal(h.records()[0].trip.pickupPlaceId,c);
  assert.doesNotMatch(h.state.logs.join(' '),/EWR_TERMINAL_C_SEARCH|EWR_VERIFY_ID_ONLY/);
 }
 assert.doesNotMatch(source,/EWR_TERMINAL_C_SEARCH|EWR_VERIFY_ID_ONLY|ewrProbe|screeningCounts|3 brewster rd, newark, nj 07114, united states/);
});

test('A, B and General continue verifying/routing their exact original Google identities',async t=>{
 for(const [id,entry]of Object.entries(approvedEwr).slice(0,3)){
  const h=await harness(t);h.state.placeDetails=airportResult(id);const body={...specialBooking,pickup:entry.label,pickupPlaceId:id};
  assert.equal((await h.request('/api/quote',body)).status,200);assert.equal((await h.request('/api/checkout',body)).status,200);assert.deepEqual(h.state.detailsRequests,[id,id]);assert.ok(h.state.routes.every(r=>r.origin.placeId===id));assert.equal(h.records()[0].trip.pickupPlaceId,id);
 }
});

test('Terminal C fallback retains every General EWR identity, classification, geography, description and provider guard',async t=>{
 const c='ChIJMYEleJSwokRawcDBeH8NVg',body={...specialBooking,pickup:'Terminal C',pickupPlaceId:c,pickupTerminal:'c'};
 for(const change of [
  {placeDetails:airportResult(c)},{placeDetails:airportResult('changed')},{placeDetails:airportResult(undefined,{types:['point_of_interest']})},
  {placeDetails:airportResult(undefined,{types:['airport','parking']})},{placeDetails:airportResult(undefined,{types:[]})},{placeDetails:airportResult(undefined,{types:['airport',42]})},
  {placeDetails:airportResult(undefined,{location:{}})},{placeDetails:airportResult(undefined,{location:{latitude:41,longitude:-73}})},
  {placeDetails:airportResult(undefined,{displayName:{}})},{placeDetails:airportResult(undefined,{formattedAddress:''})},
  {googleError:true,providerStatus:400,googleBody:{error:{status:'INVALID_ARGUMENT'}}},{providerTimeout:true},{providerNetworkFailure:true},{providerInvalidJson:true}
 ]){
  const h=await harness(t);Object.assign(h.state,change);
  for(const endpoint of ['/api/quote','/api/checkout'])assert.equal((await h.request(endpoint,body)).status,400);
  assert.deepEqual(h.state.detailsRequests,[booking.pickupPlaceId,booking.pickupPlaceId]);assert.equal(h.state.creates.length,0);assert.equal(h.records().length,0);
 }
 for(const change of [{pickupPlaceId:undefined},{pickupPlaceId:'forged'},{pickup:'Terminal A'},{pickup:'EWR'},{pickup:'Newark Airport'},{pickup:'Newark Liberty International Airport Hotel'},{pickup:'Hotel'}]){
  const h=await harness(t);for(const endpoint of ['/api/quote','/api/checkout'])assert.equal((await h.request(endpoint,{...body,...change})).status,400);assert.equal(h.state.creates.length,0);
 }
 for(const change of [{vehicle:'escalade'},{tripType:'hourly',hours:3},{tripType:'roundtrip',returnDate:'2026-11-11',returnTime:'12:00'},{dropoff:'Outside Manhattan'}]){
  const h=await harness(t);assert.equal((await h.request('/api/checkout',{...body,...change})).status,400);assert.equal(h.state.creates.length,0);
 }
});

test('normal Terminal C Round Trip routes back to verified General EWR and preserves chauffeur instructions',async t=>{
 const h=await harness(t),body={...booking,pickup:'Terminal C',pickupPlaceId:'ChIJMYEleJSwokRawcDBeH8NVg',pickupTerminal:'c',tripType:'roundtrip',returnDate:'2026-11-11',returnTime:'12:00'};
 h.state.rejectTerminalCDetails=true;assert.equal((await h.request('/api/checkout',body)).status,200);assert.equal(h.state.routes[0].origin.placeId,booking.pickupPlaceId);assert.equal(h.state.routes[1].destination.placeId,booking.pickupPlaceId);assert.match(h.records()[0].trip.pickup,/Terminal C/);assert.equal(h.records()[0].quote.total,200);
});
