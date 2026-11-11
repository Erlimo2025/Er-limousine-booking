'use strict';

const crypto = require('node:crypto');
const {hashToken} = require('../auth/customers');
const {tripDto} = require('../storage/customer-trips');
const bookingStops = require('./booking-stops');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LINK_MINUTES = 20;
const GRANT_MINUTES = 45;
const REQUEST_STATUSES = ['pending', 'approved', 'declined'];
const LINK_MESSAGE = 'If these details match a guest reservation, we’ll email a verification link.';

class ManagementError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function exactKeys(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}

function normalizeGuestEmail(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  const email = value.trim();
  return /^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+\.[^\s@<>\x00-\x1f\x7f]+$/u.test(email) ? email.toLowerCase() : null;
}

function guestToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function guestTokenHash(raw) {
  return typeof raw === 'string' && TOKEN.test(raw) ? hashToken(raw) : null;
}

function verificationEmail(siteOrigin, to, token) {
  const url = new URL('/manage-reservation.html', siteOrigin);
  url.hash = 'verify=' + token;
  const explanation = 'Someone requested access to your ER Limousine Service guest reservation.';
  const expiry = 'Use this link once within ' + LINK_MINUTES + ' minutes. You can ignore it if you did not request access.';
  return {
    to,
    subject: 'Verify access to your ER Limousine reservation',
    text: [explanation, url.href, expiry].join('\n\n'),
    html: '<p>' + explanation + '</p><p><a href="' + url.href + '">Verify reservation access</a></p><p>' + expiry + '</p>',
    idempotencyKey: 'booking-email/' + crypto.randomUUID()
  };
}

function parseRequest(body) {
  const base = ['requestId', 'kind', 'confirmed'];
  const extra = {pickup_schedule: ['date', 'time'], locations: ['pickup', 'dropoff'], cancellation: []};
  if (body?.kind === 'locations' && Object.hasOwn(body, 'stops')) extra.locations.push('stops');
  if (!body || typeof body.kind !== 'string' || !Object.hasOwn(extra, body.kind) || !exactKeys(body, [...base, ...extra[body.kind]]) ||
      typeof body.requestId !== 'string' || !UUID.test(body.requestId) || body.confirmed !== true) {
    throw new ManagementError(400, 'Invalid reservation request.');
  }
  const details = {};
  if (body.kind === 'pickup_schedule') {
    if (typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date) ||
        typeof body.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.time)) {
      throw new ManagementError(400, 'Enter a valid pickup date and time.');
    }
    details.date = body.date;
    details.time = body.time;
  }
  if (body.kind === 'locations') {
    for (const name of ['pickup', 'dropoff']) {
      if (typeof body[name] !== 'string') throw new ManagementError(400, 'Enter a valid pickup or destination address.');
      const value = body[name].trim();
      if (value.length > 200 || /[<>\x00-\x1f\x7f]/.test(value) ||
          (value && (value.length < 3 || !/[\p{L}\p{N}]/u.test(value)))) {
        throw new ManagementError(400, 'Enter a valid pickup or destination address.');
      }
      if (value) details[name] = value;
    }
    if (Object.hasOwn(body,'stops')) {
      try { details.stops = bookingStops.parseStops(body.stops,'oneway'); }
      catch (error) { throw new ManagementError(400,error.message); }
    }
    if (!Object.keys(details).length) throw new ManagementError(400, 'Enter a pickup or destination address.');
  }
  return {requestId: body.requestId.toLowerCase(), kind: body.kind, details};
}

function schedule(record, parseDateTime) {
  try {
    const t = record.trip;
    return parseDateTime(t.date, t.time, 'pickup');
  } catch (_) {
    return NaN;
  }
}

function canRequest(record, now, parseDateTime) {
  return ['awaiting_payment', 'confirmed', 'assigned'].includes(record.status) &&
    schedule(record, parseDateTime) > now;
}

function checkProposedChange(record, request, now, parseDateTime) {
  if (request.kind === 'cancellation' && record.status !== 'cancelled') return;
  if (!canRequest(record, now, parseDateTime)) {
    throw new ManagementError(409, 'This reservation is no longer available for online requests.');
  }
  const t = record.trip;
  if (request.kind === 'pickup_schedule') {
    const {date, time} = request.details;
    if (date === t.date && time === t.time) throw new ManagementError(400, 'Choose a different pickup date or time.');
    let proposed, returnAt;
    try {
      proposed = parseDateTime(date, time, 'pickup');
      if (t.tripType === 'roundtrip') returnAt = parseDateTime(t.returnDate, t.returnTime, 'return');
    } catch (_) {
      throw new ManagementError(400, 'Enter a valid pickup date and time in New York.');
    }
    if (proposed <= now || (returnAt !== undefined && proposed >= returnAt)) {
      throw new ManagementError(400, 'Choose a future pickup before the return trip, if applicable.');
    }
  }
  if (request.kind === 'locations') {
    const {stops, pickup, dropoff} = request.details;
    const stopKeys = values => values.map(({placeId,waitMinutes})=>[placeId,waitMinutes]);
    if (stops && !bookingStops.supports(t.tripType)) throw new ManagementError(400,bookingStops.errors.unsupported);
    const differentStops = stops && JSON.stringify(stopKeys(stops)) !==
      JSON.stringify(stopKeys(bookingStops.template(record.quote) || []));
    if (!(pickup && pickup !== t.pickup) && !(dropoff && dropoff !== t.dropoff) && !differentStops) {
      throw new ManagementError(400, stops ? 'Request a different pickup, destination, or stop itinerary.' :
        'Enter a different pickup or destination address.');
    }
  }
}

function tripFingerprint(record) {
  const t = record.trip;
  const fields = [t.pickup, t.pickupPlaceId, t.dropoff, t.dropoffPlaceId,
    t.date, t.time, t.returnDate, t.returnTime, t.tripType, t.vehicle, t.passengers];
  if (record.quote?.stopPlan) fields.push(bookingStops.template(record.quote));
  return hashToken(JSON.stringify(fields));
}

function requestView(row) {
  return {
    id: row.id,
    kind: row.kind,
    details: row.details,
    status: row.status,
    submittedAt: new Date(row.created_at).toISOString(),
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    ...(row.cancellation_applied_at ? {cancellationAppliedAt: new Date(row.cancellation_applied_at).toISOString(),
      refundReviewRequired: true} : {})
  };
}

function reservationView(record, now, parseDateTime, bookingReference = null, editable = false) {
  const trip = tripDto(record);
  const canEdit = canRequest(record, now, parseDateTime);
  return {
    reference: trip.reference,
    bookingReference,
    status: trip.status,
    pickup: trip.pickup,
    dropoff: trip.dropoff,
    date: trip.date,
    time: trip.time,
    returnDate: trip.returnDate,
    returnTime: trip.returnTime,
    vehicle: trip.vehicle,
    passengers: trip.passengers,
    total: trip.total,
    currency: trip.currency,
    paymentStatus: trip.paymentStatus,
    paymentVerificationPending: trip.paymentVerificationPending,
    refundStatus: trip.refundStatus,
    ...bookingStops.publicSummary(record.quote),
    ...(editable && canEdit && bookingStops.supports(trip.tripType) ?
      {stopTemplate:bookingStops.template(record.quote) || []} : {}),
    canRequest: canEdit,
    canRequestCancellation: record.status !== 'cancelled',
    canPay: trip.paymentStatus !== 'paid' && !['cancelled', 'completed'].includes(trip.status) &&
      !trip.paymentVerificationPending
  };
}

module.exports = {
  UUID, LINK_MINUTES, GRANT_MINUTES, LINK_MESSAGE, REQUEST_STATUSES,
  ManagementError, exactKeys, normalizeGuestEmail, guestToken, guestTokenHash, verificationEmail,
  parseRequest, checkProposedChange, canRequest, tripFingerprint, requestView, reservationView
};
