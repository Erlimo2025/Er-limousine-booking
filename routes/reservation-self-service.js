'use strict';

const crypto = require('node:crypto');
const {UUID, ManagementError, exactKeys, requestView, canRequest} = require('../services/reservation-management');
const {
  cancellationTerms, confirmInput, amendmentInput, amendmentTerms, amendmentView,
  revision, settlementView, stale
} = require('../services/reservation-self-service');

const unavailable = () => new ManagementError(404, 'Reservation unavailable.');
const paymentReview = () => new ManagementError(409, 'Payment could not be verified. Send this request to Dispatch.');

function reservationSelfService({app, store, mutation, rateLimit, handle, requireAdmin, adminPath, queueOptions, parseDateTime, now,
  changePreviewsEnabled, autoCancellationsEnabled, quote, cancellationProof, capture, submitRefund, recheckRefund}) {
  const cancellationPreviewEnabled = changePreviewsEnabled || autoCancellationsEnabled;
  const terms = (record, at = now(), source = null) => cancellationTerms(record, at, parseDateTime, source);
  async function previewTerms(record) {
    const result = terms(record);
    if (!result.automaticEligible || !result.capturedCents) return result;
    try { return terms(record, now(), await capture(record)); }
    catch (_) { return {...result, review: 'payment_review', refundCents: null}; }
  }
  const lock = (record, work) => store.withActionLock(record.checkoutFingerprint || 'reservation:' + record.id, work);
  const isId = value => typeof value === 'string' && UUID.test(value);
  const requireEnabled = allowed => {
    if (!allowed) throw new ManagementError(404, 'Online reservation updates are unavailable.');
  };

  async function owned(authorization, req, res) {
    const access = await authorization(req, res);
    return {...access, ...await read(access)};
  }

  async function read({authority, reference}) {
    const result = await store.reservationManagementView(authority, reference, now());
    if (!result) throw unavailable();
    return result;
  }

  function plan(record, fields, at) {
    try {
      return amendmentTerms(record, fields, at, parseDateTime);
    } catch (error) {
      if (error instanceof ManagementError) throw error;
      throw new ManagementError(400, 'Enter a valid pickup date and time in New York.');
    }
  }

  async function settle(record, input, context) {
    const reviewId = null;
    const existing = await store.managedCancellation(record.id);
    if (existing) {
      if (existing.request_id !== input.requestId || existing.terms_revision !== input.revision ||
          (existing.review_request_id || null) !== (reviewId || null)) throw stale();
      return settlementView(existing, record);
    }
    const eligibility = terms(record);
    if (!eligibility.automaticEligible) throw new ManagementError(409, 'This cancellation needs owner review.');
    let proof;
    try {
      proof = eligibility.capturedCents ? {safe: true, sessionId: record.stripeSessionId, refundSource: await capture(record)} :
        await cancellationProof(record);
    } catch (_) {
      throw paymentReview();
    }
    if (!proof?.safe) throw paymentReview();
    const expected = terms(record, now(), proof.refundSource);
    if (expected.revision !== input.revision || expected.review) throw stale();
    const checkedTerms = (current, at) => terms(current, at, proof.refundSource);
    const result = await store.applyManagedCancellation({...context, input, proof, check: {now, terms: checkedTerms}});
    // The booking and authorized refund obligation are already committed. An
    // interrupted or failed submission stays in the durable worker queue.
    if (result.row.state === 'prepared') {
      try { await submitRefund(record.id); } catch (_) { /* The worker retries the persisted obligation. */ }
      const fresh = await store.managedCancellation(record.id);
      return settlementView(fresh || result.row, result.record);
    }
    return settlementView(result.row, result.record);
  }

  function customerRoutes(path, authorization) {
    function post(suffix, limit, allowed, action) {
      app.post(path + suffix, mutation, rateLimit('reservation-self-service-' + suffix, limit), handle(async (req, res) => {
        requireEnabled(allowed);
        const access = await owned(authorization, req, res);
        await action(req, res, access);
      }));
    }

    post('/changes/preview', 8, changePreviewsEnabled, async (req, res, {authority, reference, record}) => {
      const at = now();
      const prepared = plan(record, amendmentInput(req.body), at);
      const sourceRevision = revision(record, 'amendment-source');
      let proposedQuote = null;
      if (!prepared.promoReview) {
        try { proposedQuote = await quote(prepared.body, req); } catch (_) { /* Route/pricing failures require Dispatch. */ }
      }
      const id = crypto.randomUUID();
      const details = amendmentView(record, prepared, proposedQuote, at);
      await store.saveReservationChangePreview(authority, reference, id, sourceRevision, details, now());
      res.json({preview: {id, ...details}});
    });

    post('/changes/confirm', 15, changePreviewsEnabled, async (req, res, {authority, reference, record, requests}) => {
      const input = confirmInput(req.body, ['previewId']);
      if (!isId(req.body.previewId)) throw stale();
      const previewId = req.body.previewId.toLowerCase();
      const previous = requests.find(request => request.client_request_id === input.requestId);
      if (previous) {
        if (previous.kind !== 'amendment' || previous.details.previewId !== previewId ||
            previous.details.revision !== input.revision) throw stale();
        return res.json({request: requestView(previous)});
      }
      const preview = await store.reservationChangePreview(record.id, previewId, now());
      if (!preview || preview.revision !== input.revision) throw stale();
      const details = {...preview.details, previewId, sourceRevision: preview.reservation_revision};
      const saved = await store.submitReservationRequest(authority, reference, {...input, kind: 'amendment', details}, now(),
        async (current, client) => {
          const at = now();
          if (revision(current, 'amendment-source') !== preview.reservation_revision) throw stale();
          plan(current, details.changes, at);
          const result = await client.query('SELECT 1 FROM er_reservation_change_previews ' +
            'WHERE booking_id=$1 AND id=$2 AND revision=$3 AND expires_at>$4 FOR SHARE',
          [current.id, previewId, input.revision, new Date(at)]);
          if (!result.rowCount) throw stale();
        });
      res.json({request: requestView(saved)});
    });

    post('/cancellation/preview', 15, cancellationPreviewEnabled, async (req, res, {record, requests}) => {
      if (!exactKeys(req.body, [])) throw stale();
      if (requests.some(row => row.status === 'pending')) throw new ManagementError(409, 'A request is already awaiting Dispatch review.');
      res.json({terms: await previewTerms(record)});
    });

    post('/cancellation/confirm', 15, cancellationPreviewEnabled, async (req, res, access) => {
      const input = confirmInput(req.body, ['ownerReview']);
      if (typeof req.body.ownerReview !== 'boolean') throw stale();
      if (!req.body.ownerReview) requireEnabled(autoCancellationsEnabled);
      const {authority, reference, record, requests} = access;
      if (req.body.ownerReview) {
        const previous = requests.find(request => request.client_request_id === input.requestId);
        if (previous) {
          if (previous.kind !== 'cancellation' || previous.details?.terms?.revision !== input.revision) throw stale();
          return res.json({request: requestView(previous)});
        }
        const expected = await previewTerms(record);
        if (expected.revision !== input.revision) throw stale();
        const saved = await store.submitReservationRequest(authority, reference,
          {...input, kind: 'cancellation', details: {terms: expected}}, now(), current => {
            const currentTerms = terms(current);
            if (!currentTerms.automaticEligible && currentTerms.revision !== input.revision) throw stale();
          });
        return res.json({request: requestView(saved)});
      }
      if (requests.some(row => row.status === 'pending')) throw new ManagementError(409, 'A request is already awaiting Dispatch review.');
      const cancellation = await lock(record, async () => {
        const current = await read(access);
        return settle(current.record, input, {authority, reference});
      });
      res.json({cancellation});
    });
  }

  app.get(adminPath + '/settlements', requireAdmin, rateLimit('admin-reservation-settlements', 60), handle(async (req, res) => {
    const {status, ...query} = req.query;
    if (status !== undefined && status !== 'reconciliation') throw stale();
    const {cursor} = queueOptions(query);
    const rows = await store.listManagedCancellations(cursor, 20, status === 'reconciliation');
    const page = rows.slice(0, 20);
    const last = page.at(-1);
    const nextCursor = rows.length > page.length ? Buffer.from(JSON.stringify({
      date: new Date(last.created_at).toISOString(), id: last.id
    })).toString('base64url') : null;
    res.json({nextCursor, settlements: page.map(row => ({...settlementView(row, row.record),
      evidence: row.evidence, reviewer: row.reviewer_id, verificationNote: row.verification_note,
      lastAttemptAt: row.last_attempt_at, nextAttemptAt: row.next_attempt_at, escalatedAt: row.escalated_at,
      attempts: row.reconciliation_attempts, canRecheck: Number(row.captured_cents) > 0}))});
  }));

  app.post(adminPath + '/settlements/:id/recheck', requireAdmin, mutation, rateLimit('admin-refund-recheck', 15),
    handle(async (req, res) => {
      if (!isId(req.params.id) || !exactKeys(req.body, [])) throw stale();
      const record = await store.get(req.params.id);
      const settlement = record && await store.managedCancellation(record.id);
      if (!settlement || !Number(settlement.captured_cents)) throw unavailable();
      const admin = req.adminArchiveAuthority;
      const result = await lock(record, async () => {
        if (!admin.authorized()) throw new ManagementError(401, 'Sign in to Dispatch.');
        await recheckRefund(record.id, admin);
        if (!admin.authorized()) throw new ManagementError(401, 'Sign in to Dispatch.');
        return store.managedCancellation(record.id);
      });
      res.json({cancellation: settlementView(result, record)});
    }));

  async function customerView(record, requests) {
    const existing = record.status === 'cancelled' && await store.managedCancellation?.(record.id);
    return {
      ...(existing ? {cancellation: settlementView(existing, record)} : {}),
      ...(cancellationPreviewEnabled ? {selfService: {
        changePreviewsEnabled, autoCancellationsEnabled,
        canChange: changePreviewsEnabled && canRequest(record, now(), parseDateTime) &&
          !requests.some(row => row.status === 'pending'),
        canCancel: record.status !== 'cancelled' && !requests.some(row => row.status === 'pending'),
        vehicleKey: record.trip.vehicle, flightNumber: record.trip.flightNumber || '', luggage: record.trip.luggage ?? null
      }} : {})
    };
  }

  async function checkApproval(record, row, at) {
    if (row.kind === 'amendment') {
      if (revision(record, 'amendment-source') !== row.details.sourceRevision) throw stale();
      plan(record, row.details.changes, at);
      return {};
    }
    if (row.kind === 'cancellation') {
      if (record.status === 'cancelled') throw stale();
      let proof;
      try {
        proof = record.paymentStatus === 'paid' ? {safe: true, sessionId: record.stripeSessionId} :
          await cancellationProof(record);
      } catch (_) { throw paymentReview(); }
      if (!proof?.safe) throw paymentReview();
      return {cancel: true, proof};
    }
    return null;
  }

  return {customerRoutes, customerView, checkApproval, autoCancellationsEnabled};
}

module.exports = {reservationSelfService};
