'use strict';

const crypto = require('node:crypto');
const {cents} = require('./route-tolls');

const REVIEW_WINDOW = 15 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{1,256}\.[A-Za-z0-9_-]{43}$/;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function approvalHash(token) {
  return typeof token === 'string' && TOKEN.test(token) ? digest(token) : null;
}

function terms(quote) {
  const legs = quote.roundTrip ? [quote.roundTrip.outbound, quote.roundTrip.return] : [];
  const route = digest([
    quote.miles, quote.minutes, legs.map(leg => [leg.miles, leg.minutes]),
    (quote.fixedOffer?.verifiedPickup || quote.verifiedPickup)?.placeId ?? null,
    quote.verifiedDropoff?.placeId ?? null
  ]);
  const fare = digest([
    route, quote.vehicleKey, quote.hours, quote.currency,
    cents(quote.baseTotal), cents(quote.discount), cents(quote.gratuity),
    cents(quote.total), legs.map(leg => cents(leg.fare)),
    quote.surcharges.map(({label, amount}) => [label, cents(amount)]),
    quote.fixedOffer?.code, quote.promotion?.code, quote.promotion?.percentOff,
    quote.quoteRevision, quote.stopQuoteRevision
  ]);
  return {fare, route};
}

function createQuoteApproval({secure, now}) {
  // A restart can invalidate a preview, never an accepted reservation.
  const key = crypto.randomBytes(32);
  const cookieName = secure ? '__Host-er_quote_browser' : 'er_quote_browser';
  const cookieOptions = {httpOnly: true, secure, sameSite: 'strict', path: '/', maxAge: 2 * REVIEW_WINDOW};

  function audience(req, res) {
    if (req.customer) return ['customer', req.customer.id, req.customerSessionHash];
    const matches = String(req.headers.cookie || '').split(';').map(cookie => cookie.trim())
      .filter(cookie => cookie.startsWith(cookieName + '='));
    let browser = matches.length === 1 ? matches[0].slice(cookieName.length + 1) : '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(browser)) {
      if (!res) return null;
      browser = crypto.randomBytes(32).toString('base64url');
    }
    if (res) res.cookie(cookieName, browser, cookieOptions);
    return ['browser', browser];
  }

  function sign(req, owner, fingerprint, payload) {
    return crypto.createHmac('sha256', key).update(JSON.stringify([
      'booking-quote-v1', owner, fingerprint, req.body.pickupTerminal, req.body.dropoffTerminal, payload
    ])).digest('base64url');
  }

  function issue(req, res, fingerprint, quote) {
    const {fare, route} = terms(quote);
    const owner = audience(req, res);
    const payload = Buffer.from(JSON.stringify([now() + REVIEW_WINDOW, fare, route, crypto.randomBytes(16).toString('base64url')])).toString('base64url');
    return payload + '.' + sign(req, owner, fingerprint, payload);
  }

  function changeReason(req, fingerprint, quote) {
    const token = req.body.quoteApproval;
    const owner = audience(req);
    if (!owner || typeof token !== 'string' || !TOKEN.test(token)) return 'review_required';
    const [payload, supplied] = token.split('.');
    const expected = sign(req, owner, fingerprint, payload);
    if (!crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return 'review_required';
    const [expiresAt, previousFare, previousRoute] = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (expiresAt <= now()) return 'expired';
    const {fare, route} = terms(quote);
    if (previousFare === fare) return null;
    return previousRoute === route ? 'fare' : 'route';
  }

  return {issue, changeReason};
}

module.exports = {createQuoteApproval, approvalHash};
