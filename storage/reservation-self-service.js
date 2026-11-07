'use strict';

const crypto = require('node:crypto');
const {ManagementError} = require('../services/reservation-management');
const {cents, revision, stale} = require('../services/reservation-self-service');
const {submission, validWebhook} = require('./refunds');
const {activeRefundStates, checkDeadline, nextRefundCheck} = require('../services/managed-cancellation-refunds');

const REVIEW = () => new ManagementError(409, 'Payment or cancellation eligibility needs Dispatch review.');
const unavailable = () => new ManagementError(404, 'Reservation unavailable.');
const refundStates = [...activeRefundStates, 'confirmed', 'review_required', 'failed'];
const problemEvidence = new Set(['refund_lookup_failed', 'provider_refund_mismatch', 'refund_list_unverified',
  'another_refund_exists', 'no_matching_provider_refund', 'funding_lookup_failed', 'refund_funding_unverified',
  'refund_submission_uncertain', 'refund_provider_unavailable']);
const providerStatuses = ['pending', 'requires_action', 'succeeded', 'failed', 'canceled'];

function reservationSelfServiceStorage({transaction, safe, validateRecord, queryClient, ownedRow, assertActionLock}) {
  const find = async (client, bookingId) =>
    (await client.query('SELECT * FROM er_managed_cancellations WHERE booking_id=$1', [bookingId])).rows[0] || null;

  async function append(client, row, now, stripeEventId = null, actorId = null) {
    await client.query('INSERT INTO er_managed_cancellation_events ' +
      '(id,cancellation_id,state,evidence,stripe_event_id,created_at,actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [crypto.randomUUID(), row.id, row.state, row.evidence, stripeEventId, new Date(now), actorId]);
  }

  function markReview(row, evidence, at) {
    row.state = 'review_required';
    row.evidence = evidence;
    row.next_attempt_at = null;
    row.escalated_at ||= new Date(at);
  }

  function observe(row, refundId, status, at, source) {
    if (!/^re_[A-Za-z0-9_]{1,180}$/.test(refundId) || !providerStatuses.includes(status) ||
        row.stripe_refund_id && row.stripe_refund_id !== refundId) throw REVIEW();
    row.stripe_refund_id = refundId;
    if (status === 'succeeded' && source !== 'create') {
      row.state = 'confirmed';
      row.evidence = source === 'webhook' ? 'webhook_confirmed' : 'provider_api_confirmed';
      row.confirmed_at ||= new Date(at);
    } else if (status === 'failed' || status === 'canceled') {
      row.state = 'failed';
      row.evidence = (source === 'webhook' ? 'webhook_' : 'provider_') + status;
      row.escalated_at ||= new Date(at);
    } else if (at >= checkDeadline(row) || row.state === 'review_required' || row.state === 'failed') {
      markReview(row, 'provider_pending_requires_review', at);
    } else {
      row.state = 'provider_identified';
      row.evidence = status === 'succeeded' ? 'provider_succeeded_awaiting_reconciliation' :
        source === 'webhook' ? 'webhook_pending' : 'provider_pending';
      row.next_attempt_at ||= nextRefundCheck(row, at);
    }
    if (!activeRefundStates.includes(row.state)) row.next_attempt_at = null;
  }

  async function ledger(client, record, source) {
    if (!source || source.sessionId !== record.stripeSessionId || source.amountCents !== cents(record.quote) ||
        source.currency !== record.quote.currency) throw REVIEW();
    const paid = (await client.query(
      'SELECT amount_cents,currency,stripe_session_id FROM er_payment_ledger WHERE booking_id=$1 FOR SHARE', [record.id]
    )).rows[0];
    if (!paid || Number(paid.amount_cents) !== source.amountCents || paid.stripe_session_id !== source.sessionId ||
        paid.currency !== source.currency ||
        (await client.query('SELECT 1 FROM er_reservation_refunds WHERE booking_id=$1', [record.id])).rowCount) throw REVIEW();
  }

  async function lockedRefund(client, id, reconciliationTime) {
    const {rows: [row]} = await client.query('SELECT * FROM er_managed_cancellations WHERE id=$1 FOR UPDATE', [id]);
    if (!row || !refundStates.includes(row.state)) return null;
    const {rows: [trip]} = await client.query('SELECT record FROM er_reservations WHERE id=$1 FOR SHARE', [row.booking_id]);
    if (!trip) throw REVIEW();
    const record = validateRecord(trip.record);
    await assertActionLock(record.checkoutFingerprint || 'reservation:' + record.id);
    try {
      if (record.status !== 'cancelled' || record.paymentStatus !== 'paid' || record.refundStatus ||
          record.paymentReviewRequired || Number(row.fare_cents) !== cents(record.quote)) throw REVIEW();
      await ledger(client, record, {sessionId: row.stripe_session_id, amountCents: Number(row.captured_cents), currency: row.currency});
    } catch (error) {
      if (!(error instanceof ManagementError) || reconciliationTime === undefined) throw error;
      markReview(row, 'refund_authority_unverified', reconciliationTime);
      await persist(client, row, reconciliationTime);
      return null;
    }
    return row;
  }

  async function persist(client, row, now, eventId = null, auditEvidence = row.evidence, actorId = null) {
    await client.query('UPDATE er_managed_cancellations SET state=$2,stripe_refund_id=$3,first_submitted_at=$4,' +
      'submission_count=$5,evidence=$6,updated_at=$7,confirmed_at=$8,reconciliation_attempts=$9,' +
      'last_attempt_at=$10,next_attempt_at=$11,escalated_at=$12 WHERE id=$1',
    [row.id, row.state, row.stripe_refund_id, row.first_submitted_at, row.submission_count, row.evidence,
      new Date(now), row.confirmed_at, row.reconciliation_attempts, row.last_attempt_at, row.next_attempt_at, row.escalated_at]);
    await append(client, {...row, evidence: auditEvidence}, now, eventId, actorId);
  }

  return {
    saveReservationChangePreview: (authority, reference, id, snapshot, details, now) => transaction(async client => {
      const row = await ownedRow(client, authority, reference, now, true);
      if (!row) throw unavailable();
      const record = validateRecord(row.record);
      if (revision(record, 'amendment-source') !== snapshot) throw stale();
      await client.query('DELETE FROM er_reservation_change_previews WHERE booking_id=$1', [record.id]);
      await client.query('INSERT INTO er_reservation_change_previews ' +
        '(id,booking_id,revision,reservation_revision,details,expires_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [id, record.id, details.revision, snapshot, JSON.stringify(details), new Date(now + 10 * 60000)]);
    }),

    reservationChangePreview: (bookingId, id, at) => safe(async () =>
      (await queryClient().query('SELECT * FROM er_reservation_change_previews WHERE booking_id=$1 AND id=$2 AND expires_at>$3',
        [bookingId, id, new Date(at)])).rows[0] || null),

    purgeExpiredReservationChangePreviews: now => safe(() => queryClient().query(
      'DELETE FROM er_reservation_change_previews WHERE id IN (SELECT id FROM er_reservation_change_previews ' +
      'WHERE expires_at<=$1 ORDER BY expires_at LIMIT 200)', [new Date(now)]
    )),

    managedCancellation: id => safe(() => find(queryClient(), id)),

    managedCancellationReview: id => safe(async () =>
      (await queryClient().query("SELECT * FROM er_reservation_management_requests WHERE id=$1 AND kind='cancellation'", [id])).rows[0] || null),

    applyManagedCancellation: ({authority, reference, input, proof, check}) => transaction(async client => {
      const trip = await ownedRow(client, authority, reference, check.now(), true, true);
      if (!trip) throw unavailable();
      const record = validateRecord(trip.record);
      await assertActionLock(record.checkoutFingerprint || 'reservation:' + record.id);
      const existing = await find(client, record.id);
      if (existing) {
        if (existing.request_id !== input.requestId || existing.terms_revision !== input.revision ||
            existing.review_request_id !== null) throw stale();
        return {row: existing, record};
      }
      const pending = (await client.query("SELECT * FROM er_reservation_management_requests WHERE booking_id=$1 AND status='pending' FOR UPDATE",
        [record.id])).rows[0];
      if (pending) throw new ManagementError(409, 'A request is already awaiting Dispatch review.');

      const acceptedAt = check.now();
      const terms = check.terms(record, acceptedAt);
      if (!terms.policyVersion || terms.revision !== input.revision || terms.review ||
          !terms.automaticEligible) throw stale();
      if (proof?.safe !== true || (proof.sessionId || null) !== (record.stripeSessionId || null)) throw REVIEW();
      const source = proof.refundSource;
      if (terms.capturedCents) {
        if (record.paymentReviewRequired || record.refundStatus) throw REVIEW();
        await ledger(client, record, source);
        if (source.remainingCents !== terms.refundCents || source.refundedBeforeCents !== terms.refundedBeforeCents ||
            !Number.isSafeInteger(terms.refundCents) || terms.refundCents < 0 ||
            terms.refundCents !== source.amountCents - source.refundedBeforeCents) throw REVIEW();
      } else if (source || terms.refundCents !== 0) throw REVIEW();

      const id = crypto.randomUUID();
      const state = source && terms.refundCents > 0 ? 'prepared' : 'no_refund';
      const {rows: [saved]} = await client.query(
        'INSERT INTO er_managed_cancellations (id,booking_id,request_id,terms_revision,origin,review_request_id,reviewer_id,' +
        'verification_note,pickup_at,fare_cents,captured_cents,fee_percent,fee_cents,amount_cents,currency,stripe_session_id,' +
        'payment_intent_id,charge_id,idempotency_key,state,evidence,created_at,updated_at,next_attempt_at,refunded_before_cents) VALUES ' +
        '($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20,$21,$21,$22,$23) RETURNING *',
        [id, record.id, input.requestId, terms.revision, authority.kind, null,
          null, null, terms.pickupAt, terms.fareCents, terms.capturedCents, 0,
          0, terms.refundCents, record.quote.currency, source?.sessionId || null, source?.paymentIntentId || null,
          source?.chargeId || null, 'er-managed-cancel-' + id, state, new Date(acceptedAt),
          state === 'prepared' ? new Date(acceptedAt) : null, terms.refundedBeforeCents]
      );
      record.status = 'cancelled';
      record.cancellationReason = 'customer_cancelled';
      if (!source && record.checkoutAttempt) {
        Object.assign(record.checkoutAttempt, {state: 'confirmed_unpaid', evidence: 'verified_cancelled_unpaid', lastReconciledAt: acceptedAt});
      }
      validateRecord(record);
      await client.query('UPDATE er_reservations SET record=$2::jsonb,version=version+1,updated_at=$3 WHERE id=$1',
        [record.id, JSON.stringify(record), new Date(acceptedAt)]);
      await client.query('DELETE FROM er_first_ride_claims WHERE booking_id=$1', [record.id]);
      await append(client, saved, acceptedAt);
      return {row: saved, record};
    }),

    listManagedCancellations: (cursor, limit, needsReview) => safe(async () => (await queryClient().query(
      'SELECT c.*, r.record FROM er_managed_cancellations c JOIN er_reservations r ON r.id=c.booking_id ' +
      'WHERE ($1::timestamptz IS NULL OR (c.created_at,c.id)<($1,$2::uuid)) ' +
      "AND (NOT $4::boolean OR c.state IN ('review_required','failed') OR r.record->>'paymentReviewRequired'='true') " +
      'ORDER BY c.created_at DESC,c.id DESC LIMIT $3',
      [cursor?.date || null, cursor?.id || null, limit + 1, needsReview])).rows),

    managedCancellationRefundCandidates: (now, limit) => safe(async () => (await queryClient().query(
      "SELECT booking_id FROM er_managed_cancellations WHERE state IN ('prepared','submitted_unknown','provider_identified') " +
      'AND next_attempt_at<=$1 ORDER BY next_attempt_at,created_at,id LIMIT $2', [new Date(now), limit])).rows),

    startManagedRefundReconciliation: (id, at, operator) => transaction(async client => {
      if (operator && !operator.authorized()) throw new ManagementError(401, 'Sign in to Dispatch.');
      const row = await lockedRefund(client, id, at);
      if (!row) return null;
      if (!operator) {
        if (!activeRefundStates.includes(row.state) || !row.next_attempt_at || new Date(row.next_attempt_at).getTime() > at) return null;
        if (at >= checkDeadline(row)) {
          markReview(row, 'reconciliation_deadline', at);
          await persist(client, row, at);
          return null;
        }
      }
      row.reconciliation_attempts++;
      row.last_attempt_at = new Date(at);
      if (activeRefundStates.includes(row.state)) row.next_attempt_at = nextRefundCheck(row, at);
      await persist(client, row, at, null, operator ? 'operator_recheck_started' : 'reconciliation_check_started', operator?.actorId);
      return row;
    }),

    startManagedCancellationRefund: (id, at) => transaction(async client => {
      const row = await lockedRefund(client, id, at);
      if (!row || row.stripe_refund_id || !activeRefundStates.includes(row.state)) return null;
      if (at >= checkDeadline(row)) markReview(row, 'reconciliation_deadline', at);
      else if (!submission(row, at)) return null;
      if (row.state === 'review_required') markReview(row, row.evidence, at);
      await persist(client, row, at);
      return row;
    }),

    recordManagedRefundProblem: (id, evidence, at, escalate) => transaction(async client => {
      if (!problemEvidence.has(evidence)) throw REVIEW();
      const row = await lockedRefund(client, id, at);
      if (!row) return null;
      if (escalate) markReview(row, evidence, at);
      else if (activeRefundStates.includes(row.state) && at >= checkDeadline(row)) markReview(row, 'reconciliation_deadline', at);
      else row.evidence = evidence;
      await persist(client, row, at, null, evidence);
      return row;
    }),

    observeManagedRefund: (id, refundId, status, at, created) => transaction(async client => {
      const row = await lockedRefund(client, id, at);
      if (!row) return null;
      observe(row, refundId, status, at, created ? 'create' : 'lookup');
      await persist(client, row, at);
      return row;
    }),

    confirmManagedCancellationRefund: (event, now) => transaction(async client => {
      const row = await lockedRefund(client, event.attemptId);
      if (!row || !validWebhook(row, event) || event.providerVerified !== true) return false;
      const prior = (await client.query('SELECT cancellation_id FROM er_managed_cancellation_events WHERE stripe_event_id=$1',
        [event.eventId])).rows[0];
      if (prior) return prior.cancellation_id === row.id;
      observe(row, event.refundId, event.status, now, 'webhook');
      await persist(client, row, now, event.eventId);
      return true;
    })
  };
}

module.exports = {reservationSelfServiceStorage};
