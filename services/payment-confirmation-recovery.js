const MINUTE = 60_000;
const recoveryPolicy = Object.freeze({
  ageMs: 30 * MINUTE,
  sweepMs: 5 * MINUTE,
  recheckMs: 60 * MINUTE,
  manualRecheckMs: 5 * MINUTE,
  scanLimit: 128,
  checkLimit: 8
});
const reviewStatuses = Object.freeze([
  'paid_awaiting_webhook', 'payment_pending', 'session_unidentified', 'session_mismatch', 'provider_unavailable'
]);
const providerResults = [...reviewStatuses, 'session_open', 'expired_unpaid'];
const sessionId = /^cs_[A-Za-z0-9_]{1,180}$/;
const intentId = /^pi_[A-Za-z0-9_]{1,180}$/;
const providerOptions = {timeout: 10_000, maxNetworkRetries: 0};

const checkoutIntent = session => typeof session?.payment_intent === 'string' ? session.payment_intent : session?.payment_intent?.id;

function validReview(review) {
  return review && typeof review === 'object' &&
    Object.keys(review).sort().join(',') === 'attemptKey,checkedAt,lastResult,paymentIntentId,sessionId,status' &&
    (review.attemptKey === null || typeof review.attemptKey === 'string') &&
    (review.sessionId === null || (typeof review.sessionId === 'string' && sessionId.test(review.sessionId))) &&
    (review.paymentIntentId === null || (typeof review.paymentIntentId === 'string' && intentId.test(review.paymentIntentId))) &&
    Number.isSafeInteger(review.checkedAt) && review.checkedAt > 0 &&
    providerResults.includes(review.status) && providerResults.includes(review.lastResult);
}

function target(booking) {
  return {
    paymentStatus: booking.paymentStatus,
    promotionCode: booking.quote?.promotion?.code,
    createdAt: booking.createdAt,
    stripeSessionId: booking.stripeSessionId,
    attemptKey: booking.checkoutAttempt?.key,
    firstSubmittedAt: booking.checkoutAttempt?.firstSubmittedAt,
    review: booking.paymentConfirmationReview
  };
}

function waitingSince(payment) {
  if (payment.paymentStatus === 'paid' || payment.promotionCode === 'FIRST15') return null;
  if (Number.isFinite(payment.firstSubmittedAt)) return payment.firstSubmittedAt;
  const created = Date.parse(payment.createdAt);
  return payment.stripeSessionId && Number.isFinite(created) ? created : null;
}

function currentReview(payment) {
  const review = payment.review;
  return waitingSince(payment) !== null && review &&
    review.sessionId === (payment.stripeSessionId || null) && review.attemptKey === (payment.attemptKey || null)
    ? review : null;
}

function pendingConfirmation(booking) {
  const payment = target(booking);
  const status = currentReview(payment)?.status;
  return !!payment.stripeSessionId && (status === 'paid_awaiting_webhook' ||
    (status === 'payment_pending' && booking.paymentStatus !== 'failed'));
}

function providerPaidAwaitingWebhook(booking) {
  const payment = target(booking);
  return !!payment.stripeSessionId && waitingSince(payment) !== null &&
    (currentReview(payment)?.status === 'paid_awaiting_webhook' ||
      booking.checkoutAttempt?.evidence === 'verified_paid_awaiting_webhook');
}

function dispatchPaymentConfirmation(booking, now) {
  const payment = target(booking);
  const since = waitingSince(payment);
  if (since === null) return null;
  const review = currentReview(payment);
  return {
    ageMinutes: Math.max(0, Math.floor((now - since) / MINUTE)),
    checkedAt: review?.checkedAt ?? null,
    status: review?.status ?? 'not_checked',
    lastResult: review?.lastResult ?? null,
    needsReview: reviewStatuses.includes(review?.status)
  };
}

function providerSessionMatchesAttempt(booking, session) {
  const expected = currentReview(target(booking))?.paymentIntentId;
  const actual = checkoutIntent(session);
  return !expected || (actual ? actual === expected : session?.status === 'expired' && session.payment_status === 'unpaid');
}

async function findInterruptedSession(stripe, booking, now) {
  const attempt = booking.checkoutAttempt;
  const correlation = attempt?.correlationId;
  if (!correlation || attempt.parameters?.metadata?.attemptReference !== correlation) return null;
  const created = {
    gte: Math.floor(attempt.firstSubmittedAt / 1000) - 300,
    lte: Math.min(Math.floor(now / 1000), attempt.expiresAt)
  };
  let cursor;
  let match;
  // Search only a bounded creation window for this exact persisted attempt.
  for (let page = 0; page < 3; page++) {
    const batch = await stripe.checkout.sessions.list({
      limit: 100, created, ...(cursor ? {starting_after: cursor} : {})
    }, providerOptions);
    if (!Array.isArray(batch?.data) || typeof batch.has_more !== 'boolean') throw new Error('Invalid session listing');
    for (const session of batch.data) {
      if (session.metadata?.bookingId !== booking.id || session.metadata?.attemptReference !== correlation) continue;
      if (match || !sessionId.test(session.id || '')) return null;
      match = session.id;
    }
    if (!batch.has_more) return match || null;
    const next = batch.data.at(-1)?.id;
    if (!sessionId.test(next || '') || next === cursor) return null;
    cursor = next;
  }
  return null;
}

async function inspectSession(stripe, booking, now, matchesSession) {
  if (!stripe) return {result: 'provider_unavailable'};
  try {
    const id = booking.stripeSessionId || await findInterruptedSession(stripe, booking, now);
    if (!id) return {result: 'session_unidentified'};
    if (!sessionId.test(id)) return {result: 'session_mismatch'};
    const session = await stripe.checkout.sessions.retrieve(id, {}, providerOptions);
    const attempt = booking.checkoutAttempt;
    const customer = attempt?.parameters?.customer;
    const paymentIntentId = checkoutIntent(session);
    if (!matchesSession(session, {...booking, stripeSessionId: id}) ||
        (customer && (session.customer?.id || session.customer) !== customer) ||
        !providerSessionMatchesAttempt(booking, session) ||
        (paymentIntentId != null && (typeof paymentIntentId !== 'string' || !intentId.test(paymentIntentId))) ||
        (attempt?.correlationId && (session.metadata?.attemptReference !== attempt.correlationId ||
          session.expires_at !== attempt.expiresAt))) {
      return {result: 'session_mismatch'};
    }
    if (session.status === 'complete' && session.payment_status === 'paid') {
      return {id, paymentIntentId: paymentIntentId ?? null, result: 'paid_awaiting_webhook'};
    }
    if (session.payment_status === 'unpaid') {
      const results = {open: 'session_open', complete: 'payment_pending', expired: 'expired_unpaid'};
      if (Object.hasOwn(results, session.status)) return {id, result: results[session.status]};
    }
    return {result: 'session_mismatch'};
  } catch (_) {
    return {result: 'provider_unavailable'};
  }
}

function createPaymentConfirmationRecovery({store, stripe, now, actionKey, matchesSession, reportFailure,
  policy = recoveryPolicy}) {
  let cursor = null;
  let pageThroughHistory = false;
  let running = false;

  function due(payment, at, manual) {
    const since = waitingSince(payment);
    if (since === null || (!manual && at - since < policy.ageMs)) return false;
    const review = currentReview(payment);
    if (!review) return true;
    if (manual) return at - review.checkedAt >= policy.manualRecheckMs;
    return !['paid_awaiting_webhook', 'expired_unpaid', 'session_unidentified'].includes(review.status) &&
      at - review.checkedAt >= policy.recheckMs;
  }

  async function check(booking, manual = true) {
    if (!booking || !due(target(booking), now(), manual)) return;
    await store.withActionLock(actionKey(booking), async () => {
      const fresh = await store.get(booking.id);
      const at = now();
      if (!fresh || !due(target(fresh), at, manual)) return;
      const {id, result, paymentIntentId} = await inspectSession(stripe, fresh, at, matchesSession);
      await store.update(fresh.id, record => {
        const payment = target(record);
        if (waitingSince(payment) === null || record.stripeSessionId !== fresh.stripeSessionId ||
            record.checkoutAttempt?.key !== fresh.checkoutAttempt?.key ||
            record.paymentStatus !== fresh.paymentStatus ||
            record.checkoutAttempt?.evidence !== fresh.checkoutAttempt?.evidence) return false;
        const previous = currentReview(payment);
        const status = previous?.status === 'paid_awaiting_webhook' ||
          record.checkoutAttempt?.evidence === 'verified_paid_awaiting_webhook' ? 'paid_awaiting_webhook' : result;
        // An interrupted paid session must be associated before Stripe can redeliver.
        if (id && !record.stripeSessionId) record.stripeSessionId = id;
        record.paymentConfirmationReview = {
          attemptKey: record.checkoutAttempt?.key || null,
          sessionId: record.stripeSessionId || null,
          paymentIntentId: paymentIntentId || previous?.paymentIntentId || null,
          checkedAt: at, status, lastResult: result
        };
        if (id && record.checkoutAttempt && (record.checkoutAttempt.state !== 'confirmed_unpaid' ||
            status === 'paid_awaiting_webhook')) {
          record.checkoutAttempt.state = 'session_identified';
          if (status === 'paid_awaiting_webhook') record.checkoutAttempt.evidence = 'verified_paid_awaiting_webhook';
          if (status === 'payment_pending' && record.paymentStatus !== 'failed') {
            record.checkoutAttempt.evidence = 'payment_pending';
          }
          if (status === 'expired_unpaid' && record.checkoutAttempt.evidence === 'payment_pending') {
            record.checkoutAttempt.evidence = 'verified_expired_unpaid';
          }
        }
        return true;
      }, {paymentConfirmationReviewOnly: true});
    });
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      const at = now();
      // Keep recent attempts responsive while making steady progress through older bookings.
      const historical = pageThroughHistory;
      pageThroughHistory = !pageThroughHistory;
      const page = await store.paymentConfirmationPage(new Date(at - policy.ageMs),
        historical ? cursor : null, policy.scanLimit);
      let checked = 0;
      for (const row of page) {
        if (historical) cursor = {at: row.cursorAt, id: row.id};
        if (!due(row, at, false)) continue;
        try {
          await check(await store.get(row.id), false);
        } catch (error) {
          if (error.status !== 409) reportFailure();
        }
        if (++checked === policy.checkLimit) return;
      }
      if (historical && page.length < policy.scanLimit) cursor = null;
    } finally {
      running = false;
    }
  }

  return {check, run};
}

module.exports = {createPaymentConfirmationRecovery, dispatchPaymentConfirmation, providerPaidAwaitingWebhook,
  pendingConfirmation, providerSessionMatchesAttempt, recoveryPolicy, reviewStatuses, validReview};
