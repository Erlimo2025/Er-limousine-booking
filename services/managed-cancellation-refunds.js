'use strict';

const CHECK_LIMIT_MS = 24 * 3600000;
const RETRY_DELAYS_MS = [60000, 5 * 60000, 15 * 60000, 3600000];
const activeRefundStates = ['prepared', 'submitted_unknown', 'provider_identified'];

function checkDeadline(row) {
  return new Date(row.created_at).getTime() + CHECK_LIMIT_MS;
}

function nextRefundCheck(row, at) {
  const index = Math.min(row.reconciliation_attempts - 1, RETRY_DELAYS_MS.length - 1);
  return new Date(Math.min(checkDeadline(row), at + RETRY_DELAYS_MS[Math.max(0, index)]));
}

function managedRefundRecovery({store, stripe, now, options, matches, capturedCharge, settledRefundedCents, metadataKey, reportFailure}) {
  async function inspect(row, operator) {
    if (row.stripe_refund_id) {
      try {
        const refund = await stripe.refunds.retrieve(row.stripe_refund_id, {}, options);
        return matches(refund, row) ? {refund} : {problem: 'provider_refund_mismatch', escalate: true};
      } catch (_) {
        return {problem: 'refund_lookup_failed'};
      }
    }

    // Even a pending external refund can occupy the charge's refundable balance.
    // Discover by the stored charge and exact operation metadata before every POST.
    let list;
    try {
      list = await stripe.refunds.list({charge: row.charge_id, limit: 100}, options);
    } catch (_) {
      return {problem: 'refund_lookup_failed'};
    }
    if (!list || !Array.isArray(list.data) || list.has_more !== false) {
      return {problem: 'refund_list_unverified', escalate: true};
    }
    const related = list.data.filter(refund => refund?.metadata?.[metadataKey] === row.id);
    if (related.length) {
      if (related.length !== 1 || !matches(related[0], row)) return {problem: 'provider_refund_mismatch', escalate: true};
      return {refund: related[0]};
    }
    const refunded = settledRefundedCents(list, row.charge_id, row.payment_intent_id, row.currency);
    if (refunded === null || refunded !== Number(row.refunded_before_cents || 0)) {
      return {problem: 'another_refund_exists', escalate: true};
    }
    if (operator) return {problem: 'no_matching_provider_refund'};

    let charge;
    try {
      charge = await stripe.charges.retrieve(row.charge_id, {}, options);
    } catch (_) {
      return {problem: 'funding_lookup_failed'};
    }
    if (!capturedCharge(charge, row.charge_id, row.payment_intent_id, Number(row.captured_cents), row.currency) ||
        charge.amount_refunded !== refunded || Number(row.amount_cents) > charge.amount_captured - charge.amount_refunded) {
      return {problem: 'refund_funding_unverified', escalate: true};
    }
    return {};
  }

  async function submit(bookingId, operator = false) {
    const saved = await store.refundForBooking(bookingId);
    if (!saved || saved.state === 'no_refund') return;
    const row = await store.startRefundReconciliation(saved.id, now(), operator);
    if (!row) return;

    const result = stripe ? await inspect(row, operator) : {problem: 'refund_provider_unavailable'};
    if (result.refund) return store.observeRefund(row.id, result.refund.id, result.refund.status, now());
    if (result.problem) {
      reportFailure();
      return store.recordRefundProblem(row.id, result.problem, now(), result.escalate === true);
    }

    // Persist the existing operation's submission marker before the provider
    // call. The store retires unknown submissions before Stripe can prune keys.
    const submitted = await store.startRefundSubmission(row.id, now());
    if (!submitted || !activeRefundStates.includes(submitted.state)) return;
    let refund;
    try {
      refund = await stripe.refunds.create({
        charge: submitted.charge_id,
        amount: Number(submitted.amount_cents),
        reason: 'requested_by_customer',
        metadata: {bookingId: submitted.booking_id, [metadataKey]: submitted.id}
      }, {...options, idempotencyKey: submitted.idempotency_key});
    } catch (_) {
      reportFailure();
      return store.recordRefundProblem(row.id, 'refund_submission_uncertain', now());
    }
    if (!matches(refund, submitted)) {
      reportFailure();
      return store.recordRefundProblem(row.id, 'provider_refund_mismatch', now(), true);
    }
    // Creation establishes the provider identity. A fresh API lookup or signed
    // event verified against the API confirms the current status.
    return store.observeRefund(row.id, refund.id, refund.status, now(), true);
  }

  return {submit};
}

module.exports = {activeRefundStates, checkDeadline, nextRefundCheck, managedRefundRecovery};
