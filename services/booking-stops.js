'use strict';

const {cents, sum} = require('./route-tolls');
const {digest} = require('./toll-route-evidence');

const MAX_STOPS = 3;
const FREE_MINUTES = 5;
const WAIT_OPTIONS = [5, 10, 15, 20, 30];
const DEFAULT_WAITING_RATES_CENTS = Object.freeze({suv: 150, escalade: 150});
const WAIT_LABEL = 'Additional Stop Waiting';
const NO_SPECIAL = 'The $150 EWR to Manhattan special is nonstop only. This trip uses regular pricing.';
const errors = Object.freeze({
  unsupported: 'Intermediate stops are available for one-way and one-way airport trips only.',
  count: 'Add no more than three intermediate stops.',
  invalid: 'Select a valid stop address from the address suggestions.',
  waiting: 'Choose 5, 10, 15, 20, or 30 minutes at each stop.',
  duplicate: 'Each stop must be a distinct location from the pickup, destination, and other stops.',
  coverage: 'Online stop bookings are available for trips within New Jersey and New York City. Contact Dispatch for other stops.',
  rate: 'Only five minutes per stop can be booked online for this vehicle right now. Contact Dispatch for longer waiting.',
  route: 'We could not verify a driving route through all selected stops. Review the addresses or try again.'
});

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const placeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(value);
const address = value => typeof value === 'string' && value.length <= 200 && value.trim().length >= 3 &&
  /[\p{L}\p{N}]/u.test(value) && !/[<>\x00-\x1f\x7f]/u.test(value);
const supports = type => ['oneway', 'airport'].includes(type);
const billableWaitingMinutes = plannedMinutes => Math.max(0, plannedMinutes - FREE_MINUTES);
const fail = key => { throw new Error(errors[key]); };

function parseStops(value, type) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_STOPS) fail('count');
  if (value.length && !supports(type)) fail('unsupported');
  const ids = new Set();
  return Array.from(value, stop => {
    if (!exact(stop, ['address', 'placeId', 'waitMinutes']) || !address(stop.address) || !placeId(stop.placeId)) fail('invalid');
    if (!WAIT_OPTIONS.includes(stop.waitMinutes)) fail('waiting');
    if (ids.has(stop.placeId)) fail('duplicate');
    ids.add(stop.placeId);
    return {address: stop.address.trim(), placeId: stop.placeId, waitMinutes: stop.waitMinutes};
  });
}

function waitingPlan(stops, vehicle, configuredRates) {
  const plannedMinutes = stops.reduce((total, stop) => total + stop.waitMinutes, 0);
  const billableMinutes = stops.reduce((total, stop) => total + billableWaitingMinutes(stop.waitMinutes), 0);
  let rateCentsPerMinute = null;
  if (billableMinutes) {
    let rates = DEFAULT_WAITING_RATES_CENTS;
    if (configuredRates !== undefined && (typeof configuredRates !== 'string' || configuredRates.trim() !== '')) {
      try { rates = JSON.parse(configuredRates); }
      catch (_) { fail('rate'); }
    }
    if (!plain(rates) || !Object.hasOwn(rates, vehicle)) fail('rate');
    rateCentsPerMinute = rates[vehicle];
    if (!Number.isSafeInteger(rateCentsPerMinute) || rateCentsPerMinute <= 0) fail('rate');
  }
  const chargeCents = billableMinutes * (rateCentsPerMinute ?? 0);
  if (!Number.isSafeInteger(chargeCents)) fail('rate');
  return {plannedMinutes, billableMinutes, rateCentsPerMinute, chargeCents};
}

function buildPlan(origin, destination, stops, pickupAt, waiting) {
  return {
    version: 1,
    origin: {placeId: origin.placeId, address: origin.address},
    destination: {placeId: destination.placeId, address: destination.address},
    pickupAt,
    stops: stops.map((stop, index) => ({
      sequence: index + 1, address: stop.address, placeId: stop.placeId, plannedMinutes: stop.waitMinutes,
      freeMinutes: FREE_MINUTES, billableMinutes: billableWaitingMinutes(stop.waitMinutes)
    })),
    ...waiting
  };
}

function addWaiting(quote, plan) {
  quote.stopPlan = plan;
  if (plan.chargeCents) {
    // Keep the existing surcharge snapshot readable by the previous application.
    // Discount and gratuity have already been calculated on the driving fare.
    for (const field of ['baseTotal', 'discountedFare', 'originalTotal', 'total']) {
      quote[field] = sum([cents(quote[field]), plan.chargeCents]) / 100;
    }
    quote.surcharges.push({label: WAIT_LABEL, amount: plan.chargeCents / 100});
  }
}

function revision(quote) {
  return digest({
    stops: quote.stopPlan, vehicle: quote.vehicleKey, miles: quote.miles, minutes: quote.minutes,
    fare: {currency:quote.currency, baseTotal:quote.baseTotal, discount:quote.discount, discountedFare:quote.discountedFare,
      gratuity:quote.gratuity, originalTotal:quote.originalTotal, surcharges:quote.surcharges, total:quote.total},
    promotion: quote.promotion?.code ?? null, tollRevision: quote.quoteRevision ?? null
  });
}

function checkoutRevision(quote) {
  return quote.stopQuoteRevision ?? quote.quoteRevision;
}

function validQuote(quote, type) {
  if (quote.stopPlan === undefined && quote.stopQuoteRevision === undefined) return true;
  try {
    const p = quote.stopPlan;
    if (!supports(type) || quote.fixedOffer || !exact(p, ['version','origin','destination','pickupAt','stops',
      'plannedMinutes','billableMinutes','rateCentsPerMinute','chargeCents']) || p.version !== 1 ||
      ![p.origin, p.destination].every(point => exact(point, ['address','placeId']) && address(point.address) && placeId(point.placeId)) ||
      typeof p.pickupAt !== 'string' || new Date(p.pickupAt).toISOString() !== p.pickupAt ||
      !Array.isArray(p.stops) || p.stops.length < 1 || p.stops.length > MAX_STOPS ||
      !Number.isFinite(quote.miles) || quote.miles <= 0 || !Number.isInteger(quote.minutes) || quote.minutes < 0) return false;
    const ids = new Set([p.origin.placeId, p.destination.placeId]);
    let planned = 0, billed = 0;
    for (const [index, stop] of p.stops.entries()) {
      if (!exact(stop, ['sequence','address','placeId','plannedMinutes','freeMinutes','billableMinutes']) ||
        stop.sequence !== index + 1 || !address(stop.address) || !placeId(stop.placeId) || ids.has(stop.placeId) ||
        !WAIT_OPTIONS.includes(stop.plannedMinutes) || stop.freeMinutes !== FREE_MINUTES ||
        stop.billableMinutes !== billableWaitingMinutes(stop.plannedMinutes)) return false;
      ids.add(stop.placeId);
      planned += stop.plannedMinutes;
      billed += stop.billableMinutes;
    }
    if (p.plannedMinutes !== planned || p.billableMinutes !== billed ||
      (billed ? (!Number.isSafeInteger(p.rateCentsPerMinute) || p.rateCentsPerMinute <= 0) : p.rateCentsPerMinute !== null) ||
      !Number.isSafeInteger(p.chargeCents) || p.chargeCents !== billed * (p.rateCentsPerMinute ?? 0)) return false;
    const waiting = quote.surcharges.filter(item => item.label === WAIT_LABEL);
    if (p.chargeCents ? waiting.length !== 1 || cents(waiting[0].amount) !== p.chargeCents : waiting.length !== 0) return false;
    if (cents(quote.baseTotal) < p.chargeCents ||
        cents(quote.discountedFare) !== cents(quote.baseTotal) - cents(quote.discount) ||
        cents(quote.total) !== sum([cents(quote.discountedFare), cents(quote.gratuity), quote.tolls?.amountCents ?? 0])) return false;
    return quote.stopQuoteRevision === revision(quote);
  } catch (_) { return false; }
}

function template(quote) {
  return quote?.stopPlan?.stops.map(stop => ({address: stop.address, placeId: stop.placeId, waitMinutes: stop.plannedMinutes}));
}

function publicSummary(quote) {
  const plan = quote?.stopPlan;
  if (!plan) return {};
  const {stops, plannedMinutes, billableMinutes, rateCentsPerMinute, chargeCents, origin, destination} = plan;
  return {stopSummary: {
    pickup: origin.address, dropoff: destination.address,
    stops: stops.map(({placeId: _id, ...stop}) => stop),
    plannedMinutes, freeMinutes: plannedMinutes - billableMinutes, billableMinutes, rateCentsPerMinute, chargeCents
  }};
}

function assertRoute(data, route, stopCount) {
  const positive = leg => leg && Number.isFinite(leg.distanceMeters) && leg.distanceMeters > 0 &&
    typeof leg.duration === 'string' && /^\d+(?:\.\d{1,9})?s$/.test(leg.duration) && Number(leg.duration.slice(0,-1)) > 0;
  if (!data || Object.hasOwn(data, 'error') || Object.hasOwn(data, 'fallbackInfo') || !positive(route) ||
      !Array.isArray(route.legs) || route.legs.length !== stopCount + 1 || !route.legs.every(positive)) fail('route');
}

module.exports = {
  errors, WAIT_LABEL, NO_SPECIAL, supports, parseStops, address, waitingPlan, buildPlan, addWaiting, revision,
  checkoutRevision, validQuote, template, publicSummary, assertRoute
};