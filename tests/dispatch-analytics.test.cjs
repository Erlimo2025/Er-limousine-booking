'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {randomUUID} = require('node:crypto');
const {summaryInput, tripsInput, summaryResult, csvHeader, csvTrip} = require('../services/dispatch-analytics');
const {analyticsFixture, dateQuery, endpoint} = require('./helpers/dispatch-analytics.cjs');
const {guestBooking} = require('./helpers/reservation-management.cjs');

const pg = {skip: !process.env.ER_TEST_DATABASE_URL && 'Requires an isolated PostgreSQL test database'};
const now = Date.parse('2026-01-01T04:59:59.999Z');
const range = (from, to = from) => ({from, to});
const financialCsvHeader = 'Booking reference,Pickup date (New York),Vehicle,Reservation status,Payment status,' +
  'Accepted fare (USD),Captured payments (USD),Refunded amount (USD)';

function expectedFinancialCsvRow(trip, amounts) {
  const textFields = [trip.reference, trip.pickupDate, trip.vehicleLabel, trip.status, trip.paymentStatus];
  return [...textFields.map(value => '"' + value + '"'), ...amounts].join(',');
}

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

test('Financial CSV omits addresses and escapes retained formula, quote and comma fields', () => {
  assert.equal(csvHeader, financialCsvHeader + '\r\n');
  const result = csvTrip({reference: '\u2060=1+1', pickupDate: '2026-11-11', pickup: '1 Example Place, Newark, NJ',
    destination: '2 Sample Avenue, New York, NY', vehicleLabel: 'Luxury "SUV", Suburban', status: 'confirmed',
    paymentStatus: 'review', fareCents: '900719925474099195', capturedCents: null, refundedCents: '0'});
  assert.equal(result, "\"'\u2060=1+1\"" +
    ',"2026-11-11","Luxury ""SUV"", Suburban","confirmed","review",9007199254740991.95,Unavailable,0.00\r\n');
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

test('Analytics uses current payment reviews and ignores replaced sessions or attempts', pg, async t => {
  const f = await analyticsFixture(t);
  const checkedAt = Date.parse('2026-03-10T16:00:00Z');
  const cases = [
    {review: 'session_mismatch', expected: 'review'},
    {review: 'provider_unavailable', expected: 'review'},
    {review: 'session_unidentified', withoutSession: true, expected: 'review'},
    {review: 'payment_pending', sessionOnly: true, expected: 'processing'},
    {review: 'paid_awaiting_webhook', sessionOnly: true, expected: 'processing'},
    {review: 'session_mismatch', staleSession: true, expected: 'unpaid'},
    {review: 'paid_awaiting_webhook', staleAttempt: true, expected: 'unpaid'},
    {review: 'session_open', expected: 'unpaid'},
    {review: 'expired_unpaid', expected: 'unpaid'},
    {review: 'expired_unpaid', paymentStatus: 'failed', expected: 'failed'}
  ];
  const expected = new Map();
  for (const entry of cases) {
    const trip = await f.trip({status: 'awaiting_payment', paymentStatus: entry.paymentStatus});
    const stripeSessionId = entry.withoutSession ? null : 'cs_' + trip.id.replaceAll('-', '');
    const checkoutAttempt = entry.sessionOnly ? null : {
      key: trip.id, expiresAt: checkedAt / 1000 + 3600, firstSubmittedAt: checkedAt - 60_000, submissionCount: 1,
      quote: trip.record.quote, state: entry.withoutSession ? 'submitted_unknown' : 'session_identified'
    };
    const paymentConfirmationReview = {
      status: entry.review, lastResult: entry.review, checkedAt, paymentIntentId: null,
      sessionId: entry.staleSession ? 'cs_previous_session' : stripeSessionId,
      attemptKey: entry.staleAttempt ? 'previous-attempt' : checkoutAttempt?.key ?? null
    };
    await f.pool.query('UPDATE er_reservations SET record=$2 WHERE id=$1', [trip.id, {
      ...trip.record, stripeSessionId, paymentConfirmationReview, ...(checkoutAttempt ? {checkoutAttempt} : {})
    }]);
    const unsettled = ['review', 'processing'].includes(entry.expected);
    expected.set(trip.id, {status: entry.expected, capturedCents: unsettled ? null : '0', reference: trip.reference});
  }

  const admin = await f.adminLogin();
  const query = dateQuery('2026-03-01', '2026-03-31');
  const summary = await f.get(endpoint + '?' + query, admin);
  assert.equal(summary.status, 200);
  assert.equal(summary.body.summary.collectedCents, null);
  assert.equal(summary.body.summary.netCollectedCents, null);
  assert.equal(summary.body.summary.collectibleCents, null);
  assert.deepEqual(summary.body.summary.coverage, {paymentGaps: 5, refundGaps: 0, unknownBalances: 5});
  const trips = await f.get(endpoint + '/trips?' + query, admin);
  assert.equal(trips.status, 200);
  assert.deepEqual(new Map(trips.body.trips.map(row => [row.id, {
    status: row.paymentStatus, capturedCents: row.capturedCents, reference: row.reference
  }])), expected);
  const reviewCsv = await f.get(endpoint + '/trips.csv?' + query + '&payment=review', admin);
  assert.equal(reviewCsv.status, 200);
  const rows = reviewCsv.body.trimEnd().split('\r\n').slice(1);
  assert.deepEqual(rows.map(row => row.split(',')[0].slice(1, -1)).sort(),
    [...expected.values()].filter(row => row.status === 'review').map(row => row.reference).sort());
  assert.ok(rows.every(row => row.includes(',"review",150.00,Unavailable,0.00')));
});

for (const recoveryStatus of ['payment_pending', 'paid_awaiting_webhook']) {
  test('Analytics reports Paid after signed confirmation of ordinary ' + recoveryStatus, pg, async t => {
    const f = await analyticsFixture(t);
    const checkout = await f.post('/api/checkout', {...guestBooking, paymentChoice: 'now'});
    assert.equal(checkout.status, 200);
    const id = checkout.body.bookingId;
    const [session] = f.h.state.sessions.values();
    session.status = 'complete';
    session.payment_status = recoveryStatus === 'payment_pending' ? 'unpaid' : 'paid';
    if (recoveryStatus === 'payment_pending') {
      assert.equal((await f.h.webhook(session)).status, 200);
    } else {
      f.h.advance(31 * 60_000);
      await f.h.context.runPaymentConfirmationRecovery();
      assert.equal((await f.store.get(id)).paymentConfirmationReview.status, recoveryStatus);
    }
    const waiting = await f.store.get(id);
    assert.equal(waiting.paymentStatus, 'unpaid');
    assert.equal(waiting.checkoutAttempt.version, undefined);
    const admin = await f.adminLogin();
    const query = dateQuery('2026-10-01', guestBooking.date);
    const trips = await f.get(endpoint + '/trips?' + query + '&payment=processing', admin);
    assert.equal(trips.status, 200);
    assert.deepEqual(trips.body.trips.map(row => [row.id, row.paymentStatus, row.capturedCents]), [[id, 'processing', null]]);
    const unconfirmed = await f.get(endpoint + '?' + query, admin);
    assert.equal(unconfirmed.body.summary.collectedCents, null);
    assert.equal(unconfirmed.body.summary.collectibleCents, null);

    session.payment_status = 'paid';
    const event = recoveryStatus === 'payment_pending' ? 'checkout.session.async_payment_succeeded' : 'checkout.session.completed';
    assert.equal((await f.h.webhook(session, event)).status, 200);
    assert.equal((await f.h.webhook(session, event)).status, 200);
    assert.equal((await f.h.webhook({...session, payment_status: 'unpaid'}, 'checkout.session.async_payment_failed')).status, 200);
    const settled = await f.store.get(id);
    assert.equal(settled.checkoutAttempt.evidence, waiting.checkoutAttempt.evidence);
    assert.deepEqual(settled.quote, waiting.quote);
    const {rows: ledger} = await f.pool.query('SELECT amount_cents::text FROM er_payment_ledger WHERE booking_id=$1', [id]);
    const cents = String(session.amount_total);
    assert.deepEqual(ledger, [{amount_cents: cents}]);

    const paid = await f.get(endpoint + '/trips?' + query + '&payment=paid', admin);
    assert.equal(paid.status, 200);
    assert.deepEqual(paid.body.trips.map(row => [row.id, row.paymentStatus, row.capturedCents]), [[id, 'paid', cents]]);
    const csv = await f.get(endpoint + '/trips.csv?' + query + '&payment=paid', admin);
    assert.equal(csv.status, 200);
    const amounts = (session.amount_total / 100).toFixed(2);
    const csvRows = csv.body.trimEnd().split('\r\n').slice(1);
    assert.equal(csvRows.length, 1);
    assert.ok(csvRows[0].startsWith('"' + paid.body.trips[0].reference + '",'));
    assert.ok(csvRows[0].endsWith(',"paid",' + amounts + ',' + amounts + ',0.00'));
    const summary = await f.get(endpoint + '?' + query, admin);
    assert.equal(summary.status, 200);
    assert.equal(summary.body.summary.collectedCents, cents);
    assert.equal(summary.body.summary.netCollectedCents, cents);
    assert.equal(summary.body.summary.collectibleCents, '0');
    assert.deepEqual(summary.body.summary.coverage, {paymentGaps: 0, refundGaps: 0, unknownBalances: 0});
  });
}

test('verified settlement ignores stale Checkout processing and preserves refund and cancellation review states', pg, async t => {
  const f = await analyticsFixture(t);
  const checkoutAttempt = {state: 'session_identified', evidence: 'verified_paid_awaiting_webhook'};
  const full = await f.trip({status: 'cancelled', fareCents: 15000, capture: 15000, checkoutAttempt});
  await f.managedRefund(full);
  const partial = await f.trip({status: 'cancelled', fareCents: 15000, capture: 15000, checkoutAttempt});
  await f.register();
  const {rows: [owner]} = await f.pool.query('SELECT id FROM er_customers');
  await f.legacyRefund(partial, owner.id, {amount: 4500});
  const pending = await f.trip({status: 'cancelled', fareCents: 15000, capture: 15000, checkoutAttempt});
  await f.managedRefund(pending, {state: 'provider_identified', evidence: 'provider_pending'});
  const review = await f.trip({status: 'cancelled', fareCents: 15000, capture: 15000, paymentReviewRequired: true, checkoutAttempt});
  const admin = await f.adminLogin();
  const trips = await f.get(endpoint + '/trips?' + dateQuery('2026-03-01', '2026-03-31'), admin);
  assert.equal(trips.status, 200);
  assert.deepEqual(new Map(trips.body.trips.map(row => [row.id, [row.paymentStatus, row.capturedCents, row.refundedCents]])), new Map([
    [full.id, ['refunded', '15000', '15000']], [partial.id, ['partially_refunded', '15000', '4500']],
    [pending.id, ['processing', '15000', '0']], [review.id, ['review', '15000', '0']]
  ]));
  const partialRow = trips.body.trips.find(row => row.id === partial.id);
  assert.equal(partialRow.fareCents, '15000');
  const csvQuery = dateQuery('2026-03-01', '2026-03-31', {payment: 'partially_refunded'});
  const csv = await f.get(endpoint + '/trips.csv?' + csvQuery, admin);
  assert.equal(csv.status, 200);
  assert.equal(csv.body, [financialCsvHeader, expectedFinancialCsvRow(partialRow, ['150.00', '150.00', '45.00']), ''].join('\r\n'));
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

test('Charts reconciles verified New York collections by day and saved service with bounded pickup rows', pg, async t => {
  const f = await analyticsFixture(t);
  const entries = [
    ['airport', 'EWR_MANHATTAN_SUV', 15000, '2026-03-01T05:00:00Z', 'confirmed'],
    ['airport', null, 12501, '2026-03-08T04:59:59Z', 'cancelled'],
    ['hourly', null, 30000, '2026-03-08T07:00:00Z', 'completed'],
    ['roundtrip', null, 7500, '2026-04-01T03:59:59Z', 'confirmed'],
    ['unsupported', null, 1999, '2026-03-18T15:35:00Z', 'confirmed'],
    ['oneway', null, 1111, '2026-03-01T04:59:59Z', 'confirmed'],
    ['oneway', null, 2222, '2026-04-01T04:00:00Z', 'confirmed']
  ];
  const trips = [];
  for (const [index, [tripType, offerCode, amount, paidAt, status]] of entries.entries()) {
    const day = String(index + 4).padStart(2, '0');
    const row = await f.trip({status, pickupAt: '2026-03-' + day + 'T17:30:00Z',
      fareCents: amount, capture: amount, paidAt});
    const record = {...row.record, trip: {...row.record.trip, tripType}};
    if (offerCode) record.quote = {...record.quote, fixedOffer: {code: offerCode}};
    await f.pool.query('UPDATE er_reservations SET record=$2 WHERE id=$1', [row.id, record]);
    trips.push(row);
  }
  trips.push(await f.trip({status: 'awaiting_payment', fareCents: 4444, createdAt: '2026-03-02T15:00:00Z',
    pickupAt: '2026-03-11T17:30:00Z'}));

  const admin = await f.adminLogin();
  const query = dateQuery('2026-03-01', '2026-03-31');
  const result = await f.get(endpoint + '/charts?' + query, admin);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const data = result.body;
  assert.deepEqual(data.range, range('2026-03-01', '2026-03-31'));
  assert.equal(data.timeZone, 'America/New_York');
  assert.deepEqual(data.summary, {
    collectedCents: '67000', netCollectedCents: '67000', grossAcceptedCents: '4444',
    collectibleCents: '4444', paidReservations: 7, processingReservations: 0,
    cancelledReservations: 1, refundsCents: '0', refundEvents: 0
  });
  const summary = (await f.get(endpoint + '?' + query, admin)).body.summary;
  for (const metric of ['collectedCents', 'netCollectedCents', 'grossAcceptedCents', 'collectibleCents', 'refundsCents']) {
    assert.equal(data.summary[metric], summary[metric]);
  }
  assert.equal(data.trend.granularity, 'day');
  assert.equal(data.trend.buckets.length, 31);
  assert.deepEqual(data.trend.buckets.filter(bucket => bucket.collectedCents !== '0').map(bucket => [bucket.from, bucket.collectedCents]),
    [['2026-03-01', '15000'], ['2026-03-07', '12501'], ['2026-03-08', '30000'], ['2026-03-18', '1999'], ['2026-03-31', '7500']]);
  assert.equal(data.trend.buckets.reduce((total, bucket) => total + BigInt(bucket.collectedCents), 0n), 67000n);
  assert.deepEqual(new Map(data.services.map(row => [row.service, row.cents])), new Map([
    ['ewr-manhattan', '15000'], ['airport', '12501'], ['hourly', '30000'], ['point-to-point', '7500'], ['unclassified', '1999']
  ]));
  assert.equal(data.services.reduce((total, row) => total + BigInt(row.cents), 0n), 67000n);
  assert.deepEqual(data.paymentStatuses, {
    paid: 7, unpaid: 1, processing: 0, review: 0, refunded: 0, partially_refunded: 0, partially_paid: 0, failed: 0
  });
  assert.equal(data.reservationCount, 8);
  assert.deepEqual(data.recent.map(row => row.reference), trips.slice(-5).reverse().map(row => row.reference));
  assert.deepEqual(data.recent.map(row => row.service), ['point-to-point', 'point-to-point', 'point-to-point', 'unclassified', 'point-to-point']);
  assert.equal(new Date(data.recent[0].pickupAt).toISOString(), '2026-03-11T17:30:00.000Z');
  assert.equal(data.recent[0].fareCents, '4444');
  assert.equal(data.recent[0].paymentStatus, 'unpaid');
  assert.deepEqual(Object.keys(data.recent[0]).sort(),
    ['archived', 'fareCents', 'id', 'paymentStatus', 'pickupAt', 'pickupDate', 'reference', 'service', 'status']);
  assert.doesNotMatch(JSON.stringify(data), /rider@example|2015550140|Example Place|stripeSession|checkoutAttempt|cs_/);

  const year = (await f.get(endpoint + '/charts?preset=thisYear', admin)).body;
  assert.equal(year.trend.granularity, 'month');
  assert.equal(year.trend.buckets.length, 12);
  assert.equal(year.summary.collectedCents, '70333');
  assert.equal(year.trend.buckets.reduce((total, bucket) => total + BigInt(bucket.collectedCents), 0n), 70333n);
});

test('Charts preserves M-05 pending and review states and distinguishes incomplete evidence from an empty range', pg, async t => {
  const f = await analyticsFixture(t);
  await f.trip({fareCents: 5000, capture: 5000, paidAt: '2026-03-15T16:00:00Z'});
  for (const status of ['paid_awaiting_webhook', 'provider_unavailable']) {
    const trip = await f.trip({status: 'awaiting_payment'});
    const session = 'cs_' + trip.id.replaceAll('-', '');
    const review = {status, lastResult: status, sessionId: session, attemptKey: null, paymentIntentId: null,
      checkedAt: Date.parse('2026-03-12T17:00:00Z')};
    await f.pool.query('UPDATE er_reservations SET record=$2 WHERE id=$1', [trip.id,
      {...trip.record, stripeSessionId: session, paymentConfirmationReview: review}]);
  }
  for (let index = 0; index < 2; index++) {
    await f.trip({fareCents: 4000, capture: 4000, session: 'cs_duplicate_fixture', paidAt: '2026-03-14T15:00:00Z'});
  }
  await f.trip({status: 'awaiting_payment', paymentStatus: 'failed'});
  const admin = await f.adminLogin();
  const result = await f.get(endpoint + '/charts?' + dateQuery('2026-03-01', '2026-03-31'), admin);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.summary.collectedCents, null);
  assert.equal(result.body.summary.netCollectedCents, null);
  assert.equal(result.body.summary.collectibleCents, null);
  assert.equal(result.body.summary.paidReservations, 1);
  assert.equal(result.body.summary.processingReservations, 1);
  assert.equal(result.body.paymentStatuses.review, 3);
  assert.equal(result.body.paymentStatuses.failed, 1);
  assert.equal(result.body.reservationCount, 6);
  assert.equal(result.body.trend, null);
  assert.equal(result.body.services, null);

  const empty = await f.get(endpoint + '/charts?' + dateQuery('2027-02-01', '2027-02-02'), admin);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.summary.collectedCents, '0');
  assert.equal(empty.body.summary.collectibleCents, '0');
  assert.equal(empty.body.reservationCount, 0);
  assert.deepEqual(empty.body.services, []);
  assert.deepEqual(empty.body.recent, []);
  assert.ok(empty.body.trend.buckets.every(bucket => bucket.collectedCents === '0'));
});

test('Charts counts confirmed full and partial refund events once each, separately from cancellations', pg, async t => {
  const f = await analyticsFixture(t);
  await f.register();
  const {rows: [owner]} = await f.pool.query('SELECT id FROM er_customers');
  const full = await f.trip({status: 'cancelled', fareCents: 15000, capture: 15000, paidAt: '2026-03-03T15:00:00Z'});
  const partial = await f.trip({status: 'cancelled', fareCents: 15000, capture: 15000, paidAt: '2026-03-04T15:00:00Z'});
  const confirmedAt = '2026-03-12T16:00:00Z';
  const duplicate = await f.legacyRefund(full, owner.id, {confirmedAt});
  await f.managedRefund(full, {confirmedAt, stripeRefundId: duplicate.refundId});
  await f.legacyRefund(partial, owner.id, {confirmedAt, amount: 4500});

  const admin = await f.adminLogin();
  const response = await f.get(endpoint + '/charts?' + dateQuery('2026-03-01', '2026-03-31'), admin);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const data = response.body;
  assert.equal(data.summary.refundEvents, 2);
  assert.equal(data.summary.refundsCents, '19500');
  assert.equal(data.summary.collectedCents, '30000');
  assert.equal(data.summary.netCollectedCents, '10500');
  assert.equal(data.summary.cancelledReservations, 2);
  assert.equal(data.paymentStatuses.refunded, 1);
  assert.equal(data.paymentStatuses.partially_refunded, 1);
  assert.equal(data.paymentStatuses.paid, 0);
  assert.equal(data.reservationCount, 2);
  assert.equal(Object.values(data.paymentStatuses).reduce((sum, count) => sum + count, 0), 2);
  assert.ok(!Object.hasOwn(data.paymentStatuses, 'cancelled'));
});

test('Charts requires an active Dispatch session, same origin, bounded rates and private response headers', pg, async t => {
  const f = await analyticsFixture(t);
  const path = endpoint + '/charts?' + dateQuery('2026-03-01', '2026-03-31');
  const customer = await f.register();
  assert.equal((await f.get(path)).status, 401);
  assert.equal((await f.get(path, customer)).status, 401);
  const admin = await f.adminLogin();
  const cross = await f.h.request(path, undefined, {cookie: admin, 'sec-fetch-site': 'cross-site'});
  assert.equal(cross.status, 403);
  const response = await f.get(path, admin);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal((await f.get(path + '&limit=10', admin)).status, 400);
  for (let index = 0; index < 18; index++) assert.equal((await f.get(path, admin)).status, 200);
  assert.equal((await f.get(path, admin)).status, 429);
  f.h.advance(31 * 60_000);
  assert.equal((await f.get(path, admin)).status, 401);
});

test('report pagination, filters, sorting and CSV use the same authorized dataset', pg, async t => {
  const f = await analyticsFixture(t);
  const a = await f.trip({status: 'completed', fareCents: 13000, pickup: '41 Example Plaza, Newark, NJ',
    destination: '92 Test Landing, New York, NY'});
  const b = await f.trip({status: 'completed', fareCents: 9500, pickup: '7 Sample Avenue, Jersey City, NJ',
    destination: '38 Example Street, New York, NY'});
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
  const reportTrips = [...first.body.trips, ...second.body.trips];
  assert.deepEqual(reportTrips.map(trip => [trip.pickup, trip.destination]),
    [b, a].map(({record}) => [record.trip.pickup, record.trip.dropoff]));
  assert.deepEqual(reportTrips.map(trip => [trip.fareCents, trip.capturedCents, trip.refundedCents]),
    [['9500', '0', '0'], ['13000', '0', '0']]);

  const csv = await f.get(endpoint + '/trips.csv?' + query, admin);
  assert.equal(csv.status, 200, JSON.stringify(csv.body));
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="er-dispatch-trips-2026-03-01_2026-03-31\.csv"/);
  assert.equal(csv.headers.get('cache-control'), 'no-store');
  assert.equal(csv.body, [
    financialCsvHeader,
    expectedFinancialCsvRow(reportTrips[0], ['95.00', '0.00', '0.00']),
    expectedFinancialCsvRow(reportTrips[1], ['130.00', '0.00', '0.00']),
    ''
  ].join('\r\n'));
  for (const {pickup, destination} of reportTrips) {
    assert.ok(!csv.body.includes(pickup));
    assert.ok(!csv.body.includes(destination));
  }
  assert.doesNotMatch(csv.body, /rider@example|2015550140|cs_|pi_/);
  const rejected = await f.get(endpoint + '/trips.csv?' + query + '&page=1', admin);
  assert.equal(rejected.status, 400);
  const literal = await f.get(endpoint + '/trips?' + query + '&search=%25', admin);
  assert.equal(literal.body.trips.length, 0);
});

test('CSV streams every matching row across cursor batches without exporting the searched address', pg, async t => {
  const f = await analyticsFixture(t);
  const pickup = '12 Synthetic Export Lane, Newark, NJ';
  const destination = '34 Synthetic Destination Lane, New York, NY';
  const seed = await f.trip({pickup, destination});
  const unrelated = await f.trip();
  await f.pool.query(
    'INSERT INTO er_reservations(id,record,created_at,scheduled_start_at,scheduled_end_at,booking_reference) ' +
    "SELECT id,jsonb_set($1::jsonb,'{id}',to_jsonb(id)),$2,$3,$3,'ER-' || (700000+n) " +
    'FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1,253) n) fixture',
    [seed.record, seed.record.createdAt, seed.pickupAt]);
  const admin = await f.adminLogin();
  const query = dateQuery('2026-03-15', '2026-03-15', {search: pickup, sort: 'reference', order: 'asc'});
  const report = await f.get(endpoint + '/trips?' + query + '&limit=1', admin);
  assert.equal(report.status, 200);
  assert.equal(report.body.hasNext, true);
  const [row] = report.body.trips;
  assert.equal(row.reference, seed.reference);
  assert.equal(row.pickup, pickup);
  assert.equal(row.destination, destination);

  const csv = await f.get(endpoint + '/trips.csv?' + query, admin);
  assert.equal(csv.status, 200);
  const lines = csv.body.trimEnd().split('\r\n');
  assert.equal(lines.length, 255);
  assert.equal(lines[0], financialCsvHeader);
  assert.equal(lines[1], expectedFinancialCsvRow(row, ['150.00', '0.00', '0.00']));
  assert.equal(lines.at(-1), expectedFinancialCsvRow({...row, reference: 'ER-700253'}, ['150.00', '0.00', '0.00']));
  assert.ok(!csv.body.includes(pickup));
  assert.ok(!csv.body.includes(destination));
  assert.ok(!csv.body.includes(unrelated.reference));
  assert.doesNotMatch(csv.body, /rider@example|2015550140|customerAccess/);
  const emptyQuery = dateQuery('2026-03-15', '2026-03-15', {search: 'No match', sort: 'reference', order: 'asc'});
  const empty = await f.get(endpoint + '/trips.csv?' + emptyQuery, admin);
  assert.equal(empty.status, 200);
  assert.equal(empty.body, financialCsvHeader + '\r\n');
});

// Exercise the installed route's transport callbacks without timers or sockets:
// res.end queues a response, while finish/close are separate observable outcomes.
function csvAuditHarness({exporter, authenticated = true, crossOrigin = false,
  rateLimited = false, query = {}, writeError = false, sinkError = false} = {}) {
  const {installDispatchAnalytics} = require('../routes/dispatch-analytics');
  const {createDispatchSecurityLogger} = require('../services/dispatch-security-logging');
  const routes = new Map(), lines = [];
  const actorId = randomUUID();
  let allowed = authenticated, calls = 0;
  const req = Object.assign(new EventEmitter(), {
    referenceId: randomUUID(), method: 'GET', aborted: false,
    originalUrl: '/api/admin/business-analytics/trips.csv?search=PRIVATE-SEARCH',
    query: {from: '2026-03-01', to: '2026-03-31', ...query},
    get(name) {return {origin: crossOrigin ? 'https://PRIVATE-ORIGIN.example.test' : 'https://er.example.test',
      'sec-fetch-site': crossOrigin ? 'cross-site' : 'same-origin', cookie: 'PRIVATE-COOKIE'}[name];}
  });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200, headers: {}, chunks: [], headersSent: false, destroyed: false, writableFinished: false,
    set(name, value) {if (typeof name === 'object') Object.assign(this.headers, name);else this.headers[name] = value;return this;},
    status(value) {this.statusCode = value;return this;},
    attachment(value) {this.filename = value;return this;},
    write(value, callback) {this.headersSent = true;this.chunks.push(value);callback(writeError ? new Error('PRIVATE-WRITE-ERROR') : undefined);},
    end() {this.ended = true;return this;},
    json(value) {this.body = value;return this.end();},
    destroy() {this.destroyed = true;this.emit('close');return this;}
  });
  const securityEvent = createDispatchSecurityLogger({
    write: line => {if (sinkError) throw new Error('PRIVATE-SINK-ERROR');lines.push(line);},
    now: () => Date.parse('2026-11-17T17:00:00.000Z')
  });
  const route = handler => async (request, response) => {
    try {await handler(request, response);}
    catch (_) {if (response.headersSent) response.destroy();else response.status(503).json({error: 'Unavailable'});}
  };
  installDispatchAnalytics({get(path, ...handlers) {routes.set(path, handlers);}}, {
    store: {async exportDispatchAnalyticsTrips(...args) {calls++;return exporter ? exporter(...args) : args[2]([]);}},
    route, securityEvent, siteUrl: 'https://er.example.test', now: () => Date.parse('2026-11-17T17:00:00.000Z'),
    requireAdmin(request, response, next) {
      if (!allowed) return response.status(401).json({error: 'Unauthorized'});
      request.adminArchiveAuthority = {actorId, authorized: () => allowed};
      return next();
    },
    rateLimit: () => (request, response, next) => rateLimited
      ? response.status(429).json({error: 'Too many requests'}) : next()
  });
  const handlers = routes.get(endpoint + '/trips.csv');
  async function invoke(index = 0) {
    if (index >= handlers.length) return;
    let following;
    await handlers[index](req, res, () => {following = invoke(index + 1);return following;});
    await following;
  }
  return {req, res, actorId, run: invoke, calls: () => calls,
    entries: () => lines.map(line => JSON.parse(line)), text: () => lines.join('\n'),
    revoke: () => {allowed = false;},
    finish: () => {res.writableFinished = true;res.emit('finish');res.emit('close');}};
}

const auditedCsvTrip = {reference: 'ER-510001', pickupDate: '2026-03-15', vehicleLabel: 'Luxury SUV',
  status: 'completed', paymentStatus: 'partially_refunded', fareCents: '15000', capturedCents: '15000', refundedCents: '4500'};

test('financial CSV audit waits for finish and records exactly one completed terminal event', async () => {
  const f = csvAuditHarness({exporter: async (input, active, send) => {assert.equal(await active(), true);await send([auditedCsvTrip]);}});
  await f.run();
  assert.equal(f.res.ended, true);
  assert.equal(f.entries().length, 0, 'Calling end is not evidence that a stream finished');
  assert.equal(f.res.chunks.join(''), csvHeader + csvTrip(auditedCsvTrip));
  f.finish();
  assert.equal(f.entries().length, 1);
  assert.deepEqual(f.entries()[0], {timestamp: '2026-11-17T17:00:00.000Z', referenceId: f.req.referenceId,
    operation: 'admin', category: 'dispatch_security', action: 'financial_csv_export', outcome: 'completed', actorId: f.actorId});
  assert.equal(Object.hasOwn(f.entries()[0], 'recordId'), false);
  assert.doesNotMatch(f.text(), /PRIVATE-|510001|2026-03|15000|4500|partially_refunded/);
  const empty = csvAuditHarness();
  await empty.run();empty.finish();
  assert.equal(empty.res.chunks.join(''), csvHeader);
  assert.equal(empty.entries()[0].outcome, 'completed');
});

test('financial CSV audit distinguishes client interruption and in-flight session revocation', async () => {
  let interrupted;
  interrupted = csvAuditHarness({exporter: async (input, active, send) => {
    await send([auditedCsvTrip]);interrupted.req.aborted = true;interrupted.res.destroy();
  }});
  await interrupted.run();
  interrupted.res.emit('close');
  assert.equal(interrupted.entries().length, 1);
  assert.equal(interrupted.entries()[0].outcome, 'interrupted');
  assert.equal(interrupted.entries()[0].actorId, interrupted.actorId);

  for (const afterChunk of [false, true]) {
    let revoked;
    revoked = csvAuditHarness({exporter: async (input, active, send) => {
      if (afterChunk) await send([auditedCsvTrip]);
      revoked.revoke();assert.equal(await active(), false);
    }});
    await revoked.run();
    if (!afterChunk) {assert.equal(revoked.res.statusCode, 401);revoked.finish();}
    assert.equal(revoked.entries().length, 1);
    assert.equal(revoked.entries()[0].outcome, 'interrupted');
    assert.equal(revoked.entries()[0].actorId, revoked.actorId);
  }
});

test('financial CSV audit records failed query, partial-stream and write errors without error details', async () => {
  for (const failure of ['before_rows', 'after_rows', 'write']) {
    const f = csvAuditHarness({writeError: failure === 'write', exporter: async (input, active, send) => {
      if (failure !== 'before_rows') await send([auditedCsvTrip]);
      if (failure !== 'write') throw new Error('PRIVATE-STORAGE-ERROR');
    }});
    await f.run();
    if (!f.res.destroyed) f.finish();
    assert.equal(f.entries().length, 1);
    assert.equal(f.entries()[0].outcome, 'failed');
    assert.doesNotMatch(f.text(), /PRIVATE-|message|stack|search|cookie|url/);
  }
});

test('financial CSV audit retains initial denial and validation responses without claiming completion', async () => {
  for (const option of [{authenticated: false}, {crossOrigin: true}, {rateLimited: true}]) {
    const f = csvAuditHarness(option);
    await f.run();f.finish();
    assert.equal(f.calls(), 0);
    assert.ok([401, 403, 429].includes(f.res.statusCode));
    assert.equal(f.entries().length, 1);
    assert.equal(f.entries()[0].outcome, 'denied');
    assert.doesNotMatch(f.text(), /PRIVATE-/);
  }
  const invalid = csvAuditHarness({query: {page: '1'}});
  await invalid.run();invalid.finish();
  assert.equal(invalid.res.statusCode, 400);
  assert.equal(invalid.calls(), 0);
  assert.equal(invalid.entries().length, 1);
  assert.equal(invalid.entries()[0].outcome, 'failed');
});

test('financial CSV content and completion remain available if the security log sink fails', async () => {
  const f = csvAuditHarness({sinkError: true});
  await f.run();f.finish();
  assert.equal(f.res.statusCode, 200);
  assert.equal(f.res.chunks.join(''), csvHeader);
  assert.equal(f.res.destroyed, false);
});

test('PostgreSQL financial CSV events share server request and session references without searched data', pg, async t => {
  const f = await analyticsFixture(t);
  const pickup = 'PRIVATE-EXACT-SEARCH-ADDRESS';
  const trip = await f.trip({pickup, destination: 'PRIVATE-DESTINATION-ADDRESS', status: 'completed', capture: 15000});
  const admin = await f.adminLogin();
  const events = reference => f.h.state.logs.flatMap(line => {
    try {const event = JSON.parse(line);return event.category === 'dispatch_security' && (!reference || event.referenceId === reference) ? [event] : [];}
    catch (_) {return [];}
  });
  const actor = events().find(event => event.action === 'dispatch_sign_in').actorId;
  const path = endpoint + '/trips.csv?' + dateQuery('2026-03-15', '2026-03-15', {search: pickup});
  const response = await f.get(path, admin);
  assert.equal(response.status, 200);
  const [event] = events(response.headers.get('x-request-id'));
  assert.equal(event.action, 'financial_csv_export');assert.equal(event.outcome, 'completed');
  assert.equal(event.actorId, actor);assert.equal(event.recordId, undefined);
  assert.ok(response.body.includes(trip.reference));
  const denied = await f.get(path);
  assert.equal(denied.status, 401);
  assert.equal(events(denied.headers.get('x-request-id'))[0].outcome, 'denied');
  const original = f.store.exportDispatchAnalyticsTrips;
  f.store.exportDispatchAnalyticsTrips = async () => {throw new Error('PRIVATE-DB-ERROR');};
  const failed = await f.get(path, admin);
  f.store.exportDispatchAnalyticsTrips = original;
  assert.equal(failed.status, 500);
  const failedEvents = events(failed.headers.get('x-request-id'));
  assert.equal(failedEvents.length, 1);assert.equal(failedEvents[0].outcome, 'failed');
  assert.doesNotMatch(f.h.state.logs.join('\n'), /PRIVATE-|rider@example\.test|2015550140|cs_|pi_|re_|er_admin_session=/);
});
