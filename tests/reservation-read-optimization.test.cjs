'use strict';

const assert = require('node:assert/strict');
const {createHash, randomUUID} = require('node:crypto');
const test = require('node:test');
const {setTimeout: delay} = require('node:timers/promises');
const {approvalHash} = require('../services/quote-approval');
const {cookie, guestBooking, harness, initialClock, setup} = require('./helpers/reservation-management.cjs');

const pg = {skip: !process.env.ER_TEST_DATABASE_URL && 'Requires isolated loopback PostgreSQL'};
const minute = 60_000;
const checkout = '/api/checkout';
const quote = '/api/quote';
const payLater = {...guestBooking, paymentChoice: 'later'};

function historicalRecord(overrides = {}) {
  return {
    id: randomUUID(),
    createdAt: new Date(initialClock - 45 * minute).toISOString(),
    status: 'awaiting_payment',
    paymentStatus: 'unpaid',
    stripeSessionId: null,
    customer: {firstName: 'Test', lastName: 'Fixture', email: 'history@example.test', phone: '2015550133'},
    trip: {pickup: 'EWR', dropoff: 'Manhattan', date: '2026-11-10', time: '12:00', vehicle: 'escalade', tripType: 'oneway', passengers: 6},
    quote: {total: 100, currency: 'usd', vehicle: 'Cadillac Escalade ESV', vehicleKey: 'escalade'},
    dispatch: {driver: '', driverPhone: '', vehicle: '', plate: ''},
    ...overrides
  };
}

function observePg(pool) {
  const calls = [];
  const observed = new WeakSet();
  pool.on('acquire', client => {
    if (observed.has(client)) return;
    observed.add(client);
    const query = client.query;
    client.query = function (text, ...args) {
      const call = {client: this.processID, text: typeof text === 'string' ? text : text.text};
      const values = typeof text === 'string' ? args[0] : text.values;
      if (Array.isArray(values) && values.length === 1 && values[0] === 730901 && /pg_advisory_xact_lock/.test(call.text)) call.budgetLock = true;
      calls.push(call);
      function capture(result) {
        if (!result?.fields) return;
        call.fields = result.fields.map(field => field.name);
        call.rows = result.rowCount;
        if (call.fields.includes('id')) call.ids = result.rows.map(row => row.id);
      }
      const callback = args.at(-1);
      if (typeof callback === 'function') {
        args[args.length - 1] = (error, result) => {
          capture(result);
          callback(error, result);
        };
        return query.call(this, text, ...args);
      }
      return query.call(this, text, ...args).then(result => {
        capture(result);
        return result;
      });
    };
  });
  return calls;
}

const reads = calls => calls.filter(call => /^\s*(SELECT|WITH)\b/i.test(call.text) && /\ber_reservations\b/.test(call.text));

function assertNoFullHistoryRead(calls) {
  assert.ok(!reads(calls).some(call => /SELECT\s+id,\s*record\s+FROM\s+er_reservations\s+ORDER\s+BY/i.test(call.text)));
}

function checkoutCookie(response) {
  const access = cookie(response, 'er_checkout_access_' + response.body.bookingId);
  assert.ok(access);
  return access;
}

async function appendHistory(fixture, records) {
  assert.deepEqual(await fixture.store.importLegacy(records), {inserted: records.length, skipped: 0});
}

test('quote and Pay Now use targeted PostgreSQL reads and preserve exact accepted cents', pg, async t => {
  const f = await setup(t);
  await appendHistory(f, Array.from({length: 32}, () => historicalRecord()));
  const sql = observePg(f.pool);
  const reviewed = await f.post(quote, guestBooking);
  assert.equal(reviewed.status, 200);
  assert.ok(reviewed.body.quoteApproval);
  const quoteReads = reads(sql.splice(0));
  assert.equal(quoteReads.length, 1);
  assert.match(quoteReads[0].text, /SELECT 1 FROM er_reservations LIMIT 0/i);
  assert.equal(quoteReads[0].rows, 0);

  const body = {...guestBooking, quoteApproval: reviewed.body.quoteApproval};
  const booked = await f.post(checkout, body);
  assert.equal(booked.status, 200);
  assert.deepEqual(Object.keys(booked.body).sort(), ['bookingId', 'url']);
  assert.equal(new URL(booked.body.url).hostname, 'checkout.example.test');
  assertNoFullHistoryRead(sql);

  const creationRead = reads(sql.splice(0));
  const duplicate = creationRead.find(call => call.text.includes('checkoutFingerprint'));
  const approval = creationRead.find(call => call.text.includes('quoteApprovalHash'));
  const budget = creationRead.find(call => call.text.includes('checkoutClientHash'));
  assert.ok(duplicate && approval && budget, 'Checkout reads fingerprint, approval usage, and booking budget');
  assert.equal(duplicate.rows, 0);
  assert.equal(approval.rows, 1);
  assert.equal(approval.fields.length, 1);
  assert.equal(budget.rows, 32);
  assert.deepEqual(budget.fields.sort(), ['checkoutClientHash', 'createdAt', 'email', 'phone']);
  assert.match(budget.text, /created_at\s*>\s*\$1/i);

  const saved = await f.store.get(booked.body.bookingId);
  assert.equal(saved.quote.total, reviewed.body.total);
  assert.equal(f.h.state.creates.length, 1);
  assert.equal(f.h.state.creates[0].params.line_items[0].price_data.unit_amount, Math.round(reviewed.body.total * 100));
  const access = checkoutCookie(booked);

  sql.length = 0;
  const retry = await f.post(checkout, body, access);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, booked.body);
  assert.equal(f.h.state.creates.length, 1);
  assertNoFullHistoryRead(sql);
  const match = reads(sql).find(call => call.text.includes('checkoutFingerprint'));
  assert.deepEqual(match.ids, [saved.id]);
  assert.equal(match.rows, 1);
});

test('duplicate lookup preserves newest noncancelled reservation and ID tie precedence', pg, async t => {
  const f = await setup(t);
  const initial = await f.post(checkout, payLater);
  assert.equal(initial.status, 200);
  const accepted = await f.store.get(initial.body.bookingId);
  const access = checkoutCookie(initial);
  const common = {checkoutFingerprint: accepted.checkoutFingerprint};
  const newerCancelled = historicalRecord({
    ...common, status: 'cancelled', createdAt: new Date(initialClock + minute).toISOString()
  });
  const older = historicalRecord(common);
  const higherIdAtSameTime = historicalRecord({
    ...common, id: 'ffffffff-ffff-4fff-bfff-ffffffffffff', createdAt: accepted.createdAt
  });
  await appendHistory(f, [newerCancelled, older, higherIdAtSameTime]);
  const sql = observePg(f.pool);
  const result = await f.post(checkout, payLater, access);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, initial.body);
  const observed = reads(sql).find(call => call.text.includes('checkoutFingerprint'));
  assert.deepEqual(observed.ids, [accepted.id]);
  assert.equal(observed.rows, 1);
  assertNoFullHistoryRead(sql);
  assert.equal((await f.store.get(accepted.id)).quote.total, accepted.quote.total);
  assert.equal(f.h.state.creates.length, 0);
});

test('a previously accepted approval on a cancelled reservation still requires a fresh review', pg, async t => {
  const f = await setup(t);
  const reviewed = await f.post(quote, payLater);
  assert.equal(reviewed.status, 200);
  const approved = {...payLater, quoteApproval: reviewed.body.quoteApproval};
  const first = await f.post(checkout, approved);
  assert.equal(first.status, 200);
  const accepted = await f.store.get(first.body.bookingId);
  assert.equal(accepted.quoteApprovalHash, approvalHash(reviewed.body.quoteApproval));
  await f.store.withActionLock(accepted.checkoutFingerprint, () => f.store.update(accepted.id, record => {
    record.status = 'cancelled';
  }));

  const sql = observePg(f.pool);
  const retry = await f.post(checkout, approved);
  assert.equal(retry.status, 409);
  assert.equal(retry.body.code, 'QUOTE_CHANGED');
  assert.equal(retry.body.reason, 'review_required');
  assert.equal(retry.body.quote.total, reviewed.body.total);
  assert.notEqual(retry.body.quote.quoteApproval, reviewed.body.quoteApproval);
  assertNoFullHistoryRead(sql);
  const match = reads(sql).find(call => call.text.includes('quoteApprovalHash'));
  assert.equal(match.fields.length, 1);
  assert.equal(match.rows, 1);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM er_reservations')).rows[0].n, 1);

  const confirmed = await f.post(checkout, {...payLater, quoteApproval: retry.body.quote.quoteApproval});
  assert.equal(confirmed.status, 200);
  assert.notEqual(confirmed.body.bookingId, accepted.id);
  assert.equal((await f.store.get(confirmed.body.bookingId)).quote.total, reviewed.body.total);
  assert.equal(f.h.state.creates.length, 0);
});

test('rolling limits preserve historical normalization, statuses, sources and strict time boundaries', pg, async t => {
  const cases = [
    {name: 'customer 30 minute', window: 30 * minute, threshold: 6},
    {name: 'customer 24 hour', window: 24 * 60 * minute, threshold: 20},
    {name: 'source 30 minute', source: true, window: 30 * minute, threshold: 12},
    {name: 'source 24 hour', source: true, window: 24 * 60 * minute, threshold: 40}
  ];
  for (const {name, window, threshold, source} of cases) {
    await t.test(name, async t => {
      const f = await setup(t);
      const template = historicalRecord();
      const clientHash = createHash('sha256').update('127.0.0.1').digest('hex');
      const historical = (i, age, overrides = {}) => historicalRecord({
        status: i % 2 ? 'cancelled' : 'awaiting_payment',
        paymentStatus: i % 2 ? 'failed' : 'unpaid',
        createdAt: new Date(initialClock - age).toISOString(),
        ...(source ? {checkoutClientHash: clientHash} : {
          customer: {
            ...template.customer,
            ...(i % 2 ? {phone: '(201) 555-0199'} : {email: '  MANAGE-GUEST@EXAMPLE.TEST  '})
          }
        }),
        ...overrides
      });
      await appendHistory(f, [
        ...Array.from({length: threshold - 1}, (_, i) => historical(i, window - 1)),
        historical(0, window),
        historical(1, window - 1, {status: 'confirmed', paymentStatus: 'paid'})
      ]);
      const sql = observePg(f.pool);
      const accepted = await f.post(checkout, {...payLater, notes: 'Below the rolling limit'});
      assert.equal(accepted.status, 200);
      const blocked = await f.post(checkout, {...payLater, notes: 'At the rolling limit'});
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers.get('retry-after'), '1800');
      assert.deepEqual(blocked.body, {
        error: 'Too many requests. Please try again later.',
        referenceId: blocked.headers.get('x-request-id')
      });
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM er_reservations')).rows[0].n, threshold + 2);
      assert.equal(f.h.state.creates.length, 0);
      assertNoFullHistoryRead(sql);
    });
  }
});

test('concurrent independent Checkout workers serialize the rolling limit and insertion', pg, async t => {
  const f = await setup(t);
  const second = await harness(t, {}, '[]', f.store);
  const template = historicalRecord();
  await appendHistory(f, Array.from({length: 5}, () => historicalRecord({
    createdAt: new Date(initialClock - minute).toISOString(),
    customer: {...template.customer, email: payLater.email}
  })));
  const firstBody = {...payLater, notes: 'First simultaneous request'};
  const secondBody = {...payLater, notes: 'Second simultaneous request'};
  const reviewed = await Promise.all([f.h.request(quote, firstBody), second.request(quote, secondBody)]);
  assert.ok(reviewed.every(result => result.status === 200));
  const gate = await f.pool.connect();
  await gate.query('SELECT pg_advisory_lock($1)', [730901]);
  const sql = observePg(f.pool);
  const contenders = Promise.all([f.h.request(checkout, firstBody), second.request(checkout, secondBody)]);
  try {
    for (let attempt = 0; attempt < 200 && sql.filter(call => call.budgetLock).length < 2; attempt++) {
      await delay(10);
    }
  } finally {
    await gate.query('SELECT pg_advisory_unlock($1)', [730901]);
    gate.release();
  }
  const results = await contenders;
  assert.deepEqual(results.map(result => result.status).sort(), [200, 429]);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM er_reservations')).rows[0].n, 6);

  const locks = sql.filter(call => call.budgetLock);
  assert.equal(locks.length, 2);
  assert.notEqual(locks[0].client, locks[1].client);
  for (const lock of locks) {
    const connection = sql.filter(call => call.client === lock.client);
    const budget = connection.find(call => call.text.includes('checkoutClientHash'));
    assert.ok(connection.indexOf(budget) > connection.indexOf(lock));
    const insert = connection.find(call => /^\s*INSERT INTO er_reservations\b/i.test(call.text));
    if (insert) assert.ok(connection.indexOf(insert) > connection.indexOf(budget));
  }
  assertNoFullHistoryRead(sql);
});

test('a PostgreSQL lookup failure causes a safe Checkout error without Stripe creation', pg, async t => {
  const f = await setup(t);
  const reviewed = await f.post(quote, guestBooking);
  assert.equal(reviewed.status, 200);
  await f.pool.query('ALTER TABLE er_reservations RENAME TO er_reservations_unavailable_fixture');
  const unavailable = [
    await f.post(quote, guestBooking),
    await f.post(checkout, {...guestBooking, quoteApproval: reviewed.body.quoteApproval})
  ];
  for (const response of unavailable) {
    assert.equal(response.status, 503);
    assert.deepEqual(Object.keys(response.body).sort(), ['error', 'referenceId']);
    assert.equal(response.body.referenceId, response.headers.get('x-request-id'));
    assert.equal(response.body.error, 'Reservation service temporarily unavailable. Please try again. Reference: ' + response.body.referenceId);
  }
  assert.equal(f.h.state.creates.length, 0);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM er_reservations_unavailable_fixture')).rows[0].n, 0);
});
