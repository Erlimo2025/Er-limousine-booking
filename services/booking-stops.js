'use strict';

const {cents, sum} = require('./route-tolls');
const {digest} = require('./toll-route-evidence');

// Read the accepted version 1 snapshot. This build never quotes or creates a stop plan.
const MAX_STOPS = 3;
const FREE_MINUTES = 5;
const WAIT_OPTIONS = [5, 10, 15, 20, 30];
const WAIT_LABEL = 'Additional Stop Waiting';

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const placeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(value);
const address = value => typeof value === 'string' && value.length <= 200 && value.trim().length >= 3 &&
  /[\p{L}\p{N}]/u.test(value) && !/[<>\x00-\x1f\x7f]/u.test(value);
const supports = type => ['oneway', 'airport'].includes(type);
const billableWaitingMinutes = plannedMinutes => Math.max(0, plannedMinutes - FREE_MINUTES);


function revision(quote) {
  return digest({
    stops: quote.stopPlan, vehicle: quote.vehicleKey, miles: quote.miles, minutes: quote.minutes,
    fare: {currency:quote.currency, baseTotal:quote.baseTotal, discount:quote.discount, discountedFare:quote.discountedFare,
      gratuity:quote.gratuity, originalTotal:quote.originalTotal, surcharges:quote.surcharges, total:quote.total},
    promotion: quote.promotion?.code ?? null, tollRevision: quote.quoteRevision ?? null
  });
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

module.exports = {WAIT_LABEL, validQuote, publicSummary};
