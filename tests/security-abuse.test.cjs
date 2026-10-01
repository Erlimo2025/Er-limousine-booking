// Isolated HTTP regression tests: mocked Google/Stripe and in-memory booking data.
// Run: node --test tests/security-abuse.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const http = require("node:http");
const realExpress = require("express");
const Stripe = require("stripe");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "server.js"), "utf8");
const pricing = require("../pricing");
const booking = {
  pickup: "EWR", dropoff: "Manhattan", date: "2026-11-10", time: "12:00",
  vehicle: "escalade", passengers: 6, tripType: "oneway",
  firstName: "Test", lastName: "Customer", email: "test@example.test", phone: "2015550199"
};

async function harness(t, env = {}, saved = "[]") {
  let app, data = saved, clock = Date.parse("2026-10-01T16:00:00Z");
  const testPricing = JSON.parse(JSON.stringify(pricing));
  const state = { creates: [], sessions: new Map(), googleCalls: 0, routes: [], timeout: false,
    googleError: false, fail: null, retrieveError: false, createDelay: 0, timeoutMs: null };
  const signatureSdk = new Stripe("sk_test_not_a_real_key");
  class MockStripe {
    constructor() {
      this.webhooks = signatureSdk.webhooks;
      this.checkout = {sessions: {
        create: async (params, options) => {
          state.creates.push({params, options});
          if (state.createDelay) await new Promise(resolve => setTimeout(resolve, state.createDelay));
          if (state.fail) { const failure = state.fail; state.fail = null; throw failure; }
          const previous = [...state.sessions.values()].find(item => item.key === options.idempotencyKey);
          if (previous) return previous;
          const session = {id: `cs_mock_${state.sessions.size}`, url: "https://checkout.example.test/mock",
            status: "open", key: options.idempotencyKey};
          state.sessions.set(session.id, session);
          return session;
        },
        retrieve: async id => {
          if (state.retrieveError) throw new Error("private provider detail");
          return state.sessions.get(id);
        }
      }};
    }
  }
  const express = Object.assign(() => {
    app = realExpress();
    app.listen = () => {};
    return app;
  }, realExpress);
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const context = {
    __dirname: root, console, URL, Date: TestDate,
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
      if (state.onGoogle) state.onGoogle();
      if (state.timeout) return new Promise((resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(new Error("mock secret detail"))));
      return {ok: !state.googleError, json: async () => {
        if (url.includes("computeRoutes")) {
          const route = JSON.parse(options.body);
          state.routes.push(route);
          if (state.routeResult) return {routes: [state.routeResult(route)]};
          return {routes: [{distanceMeters: 16093.44, duration: "1200s"}]};
        }
        if (url.includes("autocomplete")) return {suggestions: [{placePrediction: {text: {text: "Mock address"}}}]};
        return {places: [JSON.parse(options.body).textQuery === "EWR"
          ? {location: {latitude: 40.6895, longitude: -74.1745}}
          : {addressComponents: [{types: ["administrative_area_level_2"], longText: "New York County"}]}]};
      }};
    },
    require(name) {
      if (name === "dotenv") return {config() {}};
      if (name === "express") return express;
      if (name === "stripe") return MockStripe;
      if (name === "./pricing") return testPricing;
      if (name === "fs") return {existsSync: () => true, readFileSync: () => data,
        writeFileSync: (file, contents) => {data = contents;}};
      return require(name);
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    state, app, context, signatureSdk,
    get data() { return data; },
    records: () => JSON.parse(data),
    advance: ms => {clock += ms;},
    async request(route, body, headers = {}, method = body === undefined ? "GET" : "POST") {
      const response = await fetch(url + route, {
        method, headers: {"content-type": "application/json", ...headers},
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
      });
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
  assert.deepEqual((await h.request("/api/address-suggestions?q=Newark")).body.suggestions, ["Mock address"]);
  assert.equal(h.state.timeoutMs, 8000);
  assert.equal((await h.request("/api/bookings", undefined, {authorization: "Bearer local-test-token"})).status, 200);
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
  assert.ok(results.every(result => result.status === 200));
  assert.equal(new Set(results.map(result => result.body.bookingId)).size, 1);
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
  assert.deepEqual(h.state.creates[0].params, h.state.creates[1].params);
  assert.equal(h.records().length, 1);
  const failure = await harness(t); failure.state.fail = new Error("mock network timeout");
  await failure.request("/api/checkout", booking);
  const restarted = await harness(t, {}, failure.data);
  await restarted.request("/api/checkout", booking);
  assert.equal(restarted.state.creates[0].options.idempotencyKey, failure.state.creates[0].options.idempotencyKey);
  assert.equal(restarted.records().length, 1);
  const rejected = await harness(t);
  rejected.state.fail = Object.assign(new Error("mock invalid request"), {type: "StripeInvalidRequestError"});
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
  for (let i = 0; i < 10; i++) assert.equal((await h.request("/api/bookings", undefined,
    {authorization: `Bearer invalid${i}`})).status, 401);
  assert.equal((await h.request("/api/bookings")).status, 429);
  assert.equal((await h.request("/api/bookings", undefined, {authorization: "Bearer local-test-token"})).status, 200);
  assert.equal((await h.request("/api/bookings/not-found", {}, {authorization: "Bearer invalid"}, "PATCH")).status, 429);
  h.advance(15 * 60000 + 1);
  assert.equal((await h.request("/api/bookings")).status, 401);
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
