'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {Pool} = require('pg');
const {setTimeout: delay} = require('node:timers/promises');
const {createStore} = require('../storage/postgres');
const {generateBookingReference, normalizeBookingReference} = require('../services/booking-reference');
const {setup, base, queue, account, guestBooking, cookie} = require('./helpers/reservation-management.cjs');

const pg = {skip: !process.env.ER_TEST_DATABASE_URL && 'Requires an isolated PostgreSQL test database'};
const format = /^ER-[0-9]{6}$/;

function reservation(overrides = {}) {
  return {
    id: crypto.randomUUID(), createdAt: '2026-10-01T16:00:00Z', status: 'awaiting_payment',
    paymentStatus: 'unpaid', stripeSessionId: null,
    customer: {firstName: 'Test', lastName: 'Rider', email: 'history@example.test', phone: '2015550109'},
    trip: {pickup: 'Newark', dropoff: 'Manhattan', date: '2026-11-10', time: '13:00', vehicle: 'suv', tripType: 'oneway', passengers: 2},
    quote: {total: 100, currency: 'usd', vehicle: 'Luxury SUV', vehicleKey: 'suv'},
    dispatch: {driver: '', driverPhone: '', vehicle: '', plate: ''},
    ...overrides
  };
}

test('the secure generator uses the full six-digit space and the selector requires the exact format', t => {
  const values = [0, 256781, 999999];
  t.mock.method(crypto, 'randomInt', max => {
    assert.equal(max, 1_000_000);
    return values.shift();
  });
  assert.deepEqual(Array.from({length: 3}, generateBookingReference), ['ER-000000', 'ER-256781', 'ER-999999']);
  assert.equal(normalizeBookingReference('er-256781'), 'ER-256781');
  for (const invalid of ['ER-12345', 'ER-1234567', 'ER-１２３４５６', 'ER-123456\n', ' ER-123456', '123456', ['ER-123456'], null]) {
    assert.equal(normalizeBookingReference(invalid), null);
  }
});

test('concurrent PostgreSQL writers retry a collision and keep one immutable reference per UUID', pg, async t => {
  const f = await setup(t);
  const second = createStore({}, new Pool(f.pool.options));
  t.after(() => second.close());
  const values = [256781, 256781, 482731, 629145, 116243];
  const random = t.mock.method(crypto, 'randomInt', () => values.shift());
  const records = Array.from({length: 4}, () => reservation());
  await Promise.all(records.map((record, index) =>
    (index % 2 ? second : f.store).createWithBudget(record, () => {})));
  const rows = (await f.pool.query('SELECT id,booking_reference,record FROM er_reservations')).rows;
  assert.equal(random.mock.callCount(), 5);
  assert.deepEqual(rows.map(row => row.booking_reference).sort(), ['ER-116243', 'ER-256781', 'ER-482731', 'ER-629145']);
  assert.deepEqual(rows.map(row => row.id).sort(), records.map(record => record.id).sort());
  for (const row of rows) assert.deepEqual(row.record, records.find(record => record.id === row.id));

  const [first] = rows;
  const rejected = reservation();
  const directInsert = reference => f.pool.query(
    'INSERT INTO er_reservations (id,record,created_at,booking_reference) VALUES ($1,$2,$3,$4)',
    [rejected.id, rejected, rejected.createdAt, reference]
  );
  await assert.rejects(directInsert(first.booking_reference), {code: '23505', constraint: 'er_reservations_booking_reference_key'});
  await assert.rejects(directInsert('ER-1234567'), {code: '23514', constraint: 'er_reservations_booking_reference_format'});
  await assert.rejects(f.pool.query('UPDATE er_reservations SET booking_reference=NULL WHERE id=$1', [first.id]),
    /Booking reference is immutable/);

  random.mock.mockImplementation(() => Number(first.booking_reference.slice(3)));
  await assert.rejects(f.store.createWithBudget(rejected, () => {}), {status: 503});
  assert.equal(random.mock.callCount(), 5 + 32);
  assert.equal(await f.store.get(rejected.id), null);
  assert.equal((await f.pool.query('SELECT 1 FROM er_booking_email_outbox WHERE booking_id=$1', [rejected.id])).rowCount, 0);
});

test('legacy PostgreSQL backfill retries collisions without changing reservation or financial history', pg, async t => {
  const f = await setup(t);
  const current = reservation();
  const values = [256781, 256781, 482731, 629145];
  t.mock.method(crypto, 'randomInt', () => values.shift());
  await f.store.createWithBudget(current, () => {});
  const legacy = [
    reservation({status: 'cancelled', paymentStatus: 'paid', stripeSessionId: 'cs_test_history',
      paidAt: '2026-10-02T16:00:00Z', refundStatus: 'confirmed', refundConfirmedAt: '2026-10-03T16:00:00Z'}),
    reservation()
  ];
  assert.deepEqual(await f.store.importLegacy(legacy), {inserted: 2, skipped: 0});
  const ids = legacy.map(record => record.id);
  const snapshots = async () => (await f.pool.query(
    'SELECT id,record,version,created_at,updated_at,customer_id FROM er_reservations WHERE id=ANY($1::uuid[]) ORDER BY id', [ids]
  )).rows;
  const ledger = async () => (await f.pool.query('SELECT * FROM er_payment_ledger WHERE booking_id=$1', [ids[0]])).rows;
  const before = await snapshots();
  const payments = await ledger();
  assert.equal(payments.length, 1);
  assert.equal((await f.store.getForDisplay(ids[0])).bookingReference, null);
  assert.equal(await f.store.backfillBookingReferences(), 2);
  await f.store.migrate();
  assert.equal(await f.store.backfillBookingReferences(), 0);
  assert.deepEqual(await snapshots(), before);
  assert.deepEqual(await ledger(), payments);
  assert.equal((await f.store.getForDisplay(current.id)).bookingReference, 'ER-256781');
  const references = await Promise.all(ids.map(async id => (await f.store.getForDisplay(id)).bookingReference));
  assert.deepEqual(references.sort(), ['ER-482731', 'ER-629145']);
});

test('authorized views, emails, Dispatch and Stripe retain distinct public references and internal UUIDs', pg, async t => {
  const f = await setup(t);
  const owner = await f.register();
  const foreign = await f.register({email: 'foreign@example.test', phone: '2015550154'});
  t.mock.method(crypto, 'randomInt', () => 256781);
  const submitted = await f.post('/api/checkout', {...guestBooking, email: account.email, paymentChoice: 'later',
    bookingReference: 'ER-123456'}, owner);
  assert.equal(submitted.status, 200);
  const id = submitted.body.bookingId;
  const {bookingReference: reference, quote} = await f.store.getForDisplay(id);
  assert.match(reference, format);
  assert.notEqual(reference, 'ER-123456');
  assert.equal(new URL(submitted.body.url).searchParams.get('booking'), id);

  const tripPath = '/api/customer/trips/' + id;
  const trip = (await f.get(tripPath, owner)).body.trip;
  assert.equal(trip.reference, id);
  assert.equal(trip.bookingReference, reference);
  const all = await f.get('/api/customer/trips', owner);
  assert.equal(all.status, 200);
  assert.ok(all.body.trips.some(record => record.bookingReference === reference));
  assert.equal((await f.get(tripPath, foreign)).status, 404);
  assert.equal((await f.get('/api/customer/trips/' + reference, owner)).status, 404);
  assert.equal((await f.get('/api/booking/' + reference)).status, 401);
  assert.equal((await f.get(base + '/account/' + reference, owner)).status, 404);
  assert.equal((await f.post('/api/booking/' + reference + '/checkout', {})).status, 404);

  const search = '/api/bookings/search?search=' + reference.toLowerCase();
  assert.equal((await f.get(search)).status, 401);
  const admin = await f.adminLogin();
  const match = await f.get(search, admin);
  assert.equal(match.status, 200);
  assert.deepEqual(match.body.bookings.map(record => [record.id, record.bookingReference]), [[id, reference]]);
  const request = await f.post(base + '/account/' + id + '/requests', {
    requestId: crypto.randomUUID(), kind: 'locations', pickup: 'New Newark pickup', dropoff: '', confirmed: true
  }, owner);
  assert.equal(request.status, 200);
  const pending = (await f.get(queue, admin)).body.requests[0];
  assert.equal(pending.reservation.reference, id);
  assert.equal(pending.reservation.bookingReference, reference);
  assert.equal((await f.get(base + '/account/' + id, owner)).body.reservation.bookingReference, reference);

  assert.equal((await f.post(tripPath + '/payment', {}, owner)).status, 200);
  const [session] = f.h.state.sessions.values();
  assert.equal(f.h.state.creates[0].params.metadata.bookingId, id);
  assert.equal(f.h.state.creates[0].params.line_items[0].price_data.unit_amount, Math.round(quote.total * 100));
  session.status = 'complete';
  session.payment_status = 'paid';
  assert.equal((await f.h.webhook(session)).status, 200);
  await f.h.context.runBookingEmails();
  const emails = f.h.state.bookingMessages.filter(message => message.to === account.email);
  assert.equal(emails.length, 2);
  for (const message of emails) {
    assert.ok(message.text.includes('Booking reference: ' + reference));
    assert.ok(message.html.includes(reference));
    assert.ok(!JSON.stringify(message).includes(id));
  }
  assert.equal((await f.store.getForDisplay(id)).bookingReference, reference);
});

test('a short guest reference only selects a reservation for existing email verification', pg, async t => {
  const f = await setup(t);
  const id = await f.reserve();
  const otherId = await f.reserve(null, {time: '15:00'});
  const owner = await f.register();
  const accountId = await f.reserve(owner, {email: account.email, time: '16:00'});
  const reference = (await f.store.getForDisplay(id)).bookingReference;
  const accountReference = (await f.store.getForDisplay(accountId)).bookingReference;
  const unknownReference = ['ER-000000', 'ER-999999', 'ER-654321'].find(value => ![reference, accountReference].includes(value));
  const wrong = await f.requestVerification(reference, 'wrong@example.test');
  const unknown = await f.requestVerification(unknownReference, 'unknown@example.test');
  const owned = await f.requestVerification(accountReference, account.email);
  const right = await f.requestVerification(reference.toLowerCase(), guestBooking.email);
  assert.deepEqual([unknown.body, owned.body, right.body], [wrong.body, wrong.body, wrong.body]);
  assert.equal((await f.get(base + '/guest')).status, 404);
  const {message, token} = await f.waitForInvitation();
  assert.equal(message.to, guestBooking.email);
  await delay(20);
  assert.equal(f.invitations().length, 1);
  const accepted = await f.post(base + '/verification/exchange', {token});
  assert.equal(accepted.status, 200);
  const grant = cookie(accepted, 'er_reservation_management');
  assert.equal((await f.get(base + '/guest', grant)).body.reservation.bookingReference, reference);
  assert.equal((await f.get('/api/booking/' + id, grant)).body.bookingReference, reference);
  assert.equal((await f.get('/api/booking/' + otherId, grant)).status, 401);
  assert.equal((await f.post(base + '/verification/exchange', {token})).status, 400);
});

test('allocation exhaustion rejects new checkout before payment and retries unfinished legacy work', pg, async t => {
  const f = await setup(t);
  const owner = await f.register();
  const random = t.mock.method(crypto, 'randomInt', () => 999999);
  const existing = await f.reserve(owner, {email: account.email});
  const accepted = await f.store.getForDisplay(existing);
  assert.equal(accepted.bookingReference, 'ER-999999');
  const old = reservation();
  await f.store.importLegacy([old]);
  const jobs = async () => (await f.pool.query('SELECT id, booking_id, kind FROM er_booking_email_outbox ORDER BY id')).rows;
  const existingJobs = await jobs();
  assert.equal(existingJobs.length, 2);

  for (const [paymentChoice, time] of [['now', '14:00'], ['later', '15:00']]) {
    const before = random.mock.callCount();
    const rejected = await f.post('/api/checkout', {...guestBooking, time, paymentChoice});
    assert.equal(rejected.status, 503);
    assert.equal(rejected.body.bookingId, undefined);
    assert.equal(rejected.body.url, undefined);
    assert.equal(random.mock.callCount() - before, 32);
  }
  assert.deepEqual(await jobs(), existingJobs);
  assert.equal((await f.store.list()).length, 2);
  assert.equal(f.h.state.creates.length, 0);

  const before = random.mock.callCount();
  await f.h.context.runBookingReferenceBackfill();
  assert.equal(random.mock.callCount() - before, 32);
  assert.equal((await f.store.getForDisplay(old.id)).bookingReference, null);
  assert.equal((await f.post('/api/customer/trips/' + existing + '/payment', {}, owner)).status, 200);
  assert.equal(f.h.state.creates.length, 1);
  assert.equal(f.h.state.creates[0].params.metadata.bookingId, existing);
  assert.equal(f.h.state.creates[0].params.line_items[0].price_data.unit_amount, Math.round(accepted.quote.total * 100));
  assert.equal((await f.store.getForDisplay(existing)).bookingReference, 'ER-999999');

  random.mock.mockImplementation(() => 0);
  await f.h.context.runBookingReferenceBackfill();
  assert.deepEqual(await f.store.getForDisplay(old.id), {...old, bookingReference: 'ER-000000'});
});

test('migration 018 and repeatable concurrent backfill preserve 123 legacy reservations and related history', pg, async t => {
  const f = await setup(t);
  const schema = 'prior_booking_reference_' + crypto.randomBytes(8).toString('hex');
  const options = {...f.pool.options, options: '-c search_path=' + schema};
  const pool = new Pool(options);
  const store = createStore({}, pool);
  const restarted = createStore({}, new Pool(options));
  t.after(async () => {
    try {
      await restarted.close();
      await pool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    } finally {
      await store.close();
    }
  });
  await f.pool.query('CREATE SCHEMA ' + schema);
  const directory = path.join(__dirname, '../migrations');
  const baseline = fs.readdirSync(directory).filter(name => /^0(?:0[1-9]|1[0-7])-.*\.sql$/.test(name)).sort();
  for (const name of baseline) await pool.query(fs.readFileSync(path.join(directory, name), 'utf8'));
  const versions = async () => (await pool.query('SELECT version FROM er_schema_migrations ORDER BY version')).rows.map(row => row.version);
  assert.deepEqual(await versions(), Array.from({length: 17}, (_, i) => i + 1));

  const paid = reservation({status: 'cancelled', paymentStatus: 'paid', stripeSessionId: 'cs_test_reference_history',
    paidAt: '2026-10-02T16:00:00Z', refundStatus: 'confirmed', refundConfirmedAt: '2026-10-03T16:00:00Z'});
  assert.deepEqual(await store.importLegacy([paid, ...Array.from({length: 122}, () => reservation())]), {inserted: 123, skipped: 0});
  const settlement = crypto.randomUUID();
  await pool.query(
    'INSERT INTO er_managed_cancellations(id,booking_id,request_id,terms_revision,origin,pickup_at,fare_cents,captured_cents,' +
    'fee_percent,fee_cents,amount_cents,currency,stripe_session_id,payment_intent_id,charge_id,idempotency_key,state,evidence,' +
    'stripe_refund_id,first_submitted_at,submission_count,created_at,updated_at,confirmed_at)' +
    " VALUES($1,$2,$3,$4,'guest',$5,10000,10000,0,0,10000,'usd',$6,'pi_reference_history','ch_reference_history'," +
    "$7,'confirmed','webhook_confirmed','re_reference_history',$8,1,$8,$8,$8)",
    [settlement, paid.id, crypto.randomUUID(), 'a'.repeat(64), '2026-11-10T18:00:00Z',
      paid.stripeSessionId, 'er-managed-cancel-' + settlement, paid.refundConfirmedAt]
  );
  await pool.query(
    "INSERT INTO er_managed_cancellation_events(id,cancellation_id,state,evidence,stripe_event_id,created_at) " +
    "VALUES($1,$2,'confirmed','webhook_confirmed','evt_reference_history',$3)",
    [crypto.randomUUID(), settlement, paid.refundConfirmedAt]
  );
  const history = async () => Promise.all([
    pool.query('SELECT id, record, version, created_at, updated_at, customer_id FROM er_reservations ORDER BY id'),
    pool.query('SELECT * FROM er_payment_ledger WHERE booking_id=$1', [paid.id]),
    pool.query('SELECT * FROM er_managed_cancellations WHERE id=$1', [settlement]),
    pool.query('SELECT * FROM er_managed_cancellation_events WHERE cancellation_id=$1', [settlement])
  ]).then(results => results.map(result => result.rows));
  const before = await history();
  assert.deepEqual(before.map(rows => rows.length), [123, 1, 1, 1]);

  await store.migrate();
  assert.deepEqual(await versions(), Array.from({length: 18}, (_, i) => i + 1));
  const missing = async () => (await pool.query(
    'SELECT id FROM er_reservations WHERE booking_reference IS NULL ORDER BY id'
  )).rows.map(row => row.id);
  assert.equal((await missing()).length, 123);

  let next = 100000;
  t.mock.method(crypto, 'randomInt', () => next++);
  const locked = await pool.connect();
  try {
    await locked.query('BEGIN');
    await locked.query('SELECT id FROM er_reservations WHERE id=$1 FOR UPDATE', [paid.id]);
    assert.equal(await store.backfillBookingReferences(), 50);
    assert.equal((await missing()).length, 73);
    const batches = await Promise.all([restarted.backfillBookingReferences(), store.backfillBookingReferences()]);
    assert.deepEqual(batches.sort((a, b) => a - b), [22, 50]);
    assert.deepEqual(await missing(), [paid.id]);
  } finally {
    try { await locked.query('ROLLBACK'); } finally { locked.release(); }
  }
  assert.equal(await restarted.backfillBookingReferences(), 1);
  assert.deepEqual(await missing(), []);
  const assigned = async () => (await pool.query(
    'SELECT id, booking_reference FROM er_reservations ORDER BY id'
  )).rows;
  const references = await assigned();
  assert.equal(new Set(references.map(row => row.booking_reference)).size, 123);
  for (const row of references) assert.match(row.booking_reference, format);
  await restarted.migrate();
  assert.equal(await restarted.backfillBookingReferences(), 0);
  assert.deepEqual(await assigned(), references);
  assert.deepEqual(await history(), before);
});
