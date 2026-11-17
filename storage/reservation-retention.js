'use strict';

const crypto = require('node:crypto');
const {ZONE} = require('../services/dispatch-analytics');
const {paymentActionPending} = require('../services/trip-management');
const {dispatchPaymentConfirmation} = require('../services/payment-confirmation-recovery');

const POLICY_VERSION = 'M-08C-phase-1-2026-11';
const DAY = 86400000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const statuses = ['awaiting_payment', 'confirmed', 'assigned', 'driver_en_route', 'passenger_on_board', 'completed', 'cancelled'];
const linkedNames = ['guestAccess', 'tripEvents', 'requests', 'pendingRequests', 'emails', 'pendingEmails',
  'paymentLinks', 'pendingPaymentLinks', 'reviews', 'reviewEvents', 'archiveEvents', 'firstRideClaims',
  'paidEligibility', 'changePreviews', 'accountAccess', 'refundEvents', 'cancellationEvents',
  'reviewInvitations', 'pendingReviewInvitations'];
const clock = new Intl.DateTimeFormat('en-US', {timeZone: ZONE, year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});

function unavailable() {
  return new Error('Retention inventory unavailable. Check local configuration and database access.');
}

function instant(value) {
  if (value === null || value === undefined) return NaN;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : NaN;
}

function localFields(value) {
  return Object.fromEntries(clock.formatToParts(value).filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]));
}

function localDate(value) {
  const fields = localFields(value);
  return fields.year.toString().padStart(4, '0') + '-' + fields.month.toString().padStart(2, '0') +
    '-' + fields.day.toString().padStart(2, '0');
}

// Follows the booking parser's New York offset checks, but uncertain repeated
// wall times require evidence instead of choosing one occurrence for review.
function scheduledInstant(date, time) {
  if (typeof date !== 'string' || !/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(date) ||
      typeof time !== 'string' || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) return {problem: 'schedule_invalid'};
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(wall).toISOString().slice(0, 10) !== date) return {problem: 'schedule_invalid'};
  const matches = new Set();
  for (const delta of [-DAY, 0, DAY]) {
    const sample = wall + delta;
    const fields = localFields(sample);
    const offset = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second) - sample;
    const candidate = wall - offset;
    const found = localFields(candidate);
    if (found.year === year && found.month === month && found.day === day && found.hour === hour && found.minute === minute) matches.add(candidate);
  }
  if (matches.size !== 1) return {problem: matches.size > 1 ? 'schedule_ambiguous' : 'schedule_invalid'};
  return {value: [...matches][0]};
}

function verifiedSchedule(row) {
  if (!Number.isFinite(instant(row.scheduledStart)) || !Number.isFinite(instant(row.scheduledEnd))) return {problem: 'schedule_missing'};
  const trip = row.trip || {};
  const start = scheduledInstant(trip.date, trip.time);
  if (start.problem) return start;
  let end = start.value;
  let source = 'Scheduled pickup';
  if (trip.tripType === 'roundtrip') {
    if (!trip.returnDate || !trip.returnTime) return {problem: 'return_leg_missing'};
    const returning = scheduledInstant(trip.returnDate, trip.returnTime);
    if (returning.problem) return returning;
    if (returning.value <= start.value) return {problem: 'schedule_inconsistent'};
    end = returning.value;
    source = 'Scheduled return leg';
  } else if (trip.tripType === 'hourly') {
    if (![3, 3.5, 4, 4.5, 5, 5.5, 6, 7, 8].includes(Number(trip.hours))) return {problem: 'schedule_invalid'};
    end += Number(trip.hours) * 3600000;
    source = 'Scheduled hourly service end';
  } else if (!['oneway', 'airport'].includes(trip.tripType)) return {problem: 'schedule_invalid'};
  if (instant(row.scheduledStart) !== start.value || instant(row.scheduledEnd) !== end) return {problem: 'schedule_inconsistent'};
  return {value: end, finalDate: localDate(end), source};
}

function fiveYearDate(date) {
  const value = new Date(date + 'T00:00:00.000Z');
  value.setUTCFullYear(value.getUTCFullYear() + 5);
  const result = value.toISOString().slice(0, 10);
  return /^[1-9][0-9]{3}-/.test(result) ? result : null;
}

function validCents(value) {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(value);
}

function financialEvidence(row, now) {
  const payment = row.payment || {};
  const ledger = row.ledger;
  const blockers = [];
  const unknown = [];
  const refundStates = new Set();
  const refunds = Array.isArray(row.refunds) ? row.refunds : [];
  const knownFare = validCents(payment.fareCents) && BigInt(payment.fareCents) > 0n && payment.currency === 'usd';
  const verifiedCapture = !!ledger && payment.paymentStatus === 'paid' && ledger.currency === 'usd' &&
    knownFare && validCents(ledger.amountCents) && BigInt(ledger.amountCents) > 0n &&
    BigInt(ledger.amountCents) <= BigInt(payment.fareCents) && ledger.sessionMatches === true &&
    ledger.paidAtMatches === true && ledger.sessionUses === 1 && Number.isFinite(instant(ledger.paidAt)) &&
    instant(ledger.paidAt) >= instant(row.createdAt);
  if (!['paid', 'unpaid', 'failed'].includes(payment.paymentStatus)) unknown.push('financial_evidence_incomplete');
  if (!knownFare) unknown.push('financial_evidence_incomplete');
  if (ledger && !verifiedCapture || payment.paymentStatus === 'paid' && !verifiedCapture) unknown.push('financial_evidence_incomplete');
  const confirmation = verifiedCapture ? null : dispatchPaymentConfirmation(payment, now);
  const paymentReview = !verifiedCapture && (payment.checkoutAttempt?.state === 'review_required' ||
    ['session_unidentified', 'session_mismatch', 'provider_unavailable'].includes(confirmation?.status));
  if (paymentReview) blockers.push('payment_review_required');
  if (!verifiedCapture && !paymentReview && (paymentActionPending(payment) || confirmation?.needsReview)) blockers.push('payment_pending_or_review');
  if (payment.paymentReviewRequired === true) blockers.push('payment_review_required');
  if (!verifiedCapture && payment.stripeSessionId && payment.checkoutAttempt?.state !== 'confirmed_unpaid') blockers.push('checkout_authority_unresolved');
  if (ledger?.legalHold === true) blockers.push('ledger_hold');
  const retainAt = instant(ledger?.retainUntil);
  if (ledger && !Number.isFinite(retainAt)) unknown.push('accounting_marker_unavailable');
  if (Number.isFinite(retainAt) && retainAt > now) blockers.push('accounting_marker_active');
  const seen = new Set();
  let refunded = 0n;
  for (const refund of refunds) {
    const state = ['no_refund', 'prepared', 'submitted_unknown', 'provider_identified', 'confirmed', 'review_required', 'failed'].includes(refund.state)
      ? refund.state : 'unknown';
    refundStates.add(state);
    if (!validCents(refund.priorRefundCents) || BigInt(refund.priorRefundCents) > 0n) unknown.push('refund_evidence_incomplete');
    if (state === 'no_refund') continue;
    if (state !== 'confirmed') {
      blockers.push('refund_pending_or_review');
      continue;
    }
    if (!refund.identifierValid || refund.identityConflict || typeof refund.refundKey !== 'string' ||
        !validCents(refund.amountCents) || BigInt(refund.amountCents) <= 0n || refund.currency !== 'usd' ||
        !Number.isFinite(instant(refund.confirmedAt)) || !['webhook_confirmed', ...(refund.managed ? ['provider_api_confirmed'] : [])].includes(refund.evidence)) {
      unknown.push('refund_evidence_incomplete');
      continue;
    }
    if (!seen.has(refund.refundKey)) {
      refunded += BigInt(refund.amountCents);
      seen.add(refund.refundKey);
    }
  }
  if (refunded > 0n && (!verifiedCapture || refunded > BigInt(ledger.amountCents))) unknown.push('refund_evidence_incomplete');
  if (payment.refundStatus === 'confirmed' && refunded === 0n) unknown.push('refund_evidence_incomplete');
  if (['processing', 'review_required', 'failed'].includes(payment.refundStatus)) blockers.push('refund_pending_or_review');
  let paymentStatus = ['unpaid', 'failed'].includes(payment.paymentStatus) ? payment.paymentStatus : 'review';
  if (verifiedCapture) paymentStatus = BigInt(ledger.amountCents) < BigInt(payment.fareCents) ? 'partially_paid' : 'paid';
  if (refunded > 0n && verifiedCapture) paymentStatus = refunded === BigInt(ledger.amountCents) ? 'refunded' : 'partially_refunded';
  if (verifiedCapture && BigInt(ledger.amountCents) < BigInt(payment.fareCents) ||
      knownFare && ['unpaid', 'failed'].includes(payment.paymentStatus)) blockers.push('payment_balance_unresolved');
  if (unknown.length) paymentStatus = 'review';
  else if (blockers.some(value => ['payment_pending_or_review', 'checkout_authority_unresolved', 'refund_pending_or_review'].includes(value))) paymentStatus = 'processing';
  if (paymentReview || payment.paymentReviewRequired) paymentStatus = 'review';
  return {blockers, unknown, output: {paymentStatus, refundStates: [...refundStates].sort(),
    ledgerHold: ledger?.legalHold === true ? true : ledger?.legalHold === false ? false : null,
    ledgerRetainUntil: Number.isFinite(retainAt) ? new Date(retainAt).toISOString() : null,
    externalClearance: 'Required'}};
}

function classifyRetentionRow(row, {asOf, abandonmentConfirmation} = {}) {
  const now = instant(asOf);
  if (!Number.isFinite(now)) throw unavailable();
  const blockers = [];
  const unknown = [];
  const schedule = verifiedSchedule(row);
  const validStatus = statuses.includes(row.status);
  if (!validStatus) unknown.push('status_invalid');
  if (schedule.problem) unknown.push(schedule.problem);
  const finalDate = schedule.finalDate || null;
  const today = localDate(now);
  const terminal = ['completed', 'cancelled'].includes(row.status);
  let checkpoint = {kind: null, date: null, reached: null};
  if (terminal && finalDate) {
    const date = fiveYearDate(finalDate);
    checkpoint = {kind: 'Five-year operational review', date, reached: date === null ? null : today >= date};
    if (!date) unknown.push('checkpoint_unavailable');
  }
  if (!terminal && validStatus) blockers.push('active_service');
  if (Number.isFinite(schedule.value) && schedule.value > now) blockers.push('service_not_elapsed');
  if (!terminal && ['unpaid', 'failed'].includes(row.payment?.paymentStatus) &&
      !['assigned', 'driver_en_route', 'passenger_on_board'].includes(row.status)) {
    checkpoint = {kind: 'Abandoned unpaid review', date: null, reached: null};
    // Only an explicitly supplied, verified case-log observation can be tested at
    // this layer. The live reader never supplies it or trusts reservation JSON.
    const confirmedAt = instant(abandonmentConfirmation?.confirmedAt);
    if (abandonmentConfirmation?.ownerConfirmed === true && Number.isFinite(confirmedAt) && confirmedAt <= now) {
      const dueAt = confirmedAt + 30 * DAY;
      checkpoint = {kind: 'Abandoned unpaid review', date: new Date(dueAt).toISOString(), reached: now >= dueAt};
      if (abandonmentConfirmation.checksComplete !== true) unknown.push('abandonment_checks_required');
      if (schedule.problem || schedule.value > now) blockers.push('service_not_elapsed');
      if (!schedule.problem && schedule.value <= now && abandonmentConfirmation.checksComplete === true) {
        const active = blockers.indexOf('active_service');
        if (active >= 0) blockers.splice(active, 1);
      }
    } else unknown.push('abandonment_confirmation_required');
  }
  const finance = financialEvidence(row, now);
  blockers.push(...finance.blockers);
  unknown.push(...finance.unknown);
  const linked = Object.fromEntries(linkedNames.map(name => {
    const value = Number(row.linked?.[name]);
    return [name, Number.isSafeInteger(value) && value >= 0 ? value : 0];
  }));
  linked.bookingAccess = row.linked?.bookingAccess === true;
  if (linked.pendingRequests || linked.pendingEmails || linked.pendingPaymentLinks || linked.firstRideClaims ||
      linked.changePreviews || linked.pendingReviewInvitations) blockers.push('linked_activity_requires_review');
  const reference = typeof row.reference === 'string' && /^ER-[0-9]{6}$/.test(row.reference) ? row.reference : uuid.test(row.id || '') ? row.id : 'Unavailable';
  const version = typeof row.version === 'string' && /^[0-9]{1,20}$/.test(row.version) ? row.version : 'Unavailable';
  if (reference === 'Unavailable' || version === 'Unavailable') unknown.push('record_identity_unavailable');
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
  const reasons = [...new Set([...blockers, ...unknown])].sort();
  let classification = checkpoint.reached === false ? 'Not yet due' : 'Review due';
  if (blockers.length) classification = 'Defer';
  if (unknown.length) classification = 'Evidence required';
  return {reference, status: validStatus ? row.status : 'Unknown', archived: row.archived === true,
    version, fingerprint, dateBasis: {finalDate, source: schedule.source || 'Unavailable'}, checkpoint,
    classification, blockers: reasons, financial: finance.output, linked};
}

// Select only timing, financial evidence, and counts. Never load contacts,
// addresses, notes, access hashes, or frozen provider payloads for this report.
const pageSql = `
SELECT r.id::text, r.booking_reference AS reference, r.record->>'status' AS status,
  r.archived_at IS NOT NULL AS archived, r.version::text AS version, r.updated_at AS "updatedAt", r.created_at AS "createdAt",
  r.scheduled_start_at AS "scheduledStart", r.scheduled_end_at AS "scheduledEnd",
  jsonb_build_object('tripType',r.record #>> '{trip,tripType}','date',r.record #>> '{trip,date}',
    'time',r.record #>> '{trip,time}','returnDate',r.record #>> '{trip,returnDate}',
    'returnTime',r.record #>> '{trip,returnTime}','hours',r.record #> '{trip,hours}') AS trip,
  jsonb_build_object('paymentStatus',r.record->>'paymentStatus','createdAt',r.record->>'createdAt',
    'currency',r.record #>> '{quote,currency}','fareCents',CASE
      WHEN jsonb_typeof(r.record #> '{quote,total}')='number' AND (r.record #>> '{quote,total}')::numeric>0
      THEN ROUND((r.record #>> '{quote,total}')::numeric*100)::text END,
    'stripeSessionId',r.record->>'stripeSessionId','quote',jsonb_build_object('promotion',jsonb_build_object('code',r.record #>> '{quote,promotion,code}')),
    'checkoutAttempt',jsonb_build_object('key',r.record #>> '{checkoutAttempt,key}','state',r.record #>> '{checkoutAttempt,state}',
      'evidence',r.record #>> '{checkoutAttempt,evidence}','firstSubmittedAt',r.record #> '{checkoutAttempt,firstSubmittedAt}',
      'submissionCount',r.record #> '{checkoutAttempt,submissionCount}'),
    'paymentConfirmationReview',jsonb_build_object('sessionId',r.record #>> '{paymentConfirmationReview,sessionId}',
      'attemptKey',r.record #>> '{paymentConfirmationReview,attemptKey}','status',r.record #>> '{paymentConfirmationReview,status}',
      'checkedAt',r.record #> '{paymentConfirmationReview,checkedAt}','lastResult',r.record #>> '{paymentConfirmationReview,lastResult}'),
    'refundStatus',r.record->>'refundStatus',
    'paymentReviewRequired',r.record->'paymentReviewRequired') AS payment,
  CASE WHEN l.booking_id IS NOT NULL THEN jsonb_build_object('amountCents',l.amount_cents::text,'currency',l.currency,
    'sessionMatches',l.stripe_session_id=r.record->>'stripeSessionId' AND l.stripe_session_id ~ '^cs_[A-Za-z0-9_]+$',
    'paidAt',l.paid_at,'paidAtMatches',l.paid_at::text::timestamptz=CASE
      WHEN r.record->>'paidAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*(Z|[+-][0-9]{2}:[0-9]{2})$'
        AND pg_input_is_valid(r.record->>'paidAt','timestamptz') THEN (r.record->>'paidAt')::timestamptz END,
    'retainUntil',l.retain_until,'legalHold',l.legal_hold,
    'sessionUses',(SELECT count(*) FROM er_payment_ledger duplicates WHERE duplicates.stripe_session_id=l.stripe_session_id)) END AS ledger,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('state',f.state,'evidence',f.evidence,'amountCents',f.amount_cents::text,
    'currency',f.currency,'confirmedAt',f.confirmed_at,'managed',f.managed,'priorRefundCents',f.prior_refunds::text,
    'refundKey',md5(COALESCE(f.stripe_refund_id,f.id::text)),
    'identifierValid',f.stripe_refund_id ~ '^re_[A-Za-z0-9_]+$',
    'identityConflict',EXISTS (SELECT 1 FROM (
      SELECT booking_id,stripe_refund_id,amount_cents,currency FROM er_reservation_refunds WHERE state='confirmed'
      UNION ALL SELECT booking_id,stripe_refund_id,amount_cents,currency FROM er_managed_cancellations WHERE state='confirmed'
    ) other WHERE other.stripe_refund_id=f.stripe_refund_id AND
      (other.booking_id<>f.booking_id OR other.amount_cents<>f.amount_cents OR other.currency<>f.currency)))
      ORDER BY f.managed,f.id) FROM (
      SELECT id,booking_id,state,evidence,amount_cents,currency,confirmed_at,stripe_refund_id,false AS managed,0::bigint AS prior_refunds
      FROM er_reservation_refunds WHERE booking_id=r.id
      UNION ALL SELECT id,booking_id,state,evidence,amount_cents,currency,confirmed_at,stripe_refund_id,true,refunded_before_cents
      FROM er_managed_cancellations WHERE booking_id=r.id
    ) f),'[]'::jsonb) AS refunds,
  jsonb_build_object(
    'guestAccess',(SELECT count(*) FROM er_reservation_management_access WHERE booking_id=r.id),
    'tripEvents',(SELECT count(*) FROM er_customer_trip_events WHERE booking_id=r.id),
    'requests',(SELECT count(*) FROM er_reservation_management_requests WHERE booking_id=r.id),
    'pendingRequests',(SELECT count(*) FROM er_reservation_management_requests WHERE booking_id=r.id AND status='pending'),
    'emails',(SELECT count(*) FROM er_booking_email_outbox WHERE booking_id=r.id),
    'pendingEmails',(SELECT count(*) FROM er_booking_email_outbox WHERE booking_id=r.id AND state IN ('pending','sending','review_required')),
    'paymentLinks',(SELECT count(*) FROM er_admin_payment_links WHERE booking_id=r.id),
    'pendingPaymentLinks',(SELECT count(*) FROM er_admin_payment_links WHERE booking_id=r.id AND state IN ('pending','sending','review_required')),
    'reviews',(SELECT count(*) FROM er_customer_reviews WHERE booking_id=r.id),
    'reviewEvents',(SELECT count(*) FROM er_review_moderation_events e JOIN er_customer_reviews v ON v.id=e.review_id WHERE v.booking_id=r.id),
    'archiveEvents',(SELECT count(*) FROM er_admin_trip_archive_events WHERE booking_id=r.id),
    'firstRideClaims',(SELECT count(*) FROM er_first_ride_claims WHERE booking_id=r.id),
    'paidEligibility',(SELECT count(*) FROM er_paid_ride_eligibility WHERE booking_id=r.id),
    'changePreviews',(SELECT count(*) FROM er_reservation_change_previews WHERE booking_id=r.id),
    'refundEvents',(SELECT count(*) FROM er_reservation_refund_events e JOIN er_reservation_refunds f ON f.id=e.refund_id WHERE f.booking_id=r.id),
    'cancellationEvents',(SELECT count(*) FROM er_managed_cancellation_events e JOIN er_managed_cancellations m ON m.id=e.cancellation_id WHERE m.booking_id=r.id),
    'reviewInvitations',(SELECT count(*) FROM er_review_invitations WHERE booking_id=r.id),
    'pendingReviewInvitations',(SELECT count(*) FROM er_review_invitations WHERE booking_id=r.id AND state IN ('pending','sending','review_required')),
    'bookingAccess',r.record ? 'customerAccess',
    'accountAccess',(SELECT count(*) FROM er_customer_sessions WHERE customer_id=r.customer_id)) AS linked
FROM er_reservations r LEFT JOIN er_payment_ledger l ON l.booking_id=r.id
WHERE r.created_at<=$1::timestamptz AND ($2::uuid IS NULL OR r.id>$2::uuid) AND r.id<=$3::uuid
ORDER BY r.id LIMIT $4`;

async function readRetentionPage(pool, {asOf, limit = 100, cursor = null} = {}) {
  if (typeof asOf !== 'string' || !Number.isFinite(instant(asOf)) || new Date(asOf).toISOString() !== asOf ||
      !Number.isInteger(limit) || limit < 1 || limit > 250) throw unavailable();
  let position = null;
  if (cursor !== null) {
    if (typeof cursor !== 'string' || cursor.length > 600 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw unavailable();
    try {
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.toString('base64url') !== cursor) throw unavailable();
      position = JSON.parse(bytes.toString('utf8'));
      if (!position || Object.keys(position).sort().join(',') !== 'after,asOf,policy,upper' ||
          position.asOf !== asOf || position.policy !== POLICY_VERSION || !uuid.test(position.after) ||
          !uuid.test(position.upper) || position.after > position.upper) throw unavailable();
    } catch (_) { throw unavailable(); }
  }
  let client;
  let started = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    started = true;
    await client.query("SET LOCAL statement_timeout='12s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='15s'");
    if (!position) {
      const {rows} = await client.query('SELECT id::text FROM er_reservations WHERE created_at<=$1::timestamptz ORDER BY id DESC LIMIT 1', [asOf]);
      if (!rows.length) {
        await client.query('COMMIT');
        started = false;
        return {policyVersion: POLICY_VERSION, asOf, items: [], nextCursor: null};
      }
      position = {after: null, upper: rows[0].id, asOf, policy: POLICY_VERSION};
    }
    const {rows} = await client.query(pageSql, [asOf, position.after, position.upper, limit + 1]);
    const page = rows.slice(0, limit);
    const items = page.map(row => classifyRetentionRow(row, {asOf}));
    const nextCursor = rows.length > limit ? Buffer.from(JSON.stringify({...position, after: page.at(-1).id})).toString('base64url') : null;
    await client.query('COMMIT');
    started = false;
    return {policyVersion: POLICY_VERSION, asOf, items, nextCursor};
  } catch (_) {
    if (started) await client?.query('ROLLBACK').catch(() => {});
    throw unavailable();
  } finally {
    try { client?.release(); } catch (_) { /* Never echo driver or connection errors. */ }
  }
}

module.exports = {POLICY_VERSION, classifyRetentionRow, readRetentionPage};
