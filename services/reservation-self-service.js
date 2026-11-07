'use strict';

const {hashToken} = require('../auth/customers');
const {DAY, paymentActionPending} = require('./trip-management');
const {ManagementError, tripFingerprint, UUID, exactKeys} = require('./reservation-management');
const ewr = require('../ewr-pickups');
const pricing = require('../pricing');
const {currentPolicy, acceptedPolicy} = require('./cancellation-policy');

const ACTIVE = ['awaiting_payment', 'confirmed', 'assigned', 'driver_en_route'];
const HEX = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const invalid = () => new ManagementError(400, 'Enter valid reservation changes.');
const stale = () => new ManagementError(409, 'The reservation or terms changed. Review the current terms again.');

function cents(quote) {
  const amount = Math.round(quote?.total * 100);
  if (!Number.isSafeInteger(amount) || amount <= 0 || quote.currency !== 'usd') throw stale();
  return amount;
}

function revision(record, subject) {
  const attempt = record.checkoutAttempt;
  return hashToken(JSON.stringify([record.id, tripFingerprint(record), record.trip.flightNumber, record.trip.luggage,
    record.trip.hours, cents(record.quote), record.quote.currency, record.status, record.paymentStatus,
    record.stripeSessionId, attempt?.key, attempt?.state, attempt?.evidence, attempt?.firstSubmittedAt,
    record.refundStatus, record.paymentReviewRequired, subject]));
}

function cancellationTerms(record, now, parseDateTime, source = null) {
  if (record.status === 'cancelled') throw new ManagementError(409, 'This trip is already cancelled.');
  const fareCents = cents(record.quote);
  const acceptance = acceptedPolicy(record);
  const pickup = parseDateTime(record.trip.date, record.trip.time, 'pickup');
  const policyVersion = acceptance?.policy.version || null;
  let review = null;
  if (policyVersion !== currentPolicy.version) review = 'legacy_policy';
  else if (!ACTIVE.includes(record.status)) review = 'service_started';
  else if (pickup - now < DAY) review = 'within_24_hours';
  else if (record.paymentReviewRequired || record.refundStatus || paymentActionPending(record)) review = 'payment_review';
  const eligible = review === null;
  const capturedCents = record.paymentStatus === 'paid' ? fareCents : 0;
  if (eligible && capturedCents && !source) review = 'payment_review';
  const refundedBeforeCents = source?.refundedBeforeCents || 0;
  const refundCents = eligible ? (capturedCents ? source?.remainingCents ?? null : 0) : null;
  return {pickupAt: new Date(pickup).toISOString(), fareCents, policyVersion,
    automaticEligible: eligible, capturedCents, refundedBeforeCents, refundCents, review,
    revision: revision(record, ['cancellation-24h', policyVersion, eligible, review, refundedBeforeCents, refundCents])};
}

function confirmInput(body, extra = []) {
  if (!exactKeys(body, ['revision', 'requestId', 'confirmed', ...extra]) || body.confirmed !== true ||
      typeof body.revision !== 'string' || !HEX.test(body.revision) ||
      typeof body.requestId !== 'string' || !UUID.test(body.requestId)) {
    throw new ManagementError(400, 'Review and explicitly confirm the current terms.');
  }
  return {revision: body.revision, requestId: body.requestId.toLowerCase()};
}

const fields = ['date', 'time', 'pickup', 'dropoff', 'vehicle', 'passengers', 'luggage', 'flightNumber', 'pickupTerminal', 'dropoffTerminal'];
const terminalKeys = Object.fromEntries(Object.entries(ewr).map(([id, entry]) =>
  [entry.kind === 'airport' ? 'general' : entry.label.at(-1).toLowerCase(), id]));
const validAddress = value => value.length >= 3 && value.length <= 200 && /[\p{L}\p{N}]/u.test(value);

function amendmentInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length ||
      Object.keys(body).some(key => !fields.includes(key))) throw invalid();
  const result = {};
  for (const key of fields) {
    if (!Object.hasOwn(body, key)) continue;
    const value = body[key];
    if (key === 'passengers' || key === 'luggage') {
      if (!Number.isSafeInteger(value) || value < (key === 'passengers' ? 1 : 0) || value > 20) throw invalid();
      result[key] = value;
      continue;
    }
    if (typeof value !== 'string' || /[<>\x00-\x1f\x7f]/.test(value)) throw invalid();
    const text = value.trim();
    if ((key === 'date' && !DATE.test(text)) || (key === 'time' && !TIME.test(text)) ||
        (['pickup', 'dropoff'].includes(key) && !validAddress(text)) ||
        (key === 'vehicle' && !Object.hasOwn(pricing.vehicleRates, text)) ||
        (key.endsWith('Terminal') && !Object.hasOwn(terminalKeys, text)) ||
        (key === 'flightNumber' && (text.length > 40 || (text && !/^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(text))))) throw invalid();
    result[key] = text;
  }
  return result;
}

function amendmentTerms(record, proposed, now, parseDateTime) {
  if (!ACTIVE.includes(record.status) || record.status === 'driver_en_route') {
    throw new ManagementError(409, 'This trip is unavailable for online changes.');
  }
  const t = record.trip;
  const changes = Object.fromEntries(Object.entries(proposed).filter(([key, value]) =>
    key.endsWith('Terminal') ? t[key.replace('Terminal', 'PlaceId')] !== terminalKeys[value] : t[key] !== value));
  if (!Object.keys(changes).length) throw new ManagementError(400, 'Change at least one reservation detail.');
  const body = {...t, ...record.customer, ...changes, promoCode: '', offerCode: record.quote.fixedOffer?.code || ''};
  delete body.pickupTerminal;
  delete body.dropoffTerminal;
  for (const end of ['pickup', 'dropoff']) {
    const terminal = end + 'Terminal';
    if (changes[end]) delete body[end + 'PlaceId'];
    if (!changes[terminal]) continue;
    const id = terminalKeys[changes[terminal]];
    // The customer is selecting a published EWR option. Booking pricing still
    // verifies that this ID and the supplied/retained address agree.
    if (!changes[end] && !Object.hasOwn(ewr, t[end + 'PlaceId'] || '') && !/\bEWR\b|Newark Liberty/i.test(t[end])) {
      throw invalid();
    }
    if (changes[end] && !/\bEWR\b|Newark Liberty/i.test(changes[end])) throw invalid();
    body[end + 'PlaceId'] = id;
    body[terminal] = changes[terminal];
    body[end] = 'Newark Liberty International Airport ' + (id === terminalKeys.general ? '(EWR)' : ewr[id].label);
  }
  // The record's verified EWR identity is retained on an unchanged endpoint.
  for (const end of ['pickup', 'dropoff']) {
    const id = body[end + 'PlaceId'];
    const terminal = Object.keys(terminalKeys).find(key => terminalKeys[key] === id);
    if (terminal && !body[end + 'Terminal']) body[end + 'Terminal'] = terminal;
  }
  const max = pricing.vehicleRates[body.vehicle]?.maxPassengers;
  if (!Number.isSafeInteger(body.passengers) || !max || body.passengers > max) throw invalid();
  const original = parseDateTime(t.date, t.time, 'pickup');
  const pickup = parseDateTime(body.date, body.time, 'pickup');
  if (original <= now || pickup <= now || t.tripType === 'roundtrip' &&
      pickup >= parseDateTime(t.returnDate, t.returnTime, 'return')) {
    throw new ManagementError(400, 'Choose a future pickup before the return trip, if applicable.');
  }
  let review = Math.min(original, pickup) - now < DAY ? 'within_24_hours' : 'availability_unverified';
  const promoReview = !!record.quote.promotion;
  const capacityReview = Number.isSafeInteger(changes.luggage) &&
    (!Number.isSafeInteger(pricing.vehicleRates[body.vehicle].maxLuggage) ||
      changes.luggage > pricing.vehicleRates[body.vehicle].maxLuggage);
  return {changes, body, review, promoReview, capacityReview};
}

function amendmentView(record, plan, proposedQuote, now) {
  const originalCents = cents(record.quote);
  const newCents = proposedQuote ? cents(proposedQuote) : null;
  const details = {changes: plan.changes, originalCents, newCents,
    differenceCents: newCents === null ? null : newCents - originalCents, review: plan.review,
    pricingReview: plan.promoReview ? 'existing_promotion' : proposedQuote ? null : 'pricing_unavailable',
    luggageReview: plan.capacityReview};
  return {...details, revision: revision(record, ['amendment', details, now])};
}

function settlementView(row, record) {
  const paymentReview = record?.paymentReviewRequired === true ||
    (record?.paymentStatus === 'paid' && Number(row.captured_cents) === 0);
  return {reference: row.booking_id,
    fareCents: Number(row.fare_cents), refundCents: Number(row.amount_cents),
    ...(Number(row.fee_cents) > 0 ? {legacySettlement: true, retainedCents: Number(row.fee_cents)} : {}),
    state: paymentReview ? 'review_required' : row.state, origin: row.origin,
    cancelledAt: new Date(row.created_at).toISOString()};
}

module.exports = {ACTIVE, HEX, cents, revision, cancellationTerms, confirmInput,
  amendmentInput, amendmentTerms, amendmentView, settlementView, stale};
