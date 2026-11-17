'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {
  classifyRetentionRow, readRetentionPage
} = require('../storage/reservation-retention');
const {parseArgs, runInventory} = require('../scripts/review-reservation-retention.cjs');
const {analyticsFixture} = require('./helpers/dispatch-analytics.cjs');

const pg = {skip: !process.env.ER_TEST_DATABASE_URL && 'Requires isolated PostgreSQL'};
const asOf = '2026-11-17T17:00:00.000Z';

function reservationRow(overrides = {}) {
  const row = {
    id: randomUUID(), reference: 'ER-510001', status: 'completed', archived: false,
    version: '7', updatedAt: '2021-11-18T17:00:00.000Z', createdAt: '2021-01-12T16:00:00.000Z',
    scheduledStart: '2021-11-17T17:00:00.000Z', scheduledEnd: '2021-11-17T17:00:00.000Z',
    trip: {tripType: 'oneway', date: '2021-11-17', time: '12:00'},
    payment: {paymentStatus: 'unpaid', createdAt: '2021-01-12T16:00:00.000Z', stripeSessionId: null,
      currency: 'usd', fareCents: '15000'},
    ledger: null, refunds: [],
    linked: {guestAccess: 0, tripEvents: 0, requests: 0, pendingRequests: 0,
      emails: 0, pendingEmails: 0, paymentLinks: 0, pendingPaymentLinks: 0,
      reviews: 0, reviewEvents: 0, archiveEvents: 0, firstRideClaims: 0,
      paidEligibility: 0, changePreviews: 0, accountAccess: 0}
  };
  return {...row, ...overrides, payment: {...row.payment, ...overrides.payment}};
}

function dateRow(date, status = 'completed', utcHour = '17') {
  return reservationRow({status,
    trip: {tripType: 'oneway', date, time: '12:00'},
    scheduledStart: date + 'T' + utcHour + ':00:00.000Z',
    scheduledEnd: date + 'T' + utcHour + ':00:00.000Z'});
}

function paidRow(overrides = {}) {
  return reservationRow({
    payment: {paymentStatus: 'paid', createdAt: '2021-01-12T16:00:00.000Z',
      stripeSessionId: 'cs_synthetic_private_identifier'},
    ledger: {amountCents: '15000', currency: 'usd', sessionMatches: true,
      paidAt: '2021-02-15T16:00:00.000Z', paidAtMatches: true,
      retainUntil: '2028-02-15T16:00:00.000Z', legalHold: false, sessionUses: 1},
    ...overrides
  });
}

test('completed and cancelled checkpoints are exact New York calendar anniversaries', () => {
  for (const status of ['completed', 'cancelled']) {
    for (const [date, checkpoint, reached, classification] of [
      ['2021-11-16', '2026-11-16', true, 'Defer'],
      ['2021-11-17', '2026-11-17', true, 'Defer'],
      ['2021-11-18', '2026-11-18', false, 'Defer']
    ]) {
      const source = dateRow(date, status);
      const before = structuredClone(source);
      const result = classifyRetentionRow(source, {asOf});
      assert.equal(result.dateBasis.finalDate, date);
      assert.equal(result.checkpoint.date, checkpoint);
      assert.equal(result.checkpoint.reached, reached);
      assert.equal(result.classification, classification);
      assert.ok(result.blockers.includes('payment_balance_unresolved'));
      assert.equal(result.financial.externalClearance, 'Required');
      assert.deepEqual(source, before);
    }
  }
  const beforeNewYorkMidnight = classifyRetentionRow(dateRow('2021-11-17'),
    {asOf: '2026-11-17T04:59:59.999Z'});
  assert.equal(beforeNewYorkMidnight.checkpoint.reached, false);
});

test('round trips use the later return leg and hourly service uses its next-day end date', () => {
  const round = reservationRow({
    trip: {tripType: 'roundtrip', date: '2021-11-10', time: '12:00',
      returnDate: '2021-11-18', returnTime: '12:00'},
    scheduledStart: '2021-11-10T17:00:00.000Z', scheduledEnd: '2021-11-18T17:00:00.000Z'
  });
  const result = classifyRetentionRow(round, {asOf});
  assert.equal(result.dateBasis.finalDate, '2021-11-18');
  assert.equal(result.checkpoint.reached, false);
  const hourly = reservationRow({
    trip: {tripType: 'hourly', date: '2021-11-16', time: '23:00', hours: 3},
    scheduledStart: '2021-11-17T04:00:00.000Z', scheduledEnd: '2021-11-17T07:00:00.000Z'
  });
  assert.equal(classifyRetentionRow(hourly, {asOf}).dateBasis.finalDate, '2021-11-17');
  assert.equal(classifyRetentionRow(hourly, {asOf}).checkpoint.date, '2026-11-17');
});

test('leap-day fifth anniversaries roll forward to March 1 in the target year', () => {
  const leap = dateRow('2020-02-29');
  assert.equal(classifyRetentionRow(leap, {asOf: '2025-02-28T17:00:00.000Z'}).checkpoint.date, '2025-03-01');
  assert.equal(classifyRetentionRow(leap, {asOf: '2025-02-28T17:00:00.000Z'}).checkpoint.reached, false);
  assert.equal(classifyRetentionRow(leap, {asOf: '2025-03-01T05:00:00.000Z'}).checkpoint.reached, true);
});

test('nonexistent and ambiguous New York wall times require evidence despite a saved instant', () => {
  const spring = reservationRow({
    trip: {tripType: 'oneway', date: '2021-03-14', time: '02:30'},
    scheduledStart: '2021-03-14T07:30:00.000Z', scheduledEnd: '2021-03-14T07:30:00.000Z'
  });
  const fall = reservationRow({
    trip: {tripType: 'oneway', date: '2021-11-07', time: '01:30'},
    scheduledStart: '2021-11-07T05:30:00.000Z', scheduledEnd: '2021-11-07T05:30:00.000Z'
  });
  for (const row of [spring, fall]) {
    const result = classifyRetentionRow(row, {asOf});
    assert.equal(result.classification, 'Evidence required');
    assert.equal(result.checkpoint.date, null);
    assert.equal(result.checkpoint.reached, null);
  }
});

test('missing, invalid and inconsistent historical schedule evidence is not guessed', () => {
  const missingReturn = reservationRow({
    trip: {tripType: 'roundtrip', date: '2021-11-17', time: '12:00'}
  });
  const cases = [
    reservationRow({scheduledStart: null, scheduledEnd: null}),
    reservationRow({scheduledEnd: '2021-11-18T17:00:00.000Z'}),
    reservationRow({status: 'unrecognized private status'}),
    reservationRow({trip: {tripType: 'oneway', date: '2021-02-30', time: '12:00'}}),
    missingReturn
  ];
  for (const row of cases) {
    const result = classifyRetentionRow(row, {asOf});
    assert.equal(result.classification, 'Evidence required');
    assert.ok(result.blockers.length > 0);
    assert.equal(result.checkpoint.reached, null);
  }
});

test('active, upcoming and in-progress service cannot become Review due merely through age or status', () => {
  for (const status of ['awaiting_payment', 'confirmed', 'assigned', 'driver_en_route', 'passenger_on_board']) {
    const result = classifyRetentionRow(dateRow('2021-11-16', status), {asOf});
    assert.notEqual(result.classification, 'Review due');
  }
  for (const status of ['completed', 'cancelled', 'awaiting_payment', 'confirmed']) {
    assert.notEqual(classifyRetentionRow(dateRow('2027-11-17', status), {asOf}).classification, 'Review due');
  }
});

test('ordinary unpaid and FIRST15 expiry states cannot substitute for confirmed abandonment', () => {
  for (const extras of [
    {}, {cancellationReason: 'first15_hold_expired'},
    {archived: true}, {abandonedAt: '2026-01-01T00:00:00.000Z'},
    {abandonmentConfirmation: {ownerConfirmed: true, checksComplete: true, confirmedAt: '2026-01-01T00:00:00.000Z'}}
  ]) {
    const row = dateRow('2026-01-17', 'awaiting_payment');
    Object.assign(row, extras);
    const result = classifyRetentionRow(row, {asOf});
    assert.equal(result.classification, 'Evidence required');
    assert.ok(result.blockers.includes('abandonment_confirmation_required'));
    assert.equal(result.checkpoint.date, null);
  }
});

test('owner-confirmed abandonment is supported only at classification with 30-day and elapsed-leg gates', () => {
  const row = dateRow('2026-10-01', 'awaiting_payment', '16');
  for (const [confirmedAt, reached] of [
    ['2026-10-17T17:00:00.000Z', true],
    ['2026-10-18T17:00:00.000Z', true],
    ['2026-10-19T17:00:00.000Z', false]
  ]) {
    const result = classifyRetentionRow(row, {asOf, abandonmentConfirmation: {
      ownerConfirmed: true, checksComplete: true, confirmedAt
    }});
    assert.equal(result.checkpoint.reached, reached);
    assert.equal(result.classification, 'Defer');
    assert.ok(result.blockers.includes('payment_balance_unresolved'));
  }
  for (const confirmation of [
    {ownerConfirmed: false, checksComplete: true, confirmedAt: '2026-10-01T00:00:00.000Z'},
    {ownerConfirmed: true, checksComplete: false, confirmedAt: '2026-10-01T00:00:00.000Z'},
    {ownerConfirmed: true, checksComplete: true, confirmedAt: 'not a date'}
  ]) {
    assert.notEqual(classifyRetentionRow(row, {asOf, abandonmentConfirmation: confirmation}).classification, 'Review due');
  }
  assert.notEqual(classifyRetentionRow(dateRow('2027-01-01', 'awaiting_payment'), {
    asOf, abandonmentConfirmation: {ownerConfirmed: true, checksComplete: true, confirmedAt: '2026-10-01T00:00:00.000Z'}
  }).classification, 'Review due');
});

test('accounting marker and ledger holds remain separate from a reached operational checkpoint', () => {
  const accounting = classifyRetentionRow(paidRow(), {asOf});
  assert.equal(accounting.checkpoint.reached, true);
  assert.equal(accounting.classification, 'Defer');
  assert.ok(accounting.blockers.includes('accounting_marker_active'));
  assert.equal(accounting.financial.ledgerRetainUntil, '2028-02-15T16:00:00.000Z');
  assert.equal(accounting.financial.externalClearance, 'Required');
  const row = paidRow();
  row.ledger.legalHold = true;
  const held = classifyRetentionRow(row, {asOf});
  assert.ok(held.blockers.includes('ledger_hold'));
  assert.equal(held.checkpoint.reached, true);
  assert.equal(held.classification, 'Defer');
  const settled = paidRow();
  settled.ledger.retainUntil = '2022-02-15T16:00:00.000Z';
  assert.equal(classifyRetentionRow(settled, {asOf}).classification, 'Review due');
  const partial = structuredClone(settled);
  partial.ledger.amountCents = '5000';
  const partialResult = classifyRetentionRow(partial, {asOf});
  assert.equal(partialResult.financial.paymentStatus, 'partially_paid');
  assert.equal(partialResult.classification, 'Defer');
  assert.ok(partialResult.blockers.includes('payment_balance_unresolved'));
  partial.refunds = [{state: 'confirmed', evidence: 'provider_api_confirmed', amountCents: '2000',
    currency: 'usd', confirmedAt: '2021-12-01T17:00:00.000Z', identifierValid: true,
    identityConflict: false, managed: true, priorRefundCents: '0', refundKey: 'partial-refund-key'}];
  const partialRefund = classifyRetentionRow(partial, {asOf});
  assert.equal(partialRefund.financial.paymentStatus, 'partially_refunded');
  assert.equal(partialRefund.classification, 'Defer');
  assert.ok(partialRefund.blockers.includes('payment_balance_unresolved'),
    'A verified refund does not settle the unpaid remainder of an accepted fare');
});

test('ambiguous Checkout and current payment review remain blockers but stale reviews do not change authority', () => {
  const unknown = reservationRow();
  unknown.payment.checkoutAttempt = {key: 'private-key', state: 'submitted_unknown',
    evidence: 'submission_indeterminate', firstSubmittedAt: 1600000000000, submissionCount: 1};
  assert.notEqual(classifyRetentionRow(unknown, {asOf}).classification, 'Review due');
  const current = reservationRow();
  current.payment.stripeSessionId = 'cs_retention_current';
  current.payment.checkoutAttempt = {key: 'current-attempt', state: 'session_identified',
    firstSubmittedAt: 1600000000000, submissionCount: 1, evidence: 'open_session'};
  current.payment.paymentConfirmationReview = {attemptKey: 'current-attempt', sessionId: 'cs_retention_current',
    status: 'session_mismatch', lastResult: 'session_mismatch', checkedAt: Date.parse(asOf), paymentIntentId: null};
  assert.ok(classifyRetentionRow(current, {asOf}).blockers.includes('payment_review_required'));
  assert.equal(classifyRetentionRow(current, {asOf}).financial.paymentStatus, 'review');
  const pending = structuredClone(current);
  pending.payment.paymentConfirmationReview.status = 'paid_awaiting_webhook';
  pending.payment.paymentConfirmationReview.lastResult = 'paid_awaiting_webhook';
  assert.equal(classifyRetentionRow(pending, {asOf}).financial.paymentStatus, 'processing');
  const stale = structuredClone(current);
  stale.payment.paymentConfirmationReview.attemptKey = 'retired-attempt';
  const result = classifyRetentionRow(stale, {asOf});
  assert.ok(!result.blockers.includes('payment_review_required'));
  const settled = paidRow();
  settled.ledger.retainUntil = '2022-01-12T16:00:00.000Z';
  settled.payment.checkoutAttempt = unknown.payment.checkoutAttempt;
  settled.payment.paymentConfirmationReview = current.payment.paymentConfirmationReview;
  const settledResult = classifyRetentionRow(settled, {asOf});
  assert.equal(settledResult.classification, 'Review due');
  assert.equal(settledResult.financial.paymentStatus, 'paid');
  assert.ok(!settledResult.blockers.includes('payment_pending_or_review'));
  assert.ok(!settledResult.blockers.includes('payment_review_required'));
});

test('missing or inconsistent paid evidence is never treated as a zero balance', () => {
  for (const row of [
    paidRow({ledger: null}),
    paidRow({ledger: {...paidRow().ledger, sessionMatches: false}}),
    paidRow({ledger: {...paidRow().ledger, paidAtMatches: false}}),
    paidRow({ledger: {...paidRow().ledger, sessionUses: 2}})
  ]) {
    const result = classifyRetentionRow(row, {asOf});
    assert.equal(result.classification, 'Evidence required');
    assert.ok(result.blockers.includes('financial_evidence_incomplete'));
    assert.equal(result.checkpoint.reached, true);
  }
});

test('confirmed full and partial refunds remain financial evidence while unresolved states require review', () => {
  for (const amount of ['15000', '4500']) {
    const row = paidRow();
    row.refunds = [{state: 'confirmed', evidence: 'provider_api_confirmed', amountCents: amount,
      currency: 'usd', confirmedAt: '2021-12-01T17:00:00.000Z', identifierValid: true,
      identityConflict: false, managed: true, priorRefundCents: '0', refundKey: 'synthetic-refund-key'}];
    const result = classifyRetentionRow(row, {asOf});
    assert.equal(result.checkpoint.reached, true);
    assert.equal(result.financial.externalClearance, 'Required');
    assert.match(result.financial.paymentStatus, /refunded/);
  }
  for (const state of ['prepared', 'submitted_unknown', 'provider_identified', 'review_required', 'failed']) {
    const row = paidRow();
    row.refunds = [{state, evidence: 'provider_pending', amountCents: '4500', currency: 'usd',
      confirmedAt: null, identifierValid: true, identityConflict: false, managed: true, priorRefundCents: '0'}];
    assert.notEqual(classifyRetentionRow(row, {asOf}).classification, 'Review due');
  }
});

test('routine classified output contains only a safe projection and no source payload values', () => {
  const row = reservationRow({
    customer: {firstName: 'PRIVATE-NAME', email: 'private@example.test', phone: '2015550182'},
    notes: 'PRIVATE-NOTES', pickup: 'PRIVATE-EXACT-PICKUP', destination: 'PRIVATE-EXACT-DESTINATION',
    customerAccess: {tokenHash: 'PRIVATE-TOKEN'},
    linked: {...reservationRow().linked, guestAccess: 1, accountAccess: 1, reviews: 2}
  });
  row.payment.checkoutAttempt = {key: 'PRIVATE-ATTEMPT-KEY', state: 'confirmed_unpaid',
    evidence: 'verified_expired_unpaid', parameters: {customer_email: 'PRIVATE-FROZEN-PAYLOAD'}};
  const text = JSON.stringify(classifyRetentionRow(row, {asOf}));
  for (const value of ['PRIVATE-', 'private@example.test', '2015550182', 'parameters', 'tokenHash']) {
    assert.ok(!text.includes(value), value);
  }
  assert.doesNotMatch(text, /safe to delete|authorized to delete/i);
  const malformed = reservationRow({reference: 'PRIVATE-REFERENCE', status: 'PRIVATE-STATUS',
    version: 'PRIVATE-VERSION', linked: {guestAccess: 'PRIVATE-ACCESS', emails: -1}});
  const malformedText = JSON.stringify(classifyRetentionRow(malformed, {asOf}));
  assert.ok(!malformedText.includes('PRIVATE-'));
  assert.equal(classifyRetentionRow(malformed, {asOf}).linked.guestAccess, 0);
});

test('inventory transactions are read-only, bounded and timed even for empty pages', async () => {
  const queries = [];
  let released = 0;
  const client = {query: async (sql, values) => {
    queries.push({sql, values});
    return {rows: []};
  }, release: () => {released++;}};
  const result = await readRetentionPage({connect: async () => client}, {asOf, limit: 2});
  assert.deepEqual(result.items, []);
  assert.equal(result.nextCursor, null);
  assert.match(queries[0].sql, /REPEATABLE READ READ ONLY/);
  assert.ok(queries.some(({sql}) => /statement_timeout='12s'/.test(sql)));
  assert.ok(queries.some(({sql}) => /lock_timeout='5s'/.test(sql)));
  assert.ok(queries.some(({sql}) => /idle_in_transaction_session_timeout='15s'/.test(sql)));
  assert.ok(queries.some(({sql}) => /ORDER BY id DESC LIMIT 1/.test(sql)));
  assert.ok(queries.every(({sql}) => /^(BEGIN|SET LOCAL|SELECT|COMMIT)/.test(sql)));
  assert.equal(queries.at(-1).sql, 'COMMIT');
  assert.equal(released, 1);
});

test('CLI help avoids database initialization and errors never echo private arguments or credentials', async () => {
  let calls = 0, output = '', errors = '';
  const capture = {stdout: text => {output += text;}, stderr: text => {errors += text;},
    createPool: () => {calls++; throw new Error('PRIVATE-DATABASE-ERROR');}, env: {}};
  assert.equal(await runInventory(['--help'], capture), 0);
  assert.equal(calls, 0);
  assert.match(output, /as-of/);
  output = '';
  assert.equal(await runInventory(['--unrecognized=PRIVATE-ARGUMENT'], capture), 1);
  assert.equal(calls, 0);
  assert.ok(!output);
  assert.ok(!errors.includes('PRIVATE-'));
  const parsed = parseArgs(['--as-of', asOf, '--limit', '2']);
  assert.equal(parsed.asOf, asOf);
  assert.equal(parsed.limit, 2);
  for (const args of [['--limit', '0'], ['--limit', '251'], ['--as-of', '2026-11-17'],
    ['--as-of', 'PRIVATE-TIME'], ['--limit', '2', '--limit', '3']]) {
    assert.throws(() => parseArgs(args), error => !error.message.includes('PRIVATE-'));
  }
});

async function snapshot(pool) {
  const {rows} = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE 'er_%' ORDER BY tablename");
  const result = {};
  for (const {tablename} of rows) {
    assert.match(tablename, /^er_[a-z0-9_]+$/);
    result[tablename] = (await pool.query('SELECT to_jsonb(t) AS row FROM "' + tablename + '" t ORDER BY to_jsonb(t)::text')).rows;
  }
  return result;
}

async function oldTrip(f, options = {}) {
  return f.trip({status: 'completed', createdAt: '2020-01-12T16:00:00.000Z',
    pickupAt: '2021-03-15T16:00:00.000Z', pickupDate: '2021-03-15', ...options});
}

test('PostgreSQL inventory preserves all stored records, linked access and minimized output', pg, async t => {
  const f = await analyticsFixture(t);
  const trip = await oldTrip(f, {archived: true});
  const accountTrip = await oldTrip(f);
  await f.register();
  const {rows: [owner]} = await f.pool.query('SELECT id FROM er_customers');
  await f.pool.query('UPDATE er_reservations SET customer_id=$2 WHERE id=$1', [accountTrip.id, owner.id]);
  await f.pool.query('INSERT INTO er_customer_sessions(token_hash,customer_id,created_at,expires_at) VALUES($1,$2,$3,$4)',
    ['e'.repeat(64), owner.id, '2026-11-17T16:00:00Z', '2030-01-01T00:00:00Z']);
  await f.pool.query("UPDATE er_reservations SET record=jsonb_set(record,'{customerAccess}',$2::jsonb) WHERE id=$1",
    [trip.id, JSON.stringify({tokenHash: 'a'.repeat(64), expiresAt: Date.parse('2030-01-01T00:00:00Z')})]);
  await f.pool.query('INSERT INTO er_reservation_management_access(booking_id,link_hash,issued_at,expires_at,window_started_at,issued_count) VALUES($1,$2,$3,$4,$3,1)',
    [trip.id, 'b'.repeat(64), '2026-11-17T16:00:00Z', '2026-11-17T18:00:00Z']);
  await f.request(trip, 'pending', '2021-03-14T16:00:00Z');
  const before = await snapshot(f.pool);
  const messages = structuredClone(f.h.state.bookingMessages);
  const result = await readRetentionPage(f.pool, {asOf, limit: 10});
  assert.equal(result.items.length, 2);
  const item = result.items.find(value => value.reference === trip.reference);
  assert.equal(item.reference, trip.reference);
  assert.equal(item.archived, true);
  assert.equal(item.checkpoint.reached, true);
  assert.equal(item.linked.guestAccess, 1);
  assert.equal(item.linked.bookingAccess, true);
  assert.ok(result.items.find(value => value.reference === accountTrip.reference).linked.accountAccess >= 1);
  assert.equal(item.linked.pendingRequests, 1);
  assert.notEqual(item.classification, 'Review due');
  assert.deepEqual(await snapshot(f.pool), before);
  assert.deepEqual(f.h.state.bookingMessages, messages);
  const text = JSON.stringify(result);
  for (const privateValue of [trip.id, trip.record.customer.email, trip.record.customer.phone,
    trip.record.trip.pickup, trip.record.trip.dropoff, 'a'.repeat(64), 'b'.repeat(64), 'e'.repeat(64)]) {
    assert.ok(!text.includes(privateValue));
  }
});

test('PostgreSQL live report requires abandonment confirmation even when imported JSON claims it', pg, async t => {
  const f = await analyticsFixture(t);
  const trip = await oldTrip(f, {status: 'awaiting_payment', archived: true});
  await f.pool.query("UPDATE er_reservations SET record=record || $2::jsonb WHERE id=$1",
    [trip.id, JSON.stringify({abandonedAt: '2020-01-01T00:00:00Z',
      abandonmentConfirmation: {ownerConfirmed: true, checksComplete: true, confirmedAt: '2020-01-01T00:00:00Z'}})]);
  const result = await readRetentionPage(f.pool, {asOf, limit: 10});
  assert.equal(result.items[0].classification, 'Evidence required');
  assert.ok(result.items[0].blockers.includes('abandonment_confirmation_required'));
  assert.equal(result.items[0].checkpoint.date, null);
});

test('PostgreSQL inventory recognizes verified refunds, pending reviews, ledger holds and financial gaps', pg, async t => {
  const f = await analyticsFixture(t);
  const paid = {capture: 15000, paidAt: '2020-02-15T16:00:00.000Z'};
  const full = await oldTrip(f, {...paid, status: 'cancelled'});
  await f.managedRefund(full, {createdAt: '2021-03-16T16:00:00Z', confirmedAt: '2021-03-17T16:00:00Z'});
  const partial = await oldTrip(f, {...paid, status: 'cancelled'});
  await f.register();
  const {rows: [owner]} = await f.pool.query('SELECT id FROM er_customers');
  await f.legacyRefund(partial, owner.id, {amount: 4500, confirmedAt: '2021-03-17T17:00:00Z'});
  const held = await oldTrip(f, paid);
  await f.pool.query('UPDATE er_payment_ledger SET legal_hold=true WHERE booking_id=$1', [held.id]);
  const unknown = await oldTrip(f, {checkoutAttempt: {key: 'PRIVATE-KEY', state: 'submitted_unknown',
    firstSubmittedAt: 1600000000000, submissionCount: 1, evidence: 'submission_indeterminate'}});
  const legacy = await oldTrip(f, {legacyPaid: true});
  const before = await snapshot(f.pool);
  const result = await readRetentionPage(f.pool, {asOf, limit: 20});
  const byRef = new Map(result.items.map(item => [item.reference, item]));
  assert.match(byRef.get(full.reference).financial.paymentStatus, /^refunded$/);
  assert.match(byRef.get(partial.reference).financial.paymentStatus, /^partially_refunded$/);
  assert.ok(byRef.get(held.reference).blockers.includes('ledger_hold'));
  assert.notEqual(byRef.get(unknown.reference).classification, 'Review due');
  assert.ok(byRef.get(legacy.reference).blockers.includes('financial_evidence_incomplete'));
  for (const item of result.items) assert.equal(item.financial.externalClearance, 'Required');
  assert.deepEqual(await snapshot(f.pool), before);
  const originalHeld = byRef.get(held.reference);
  await f.pool.query('UPDATE er_payment_ledger SET legal_hold=false WHERE booking_id=$1', [held.id]);
  const changed = (await readRetentionPage(f.pool, {asOf, limit: 20})).items.find(item => item.reference === held.reference);
  assert.equal(changed.version, originalHeld.version);
  assert.notEqual(changed.fingerprint, originalHeld.fingerprint,
    'Linked financial evidence must change the fingerprint even without a reservation version update');
});

test('PostgreSQL pagination is bounded, stable and rejects malformed or mismatched cursors safely', pg, async t => {
  const f = await analyticsFixture(t);
  const trips = [];
  for (let index = 0; index < 5; index++) trips.push(await oldTrip(f));
  let cursor = null, references = [], firstCursor;
  do {
    const page = await readRetentionPage(f.pool, {asOf, limit: 2, cursor});
    assert.ok(page.items.length <= 2);
    references.push(...page.items.map(item => item.reference));
    cursor = page.nextCursor;
    if (!firstCursor) await oldTrip(f, {createdAt: '2026-11-18T17:00:00.000Z'});
    firstCursor ||= cursor;
  } while (cursor);
  assert.equal(references.length, 5);
  assert.equal(new Set(references).size, 5);
  assert.deepEqual([...references].sort(), trips.map(trip => trip.reference).sort());
  const again = await readRetentionPage(f.pool, {asOf, limit: 2});
  assert.equal(again.nextCursor, firstCursor);
  const decoded = Buffer.from(firstCursor, 'base64url').toString();
  assert.doesNotMatch(decoded, /rider@example|Synthetic Rider|2015550140|pickup|dropoff|stripe|cs_/);
  for (const options of [
    {asOf, limit: 0}, {asOf, limit: 251}, {asOf, limit: 2, cursor: 'PRIVATE-BAD-CURSOR'},
    {asOf: '2026-11-18T17:00:00.000Z', limit: 2, cursor: firstCursor}
  ]) {
    await assert.rejects(readRetentionPage(f.pool, options), error => !error.message.includes('PRIVATE-'));
  }
});

test('CLI reads one PostgreSQL inventory page with no record writes and emits sanitized failures', pg, async t => {
  const f = await analyticsFixture(t);
  const trip = await oldTrip(f);
  const before = await snapshot(f.pool);
  let output = '', errors = '', closed = 0;
  const result = await runInventory(['--as-of', asOf, '--limit', '2'], {
    env: {DATABASE_URL: 'postgresql://synthetic:PRIVATE-PASSWORD@database.example.test/test?sslmode=require'},
    createPool: () => ({
      connect: (...args) => f.pool.connect(...args),
      on: () => {},
      end: async () => {closed++;}
    }),
    stdout: value => {output += value;},
    stderr: value => {errors += value;}
  });
  assert.equal(result, 0);
  assert.equal(closed, 1);
  assert.equal(errors, '');
  assert.equal(JSON.parse(output).items[0].reference, trip.reference);
  assert.deepEqual(await snapshot(f.pool), before);
  output = '';
  errors = '';
  const failure = await runInventory(['--as-of', asOf], {
    env: {DATABASE_URL: 'postgresql://synthetic:PRIVATE-PASSWORD@database.example.test/test?sslmode=require'},
    createPool: () => ({
      connect: async () => {throw new Error('PRIVATE-FAILURE ' + trip.record.customer.email);},
      on: () => {}, end: async () => {closed++;}
    }),
    stdout: value => {output += value;}, stderr: value => {errors += value;}
  });
  assert.equal(failure, 1);
  assert.equal(output, '');
  assert.ok(errors.length > 0);
  assert.doesNotMatch(errors, /PRIVATE-|rider@example|postgresql/);
});
