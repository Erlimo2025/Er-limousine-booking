const crypto = require('node:crypto');

const REVIEW_MESSAGE = 'Toll estimate unavailable — contact us for a final quote';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => JSON.stringify(value, function (key, item) {
  return plain(item) ? Object.fromEntries(Object.keys(item).sort().map(name => [name,item[name]])) : item;
});
const cents = value => {
  const result = Math.round(value * 100);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(result)) throw Error('Invalid money.');
  return result;
};
const sum = values => {
  const result = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(result) || result < 0) throw Error('Invalid money.');
  return result;
};

// Protobuf Money omits zero units/nanos. Never use parseFloat on provider money.
function usdCents(value) {
  if (!plain(value) || value.currencyCode !== 'USD') return null;
  const units = value.units === undefined ? '0' : value.units;
  const nanos = value.nanos === undefined ? 0 : value.nanos;
  if (typeof units !== 'string' || !/^(?:0|[1-9]\d{0,15})$/.test(units) ||
      !Number.isInteger(nanos) || nanos < 0 || nanos > 999999999) return null;
  const result = BigInt(units) * 100n + (BigInt(nanos) + 5000000n) / 10000000n;
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}

function routeTolls(route) {
  const unknown = {status:'unknown',amountCents:null};
  if (!plain(route)) return unknown;
  const advisory = route.travelAdvisory;
  if (advisory !== undefined && !plain(advisory)) return unknown;
  if (!advisory || !Object.hasOwn(advisory, 'tollInfo')) {
    // Do not silently discard evidence from an unexpected leg-only response.
    if (Array.isArray(route.legs) && route.legs.some(leg => leg?.travelAdvisory && Object.hasOwn(leg.travelAdvisory, 'tollInfo'))) return unknown;
    return {status:'none',amountCents:0};
  }
  const prices = advisory.tollInfo?.estimatedPrice;
  // One route total only; never add route and leg prices or currency alternatives.
  if (!plain(advisory.tollInfo) || !Array.isArray(prices) || prices.length !== 1) return unknown;
  const amountCents = usdCents(prices[0]);
  return amountCents === null ? unknown : {status:'estimated',amountCents};
}

const passes = new Set(['US_NJ_EZPASSNJ','US_NY_EZPASSNY','US_PA_EZPASSPA','US_MA_EZPASSMA',
  'US_MD_EZPASSMD','US_DE_EZPASSDE','US_VA_EZPASSVA','US_NH_EZPASSNH','US_ME_EZPASSME',
  'US_RI_EZPASSRI','US_OH_EZPASSOH','US_WV_EZPASSWV','US_NC_EZPASSNC']);
function vehicleProfile(env, vehicle) {
  try {
    const profiles = JSON.parse(env.TOLL_VEHICLE_PROFILES_JSON || '{}');
    const p = plain(profiles) && Object.hasOwn(profiles, vehicle) ? profiles[vehicle] : null;
    if (!plain(p)) return null;
    // Confirmed fleet facts, not a claim that Google's passenger estimate matches
    // commercial or congestion charges. Google has no business/2Ax parameter.
    const suburban = vehicle === 'suv';
    const tollPasses = p.tollPasses === undefined && suburban ? ['US_NJ_EZPASSNJ'] : p.tollPasses;
    if (!['GASOLINE','DIESEL','ELECTRIC','HYBRID'].includes(p.emissionType) ||
        !Array.isArray(tollPasses) || tollPasses.length > 6 || new Set(tollPasses).size !== tollPasses.length ||
        tollPasses.some(pass => !passes.has(pass)) ||
        suburban && (tollPasses.length !== 1 || tollPasses[0] !== 'US_NJ_EZPASSNJ')) return null;
    const compatibleClass = suburban ? p.vehicleClass === undefined || ['2Ax','two_axle_passenger_equivalent'].includes(p.vehicleClass) : p.vehicleClass === 'two_axle_passenger_equivalent';
    return {emissionType:p.emissionType,tollPasses:[...tollPasses],
      ...(suburban ? {accountType:'business',vehicleClass:'2Ax',axles:2} : {}),
      verified:compatibleClass && p.commercialRatesVerified === true && p.congestionCoverageVerified === true};
  } catch (_) { return null; }
}
function requestModifiers(profile) {
  return profile ? {vehicleInfo:{emissionType:profile.emissionType},tollPasses:profile.tollPasses} : {};
}
const states = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
function verifiedState(place) {
  if (!plain(place) || typeof place.id !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(place.id) ||
      typeof place.formattedAddress !== 'string' || !place.formattedAddress.trim() || place.formattedAddress.length > 400 ||
      /[\x00-\x1f\x7f]/.test(place.formattedAddress) || !plain(place.location) ||
      !Number.isFinite(place.location.latitude) || Math.abs(place.location.latitude) > 90 ||
      !Number.isFinite(place.location.longitude) || Math.abs(place.location.longitude) > 180 || !Array.isArray(place.addressComponents)) return null;
  const components = type => place.addressComponents.filter(item => Array.isArray(item?.types) && item.types.includes(type));
  const country = components('country'),state = components('administrative_area_level_1');
  return country.length === 1 && country[0].shortText === 'US' && state.length === 1 && states.has(state[0].shortText) ? state[0].shortText : null;
}
function eligibility(pickup, destination) {
  if (!pickup || !destination || !states.has(pickup.state) || !states.has(destination.state)) throw Error('Unverified locations.');
  return {policy:'interstate_only',pickupState:pickup.state,dropoffState:destination.state,
    pickupPlaceId:pickup.placeId,dropoffPlaceId:destination.placeId};
}
function aggregateTolls(legs, profile, hourly = false, allowanceCents = 0, eligibility = null) {
  if (hourly) return {version:1,status:'unknown',amountCents:null,legs:[],reason:'hourly_route_unknown'};
  if (eligibility?.policy === 'interstate_only' && eligibility.pickupState === eligibility.dropoffState) {
    return {version:1,status:'waived',amountCents:0,estimatedRouteCents:null,allowanceCents:0,eligibility,
      legs:legs.map(() => ({status:'waived',amountCents:0})),reason:'same_state'};
  }
  if (!profile?.verified) return {version:1,status:'unknown',amountCents:null,legs,reason:'vehicle_or_coverage_unverified'};
  if (legs.some(leg => leg.status === 'unknown')) return {version:1,status:'unknown',amountCents:null,legs,reason:'provider_estimate_unknown'};
  let estimatedRouteCents;
  try { estimatedRouteCents=sum(legs.map(leg => leg.amountCents)); }
  catch (_) { return {version:1,status:'unknown',amountCents:null,legs,reason:'invalid_total'}; }
  return {version:1,status:legs.every(leg => leg.status === 'none') ? 'none' : 'estimated',
    amountCents:Math.max(0,estimatedRouteCents-allowanceCents),estimatedRouteCents,allowanceCents,legs,...(eligibility?{eligibility}:{})};
}

// Existing fare (including existing surcharges) remains the discount/gratuity base.
// Tolls are added afterwards, never discounted, tipped, or added a second time.
function priceBreakdown(quote, tolls, special = false) {
  const surcharges = quote.surcharges.map(item => ({label:item.label,amountCents:cents(item.amount)}));
  const surchargesCents = sum(surcharges.map(item => item.amountCents));
  const fareCents = cents(quote.baseTotal);
  const tollsCents = special ? 0 : tolls.amountCents;
  const tripFareCents = fareCents - surchargesCents;
  if (tripFareCents < 0 || tollsCents === null) throw Error('Invalid money.');
  const totalCents = sum([cents(quote.discountedFare),cents(quote.gratuity),tollsCents]);
  return {version:1,tripFareCents,surcharges,discountCents:cents(quote.discount),gratuityCents:cents(quote.gratuity),
    tollsCents:special ? null : tollsCents,tollAllowanceCents:special ? 0 : tolls.allowanceCents,tollsIncluded:special,totalCents,currency:'usd',
    ...(!special && tolls.eligibility?{tollScope:'interstate_only',interstate:tolls.eligibility.pickupState!==tolls.eligibility.dropoffState}:{})};
}
function quoteRevision(quote) {
  return crypto.createHash('sha256').update(canonical({pricing:quote.pricingBreakdown,total:quote.total,
    offer:quote.fixedOffer?.code || null,promo:quote.promotion?.code || null,
    ...(quote.tolls?.eligibility?{eligibility:quote.tolls.eligibility}:{})})).digest('hex');
}
function attachTolls(quote, tolls, special = false) {
  quote.tolls = special ? {...tolls,status:'included',internalStatus:tolls.status,amountCents:null} : tolls;
  quote.pricingBreakdown = priceBreakdown(quote, tolls, special);
  quote.totalCents = quote.pricingBreakdown.totalCents;
  quote.total = quote.totalCents / 100;
  if (!special) quote.originalTotal = sum([cents(quote.originalTotal),tolls.amountCents]) / 100;
  quote.quoteRevision = quoteRevision(quote);
  return quote;
}
function validQuote(quote) {
  if (quote.pricingBreakdown === undefined && quote.tolls === undefined && quote.totalCents === undefined && quote.quoteRevision === undefined) return true; // Legacy immutable fare.
  try {
    const p=quote.pricingBreakdown,t=quote.tolls;
    if (!plain(p) || p.version !== 1 || !plain(t) || t.version !== 1 || p.currency !== 'usd' || quote.currency !== 'usd' ||
        !Array.isArray(p.surcharges) || !Array.isArray(t.legs) || t.legs.length > 2 ||
        !['none','estimated','included','waived'].includes(t.status)) return false;
    if(t.eligibility !== undefined || p.tollScope !== undefined || p.interstate !== undefined){
      const e=t.eligibility;
      if(!plain(e) || e.policy!=='interstate_only' || p.tollScope!=='interstate_only' ||
        !states.has(e.pickupState) || !states.has(e.dropoffState) || p.interstate!==(e.pickupState!==e.dropoffState) ||
        ![e.pickupPlaceId,e.dropoffPlaceId].every(id=>typeof id==='string' && /^[A-Za-z0-9_-]{1,255}$/.test(id)) ||
        (p.interstate===false && t.status!=='waived') || (p.interstate===true && t.status==='waived'))return false;
    }
    for (const value of [p.tripFareCents,p.discountCents,p.gratuityCents,p.totalCents,quote.totalCents]) {
      if (!Number.isSafeInteger(value) || value < 0) return false;
    }
    if (t.status === 'included') {
      if (quote.fixedOffer?.code !== 'EWR_MANHATTAN_SUV' || quote.fixedOffer.price !== 150 || quote.vehicleKey !== 'suv' || p.tollsIncluded !== true || p.tollsCents !== null || t.amountCents !== null ||
          p.totalCents !== 15000 || p.tripFareCents !== 15000 || p.discountCents !== 0 || p.gratuityCents !== 0 || p.surcharges.length || quote.promotion !== null) return false;
    } else if(t.status==='waived') {
      if(!t.eligibility || p.interstate!==false || p.tollsIncluded!==false || t.amountCents!==0 || p.tollsCents!==0 ||
        t.estimatedRouteCents!==null || t.allowanceCents!==0 || t.reason!=='same_state' || t.legs.length<1 ||
        t.legs.some(leg=>!plain(leg) || leg.status!=='waived' || leg.amountCents!==0))return false;
    } else {
      if (p.tollsIncluded !== false || !Number.isSafeInteger(t.amountCents) || t.amountCents < 0 || p.tollsCents !== t.amountCents || t.legs.length < 1) return false;
      for (const leg of t.legs) if (!plain(leg) || !['none','estimated'].includes(leg.status) || !Number.isSafeInteger(leg.amountCents) || leg.amountCents < 0 || leg.status === 'none' && leg.amountCents !== 0) return false;
      if (!Number.isSafeInteger(t.allowanceCents) || t.allowanceCents < 0 || sum(t.legs.map(leg => leg.amountCents)) !== t.estimatedRouteCents ||
          Math.max(0,t.estimatedRouteCents-t.allowanceCents) !== t.amountCents || (t.status === 'none' && t.estimatedRouteCents !== 0)) return false;
    }
    const expected=priceBreakdown(quote,t,t.status === 'included');
    if (canonical(expected) !== canonical(p) || cents(quote.discountedFare) !== Math.max(0,cents(quote.baseTotal)-cents(quote.discount)) ||
        quote.totalCents !== p.totalCents || cents(quote.total) !== p.totalCents ||
        quote.total !== p.totalCents / 100 || quote.quoteRevision !== quoteRevision(quote)) return false;
    return true;
  } catch (_) { return false; }
}
function customerPricing(quote) {
  if (!quote.pricingBreakdown || !validQuote(quote)) return null;
  return {...quote.pricingBreakdown,tollStatus:quote.tolls.status};
}
module.exports={REVIEW_MESSAGE,cents,sum,usdCents,routeTolls,vehicleProfile,requestModifiers,verifiedState,eligibility,aggregateTolls,attachTolls,validQuote,customerPricing};
