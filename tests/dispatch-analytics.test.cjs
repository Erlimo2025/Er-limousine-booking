'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {summaryInput, tripsInput, summaryResult, csvTrip} = require('../services/dispatch-analytics');
const {analyticsFixture, dateQuery, endpoint} = require('./helpers/dispatch-analytics.cjs');
const {guestBooking} = require('./helpers/reservation-management.cjs');

const pg = {skip: !process.env.ER_TEST_DATABASE_URL && 'Requires an isolated PostgreSQL test database'};
const now = Date.parse('2026-01-01T04:59:59.999Z');
const range = (from, to = from) => ({from, to});

test('all date presets resolve in New York across the year boundary', () => {
  const expected = {
    today: range('2025-12-31'), yesterday: range('2025-12-30'),
    thisWeek: range('2025-12-29', '2026-01-04'), lastWeek: range('2025-12-22', '2025-12-28'),
    thisMonth: range('2025-12-01', '2025-12-31'), lastMonth: range('2025-11-01', '2025-11-30'),
    thisYear: range('2025-01-01', '2025-12-31'), lastYear: range('2024-01-01', '2024-12-31')
  };
  for (const [preset, selected] of Object.entries(expected)) assert.deepEqual(summaryInput({preset}, now).selected, selected);
  assert.deepEqual(summaryInput({}, now).selected, expected.thisMonth);
  assert.deepEqual(summaryInput({preset: 'today'}, now + 1).selected, range('2026-01-01'));
});

test('custom, leap-year, full-year and multiple-year ranges and comparisons are exact', () => {
  const q1 = summaryInput({from: '2026-01-01', to: '2026-03-31'}, now);
  assert.deepEqual(q1.previous, {range: range('2025-10-01', '2025-12-31'), basis: {unit: 'month', count: 3}});
  assert.equal(q1.granularity, 'week');
  const leap = summaryInput({preset: 'custom', from: '2024-02-01', to: '2024-02-29'}, now);
  assert.deepEqual(leap.previous, {range: range('2024-01-01', '2024-01-31'), basis: {unit: 'month', count: 1}});
  const partial = summaryInput({from: '2026-03-07', to: '2026-03-09'}, now);
  assert.deepEqual(partial.previous, {range: range('2026-03-04', '2026-03-06'), basis: {unit: 'day', count: 3}});
  const fall = summaryInput({from: '2026-10-31', to: '2026-11-02'}, now);
  assert.deepEqual(fall.previous, {range: range('2026-10-28', '2026-10-30'), basis: {unit: 'day', count: 3}});
  const year = summaryInput({from: '2024-01-01', to: '2024-12-31'}, now);
  assert.equal(year.granularity, 'month');
  const full = summaryResult([], year);
  assert.deepEqual(full.comparison.range, range('2023-01-01', '2023-12-31'));
  assert.deepEqual(full.comparison.basis, {unit: 'month', count: 12});
  assert.equal(full.activity.buckets.length, 12);
  assert.deepEqual(full.activity.buckets[1], {from: '2024-02-01', to: '2024-02-29', completed: 0, cancelled: 0,
    pendingRequests: 0, approvedRequests: 0, declinedRequests: 0, collectedCents: '0'});
  const years = summaryInput({from: '2023-01-01', to: '2026-12-31'}, now);
  assert.equal(summaryResult([], years).activity.buckets.length, 48);
  const end = summaryInput({from: '9999-11-20', to: '9999-12-31'}, now);
  assert.equal(summaryResult([], end).activity.buckets.at(-1).to, '9999-12-31');
  const earliest = summaryInput({from: '0001-01-01', to: '0001-01-02'}, now);
  assert.equal(summaryResult([], earliest).comparison, null);
});

test('growth rounds precisely with zero, one-cent, large, fractional and unavailable baselines', () => {
  const query = summaryInput({from: '2026-11-11', to: '2026-11-11'}, now);
  const capture = (day, cents) => ({day, kind: 'capture', count: '1', cents, missing: '0'});
  function growth(before, after, extra = []) {
    const rows = [capture('2026-11-10', before), capture('2026-11-11', after), ...extra];
    return summaryResult(rows, query).comparison.growth.collectedCents;
  }
  for (const [before, after, expected] of [
    ['0', '0', {kind: 'no_change'}],
    ['0', '1', {kind: 'no_prior_activity'}],
    ['1', '1', {kind: 'no_change'}],
    ['1', '0', {kind: 'percent', basisPoints: '-10000'}],
    ['1', '900719925474099199', {kind: 'percent', basisPoints: '9007199254740991980000'}],
    ['6', '7', {kind: 'percent', basisPoints: '1667'}],
    ['6', '5', {kind: 'percent', basisPoints: '-1667'}],
    ['20000', '20001', {kind: 'percent', basisPoints: '1'}],
    ['20000', '19999', {kind: 'percent', basisPoints: '-1'}],
    ['20001', '20002', {kind: 'below_precision', direction: 'increase'}],
    ['20001', '20000', {kind: 'below_precision', direction: 'decrease'}]
  ]) assert.deepEqual(growth(before, after), expected, before + ' to ' + after);
  for (const day of ['2026-11-10', '2026-11-11']) {
    assert.deepEqual(growth('100', '110', [{day, last_day: day, kind: 'payment_gap', count: '1'}]), {kind: 'unavailable'});
  }
});

test('invalid and injected date, search, sort and pagination values are rejected', () => {
  for (const query of [
    {from: '2025-02-29', to: '2025-03-01'}, {from: '2026-04-01', to: '2026-03-31'}, {from: '2026-01-01'},
    {from: ['2026-01-01'], to: '2026-01-31'}, {from: '2026-01-01T00:00:00Z', to: '2026-03-31'},
    {preset: 'today', from: '2026-01-01', to: '2026-01-31'}, {preset: 'constructor'}, {timeZone: 'UTC'}
  ]) assert.throws(() => summaryInput(query, now), {status: 400});
  for (const extra of [{page: '-1'}, {limit: '101'}, {sort: 'id DESC; SELECT 1'}, {order: 'invalid'},
    {status: ['completed']}, {payment: 'unknown'}, {vehicle: 'sedan'}, {search: 'text\nbad'}, {other: true}]) {
    assert.throws(() => tripsInput({...range('2026-01-01', '2026-03-31'), ...extra}, now), {status: 400});
  }
});

test('CSV escapes formulas, Unicode invisible prefixes, quotes and commas', () => {
  const result = csvTrip({reference: 'ER-123456', pickupDate: '2026-11-11', pickup: '\u2060=1+1',
    destination: 'Apt "B", 7th Street', vehicleLabel: 'Luxury SUV / Suburban', status: 'confirmed',
    paymentStatus: 'review', fareCents: '900719925474099195', capturedCents: null, refundedCents: '0'});
  assert.match(result, /"'\u2060=1\+1"/);
  assert.match(result, /"Apt ""B"", 7th Street"/);
  assert.match(result, /9007199254740991\.95,Unavailable,0\.00\r\n$/);
});

test('quarter and full-year summaries reconcile dates, historical fares, statuses, requests and cash', pg, async t => {
  const f = await analyticsFixture(t);
  const a = await f.trip({createdAt: '2026-01-01T05:00:00Z', pickupAt: '2026-01-09T17:00:00Z',
    status: 'completed', fareCents: 12000, capture: 12000, paidAt: '2026-01-09T17:00:00Z'});
  const b = await f.trip({createdAt: '2026-01-01T04:59:59Z', pickupAt: '2026-02-03T17:00:00Z',
    status: 'cancelled', fareCents: 9000, capture: 9000, paidAt: '2026-02-03T17:00:00Z', archived: true});
  await f.managedRefund(b, {confirmedAt: '2026-03-12T17:00:00Z'});
  const c = await f.trip({createdAt: '2026-04-01T03:59:59.999Z', pickupAt: '2026-04-01T03:59:59.999Z',
    status: 'completed', fareCents: 20000, capture: 10000, paidAt: '2026-04-01T04:00:00Z', vehicle: 'escalade'});
  const d = await f.trip({createdAt: '2026-04-01T04:00:00Z', pickupAt: '2026-04-01T04:00:00Z',
    status: 'cancelled', fareCents: 14000});
  const e = await f.trip({createdAt: '2026-02-01T17:00:00Z', pickupAt: '2026-03-10T17:00:00Z',
    status: 'assigned', fareCents: 15000});
  const pending = await f.trip({createdAt: '2026-02-02T17:00:00Z', pickupAt: '2026-03-11T17:00:00Z',
    status: 'awaiting_payment', fareCents: 8000});
  await f.trip({createdAt: '2026-02-03T17:00:00Z', pickupAt: '2026-11-12T17:00:00Z', fareCents: 18000});
  await f.trip({createdAt: '2025-11-10T17:00:00Z', pickupAt: '2025-11-11T17:00:00Z', status: 'completed',
    fareCents: 10000, capture: 10000, paidAt: '2025-11-11T17:00:00Z'});
  await f.request(a, 'pending', '2026-01-01T04:59:59Z');
  await f.request(e, 'pending', '2026-01-01T05:00:00Z');
  await f.request(b, 'approved', '2026-02-20T18:00:00Z');
  await f.request(pending, 'declined', '2026-04-01T03:59:59Z');
  await f.request(d, 'approved', '2026-04-01T04:00:00Z');
  const admin = await f.adminLogin();
  const quarter = dateQuery('2026-01-01', '2026-03-31');
  const response = await f.get(endpoint + '?' + quarter, admin);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.range, range('2026-01-01', '2026-03-31'));
  assert.equal(response.body.timeZone, 'America/New_York');
  assert.deepEqual(response.body.summary, {
    bookingsReceived: 5, completedRides: 2, cancelledRides: 1, upcomingRides: 0, pendingReservations: 1,
    pendingRequests: 1, approvedRequests: 1, declinedRequests: 1,
    grossAcceptedCents: '73000', completedValueCents: '32000', collectedCents: '21000', refundsCents: '9000',
    netCollectedCents: '12000', collectibleCents: '33000', averageCompletedCents: '16000', cancellationRateBasisPoints: 2000,
    coverage: {paymentGaps: 0, refundGaps: 0, unknownBalances: 0}
  });
  assert.equal(response.body.granularity, 'week');
  assert.deepEqual(response.body.completedValue.buckets.map(row => row.cents), ['12000', '0', '20000']);
  assert.equal(response.body.activity.buckets.reduce((sum, row) => sum + row.completed, 0), 2);
  assert.deepEqual(response.body.comparison.range, range('2025-10-01', '2025-12-31'));
  assert.deepEqual(response.body.comparison.basis, {unit: 'month', count: 3});
  assert.equal(response.body.comparison.summary.collectedCents, '10000');
  assert.equal(response.body.comparison.summary.bookingsReceived, 2);
  assert.deepEqual(response.body.comparison.growth.collectedCents, {kind: 'percent', basisPoints: '11000'});
  assert.deepEqual(response.body.comparison.growth.bookingsReceived, {kind: 'percent', basisPoints: '15000'});

  const year = await f.get(endpoint + '?preset=thisYear', admin);
  assert.equal(year.status, 200);
  assert.deepEqual(year.body.range, range('2026-01-01', '2026-12-31'));
  assert.equal(year.body.summary.upcomingRides, 1);
  assert.equal(year.body.summary.collectedCents, '31000');
  assert.equal(year.body.activity.buckets.length, 12);
  assert.equal(year.body.completedValue.buckets.length, 12);

  const trip = await f.get(endpoint + '/trips?' + quarter + '&search=' + c.reference.toLowerCase(), admin);
  assert.equal(trip.status, 200);
  assert.deepEqual(trip.body.trips.map(row => [row.reference, row.pickupDate, row.paymentStatus, row.capturedCents]),
    [[c.reference, '2026-03-31', 'partially_paid', '10000']]);
});

test('PostgreSQL local days include leap day and both sides of DST changes', pg, async t => {
  const f = await analyticsFixture(t);
  const cases = [
    ['2024-02-29T04:59:59Z', '2024-02-28T17:00:00Z'], ['2024-02-29T05:00:00Z', '2024-02-29T17:00:00Z'],
    ['2026-03-08T04:59:59Z', '2026-03-07T17:00:00Z'], ['2026-03-08T05:00:00Z', '2026-03-08T06:30:00Z'],
    ['2026-03-09T03:59:59Z', '2026-03-09T03:59:59Z'], ['2026-03-09T04:00:00Z', '2026-03-09T04:00:00Z'],
    ['2026-11-01T04:00:00Z', '2026-11-01T05:30:00Z'], ['2026-11-01T06:30:00Z', '2026-11-01T06:30:00Z'],
    ['2026-11-02T04:59:59Z', '2026-11-02T04:59:59Z'], ['2026-11-02T05:00:00Z', '2026-11-02T05:00:00Z']
  ];
  for (const [createdAt, pickupAt] of cases) await f.trip({createdAt, pickupAt, status: 'completed'});
  const admin = await f.adminLogin();
  for (const [day, expected] of [['2024-02-29', 1], ['2026-03-08', 2], ['2026-11-01', 3]]) {
    const query = dateQuery(day, day);
    const data = (await f.get(endpoint + '?' + query, admin)).body;
    assert.equal(data.summary.bookingsReceived, expected);
    assert.equal(data.summary.completedRides, expected);
    const trips = (await f.get(endpoint + '/trips?' + query, admin)).body.trips;
    assert.deepEqual(trips.map(row => row.pickupDate), Array(expected).fill(day));
  }
});

test('signed Stripe replay produces one capture and unsettled payments stay out of collected funds', pg, async t => {
  const f = await analyticsFixture(t);
  const result = await f.post('/api/checkout', {...guestBooking, paymentChoice: 'now'});
  assert.equal(result.status, 200);
  const session = [...f.h.state.sessions.values()][0];
  session.status = 'complete';
  session.payment_status = 'paid';
  const first = await f.h.webhook(session);
  const replay = await f.h.webhook(session);
  assert.deepEqual([first.status, replay.status], [200, 200]);
  const count = await f.pool.query('SELECT count(*)::int FROM er_payment_ledger WHERE booking_id=$1', [result.body.bookingId]);
  assert.equal(count.rows[0].count, 1);
  await f.reserve(null, {...guestBooking, time: '15:00'});
  const admin = await f.adminLogin();
  const report = await f.get(endpoint + '?preset=today', admin);
  assert.equal(report.status, 200);
  assert.equal(report.body.summary.bookingsReceived, 2);
  assert.equal(report.body.summary.collectedCents, String(session.amount_total));
  assert.equal(report.body.summary.netCollectedCents, String(session.amount_total));
});

test('duplicate refund identifiers count once and pending attempts never become completed refunds', pg, async t => {
  const f = await analyticsFixture(t);
  const customer = await f.register();
  assert.ok(customer);
  const {rows: [owner]} = await f.pool.query('SELECT id FROM er_customers');
  const a = await f.trip({status: 'cancelled', capture: 15000, fareCents: 15000, refundStatus: 'confirmed'});
  const duplicate = await f.legacyRefund(a, owner.id, {confirmedAt: '2026-03-10T17:00:00Z'});
  await f.managedRefund(a, {stripeRefundId: duplicate.refundId});
  const b = await f.trip({status: 'cancelled', capture: 15000, fareCents: 15000});
  await f.managedRefund(b, {state: 'provider_identified', evidence: 'provider_pending'});
  const c = await f.trip({status: 'cancelled', capture: 15000, fareCents: 15000, refundStatus: 'confirmed'});
  await f.legacyRefund(c, owner.id, {amount: 4500, confirmedAt: '2026-03-11T17:00:00Z'});
  const admin = await f.adminLogin();
  const data = (await f.get(endpoint + '?' + dateQuery('2026-03-01', '2026-03-31'), admin)).body;
  assert.equal(data.summary.collectedCents, '0');
  assert.equal(data.summary.refundsCents, '19500');
  assert.equal(data.summary.netCollectedCents, '-19500');
  const trips = (await f.get(endpoint + '/trips?' + dateQuery('2026-03-01', '2026-03-31'), admin)).body.trips;
  assert.deepEqual(trips.find(row => row.id === a.id).refundedCents, '15000');
  assert.deepEqual(trips.find(row => row.id === b.id).paymentStatus, 'processing');
  assert.deepEqual(trips.find(row => row.id === c.id).paymentStatus, 'partially_refunded');
  assert.deepEqual(trips.find(row => row.id === c.id).refundedCents, '4500');
});

test('unresolved refunds make affected periods and lifetime trip refunds unavailable until confirmed', pg, async t => {
  const f = await analyticsFixture(t);
  f.setNow('2026-04-15T16:00:00Z');
  await f.register();
  const {rows: [owner]} = await f.pool.query('SELECT id FROM er_customers');
  const settled = await f.trip({status: 'cancelled', capture: 15000});
  await f.managedRefund(settled);
  const waiting = await f.trip({status: 'cancelled', capture: 15000});
  const legacy = await f.legacyRefund(waiting, owner.id, {state: 'provider_identified',
    evidence: 'provider_succeeded_awaiting_webhook', submittedAt: '2026-04-05T16:00:00Z'});
  const timedOut = await f.trip({status: 'cancelled', capture: 15000});
  const managed = await f.managedRefund(timedOut, {state: 'submitted_unknown', evidence: 'ambiguous_provider_error',
    createdAt: '2026-04-02T16:00:00Z'});
  const admin = await f.adminLogin();
  const summary = async (from, to) => (await f.get(endpoint + '?' + dateQuery(from, to), admin)).body.summary;
  assert.equal((await summary('2026-03-01', '2026-03-31')).refundsCents, '15000');
  const april = await summary('2026-04-01', '2026-04-30');
  assert.equal(april.refundsCents, null);
  assert.equal(april.netCollectedCents, null);
  assert.equal(april.coverage.refundGaps, 2);
  assert.equal((await summary('2026-05-01', '2026-05-31')).refundsCents, '0');
  const trips = (await f.get(endpoint + '/trips?' + dateQuery('2026-03-01', '2026-03-31'), admin)).body.trips;
  assert.equal(trips.find(row => row.id === waiting.id).refundedCents, null);
  assert.equal(trips.find(row => row.id === timedOut.id).refundedCents, null);

  await f.pool.query("UPDATE er_reservation_refunds SET state='confirmed', evidence='webhook_confirmed', confirmed_at=$2 WHERE id=$1",
    [legacy.id, '2026-04-06T16:00:00Z']);
  await f.pool.query("UPDATE er_managed_cancellations SET state='failed', evidence='provider_failed' WHERE id=$1", [managed.id]);
  const reconciled = await summary('2026-04-01', '2026-04-30');
  assert.equal(reconciled.refundsCents, '15000');
  assert.equal(reconciled.netCollectedCents, '-15000');
  assert.equal(reconciled.coverage.refundGaps, 0);
});

test('historical gaps and undated verified partial refunds remain unavailable in affected periods', pg, async t => {
  const f = await analyticsFixture(t);
  const legacy = await f.trip({legacy: true, legacyPaid: true, capture: 15000, omitPaidAt: true,
    createdAt: '2026-01-10T17:00:00Z', pickupDate: '2026-01-14', status: 'completed'});
  const paid = await f.trip({status: 'cancelled', capture: 20000, fareCents: 20000});
  await f.managedRefund(paid, {before: 5000, amount: 15000, confirmedAt: '2026-04-01T16:00:00Z'});
  const admin = await f.adminLogin();
  const jan = (await f.get(endpoint + '?' + dateQuery('2026-01-01', '2026-01-31'), admin)).body;
  assert.equal(jan.summary.collectedCents, null);
  assert.equal(jan.summary.completedValueCents, '15000');
  assert.equal(jan.summary.coverage.paymentGaps, 1);
  const march = (await f.get(endpoint + '?' + dateQuery('2026-03-01', '2026-03-31'), admin)).body;
  assert.equal(march.summary.refundsCents, null);
  assert.equal(march.summary.netCollectedCents, null);
  assert.equal(march.summary.coverage.refundGaps, 1);
  const april = (await f.get(endpoint + '?' + dateQuery('2026-04-01', '2026-04-30'), admin)).body;
  assert.equal(april.summary.refundsCents, '15000');
  const trips = (await f.get(endpoint + '/trips?' + dateQuery('2026-01-01', '2026-03-31'), admin)).body.trips;
  assert.equal(trips.find(row => row.id === legacy.id).capturedCents, null);
  assert.equal(trips.find(row => row.id === paid.id).refundedCents, '20000');
});

test('report pagination, filters, sorting and CSV use the same authorized dataset', pg, async t => {
  const f = await analyticsFixture(t);
  const a = await f.trip({status: 'completed', fareCents: 13000, pickup: '=1+1'});
  const b = await f.trip({status: 'completed', fareCents: 9500, pickup: 'Apt "B", Sample Avenue'});
  await f.trip({status: 'completed', fareCents: 8500, vehicle: 'escalade'});
  await f.trip({status: 'cancelled', fareCents: 7500});
  const query = dateQuery('2026-03-01', '2026-03-31', {status: 'completed', payment: 'unpaid', vehicle: 'suv', sort: 'fare', order: 'asc'});
  const account = await f.register();
  for (const path of [endpoint, endpoint + '/trips?' + query, endpoint + '/trips.csv?' + query]) {
    assert.equal((await f.get(path)).status, 401);
    assert.equal((await f.get(path, account)).status, 401);
  }
  const admin = await f.adminLogin();
  const cross = await f.h.request(endpoint + '/trips.csv?' + query, undefined, {cookie: admin, 'sec-fetch-site': 'cross-site'});
  assert.equal(cross.status, 403);
  const first = await f.get(endpoint + '/trips?' + query + '&limit=1', admin);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.trips.map(trip => trip.reference), [b.reference]);
  assert.equal(first.body.hasNext, true);
  const second = await f.get(endpoint + '/trips?' + query + '&limit=1&page=2', admin);
  assert.deepEqual(second.body.trips.map(trip => trip.reference), [a.reference]);
  assert.equal(second.body.hasNext, false);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(JSON.stringify(first.body), /rider@example|2015550140|stripeSessionId|customerAccess/);

  const csv = await f.get(endpoint + '/trips.csv?' + query, admin);
  assert.equal(csv.status, 200, JSON.stringify(csv.body));
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="er-dispatch-trips-2026-03-01_2026-03-31\.csv"/);
  assert.equal(csv.headers.get('cache-control'), 'no-store');
  const lines = csv.body.trimEnd().split('\r\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[1].startsWith('"' + b.reference + '"'));
  assert.ok(lines[2].startsWith('"' + a.reference + '"'));
  assert.match(lines[1], /"Apt ""B"", Sample Avenue"/);
  assert.match(lines[2], /"'=1\+1"/);
  assert.doesNotMatch(csv.body, /rider@example|2015550140|cs_|pi_/);
  const rejected = await f.get(endpoint + '/trips.csv?' + query + '&page=1', admin);
  assert.equal(rejected.status, 400);
  const literal = await f.get(endpoint + '/trips?' + query + '&search=%25', admin);
  assert.equal(literal.body.trips.length, 0);
});

test('CSV streams every matching row across cursor batches and keeps spreadsheet fields private', pg, async t => {
  const f = await analyticsFixture(t);
  const seed = await f.trip({pickup: 'Synthetic export fixture'});
  await f.pool.query(
    'INSERT INTO er_reservations(id,record,created_at,scheduled_start_at,scheduled_end_at,booking_reference) ' +
    "SELECT id,jsonb_set($1::jsonb,'{id}',to_jsonb(id)),$2,$3,$3,'ER-' || (700000+n) " +
    'FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1,253) n) fixture',
    [seed.record, seed.record.createdAt, seed.pickupAt]);
  const admin = await f.adminLogin();
  const query = dateQuery('2026-03-15', '2026-03-15', {search: 'Synthetic export fixture', sort: 'reference', order: 'asc'});
  const csv = await f.get(endpoint + '/trips.csv?' + query, admin);
  assert.equal(csv.status, 200);
  const lines = csv.body.trimEnd().split('\r\n');
  assert.equal(lines.length, 255);
  assert.ok(lines[1].startsWith('"' + seed.reference + '"'));
  assert.ok(lines.at(-1).startsWith('"ER-700253"'));
  assert.doesNotMatch(csv.body, /rider@example|2015550140|customerAccess/);
  const empty = await f.get(endpoint + '/trips.csv?' + query.replace('Synthetic+export+fixture', 'No+match'), admin);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.trimEnd().split('\r\n').length, 1);
});
