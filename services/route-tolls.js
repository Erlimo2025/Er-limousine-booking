const crypto = require('node:crypto');
const officialRates = require('./official-toll-rates');
const officialRoutes = require('./toll-route-evidence');
const advance = require('./advance-toll-estimate');
const categories = require('./toll-pricing-categories');

const REVIEW_MESSAGE = 'Toll estimate unavailable — contact us for a final quote';
const reviewError=reason=>Object.assign(new Error(REVIEW_MESSAGE),{status:422,tollReview:true,tollReason:advance.failureReason(reason)});
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isOfficial = tolls => ['official_2026','official_network_2026'].includes(tolls?.format);
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
      verified:compatibleClass && p.commercialRatesVerified === true && p.congestionCoverageVerified === true,
      ...(plain(p.estimate2026)?{estimate:p.estimate2026}:{}),
      ...(plain(p.official2026)&&p.official2026.vehicleKey===vehicle?{official:p.official2026}:{})};
  } catch (_) { return null; }
}
function requestModifiers(profile) {
  return profile ? {vehicleInfo:{emissionType:profile.emissionType},tollPasses:profile.tollPasses} : {};
}
function customerEstimateProfile(pricing,env,vehicle){
  const selected=categories.resolve(pricing,vehicle);
  return selected.assigned?selected.profile:vehicleProfile(env,vehicle);
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
    ...(!special && tolls.eligibility?{tollScope:'interstate_only',interstate:tolls.eligibility.pickupState!==tolls.eligibility.dropoffState}:{}),
    ...(!special && isOfficial(tolls)?{tariffVersion:tolls.tariffVersion,
      tollComponents:tolls.legs.flatMap((leg,index)=>leg.components.map(c=>({...c,label:(tolls.legs.length===2?(index?'Return — ':'Outbound — '):'')+c.label}))),
      tollAssumptions:[...new Set(tolls.legs.map(leg=>leg.dailyAssumption).filter(Boolean))]}:{})};
}
function quoteRevision(quote) {
  return crypto.createHash('sha256').update(canonical({pricing:quote.pricingBreakdown,total:quote.total,
    offer:quote.fixedOffer?.code || null,promo:quote.promotion?.code || null,
    ...(quote.tolls?.eligibility?{eligibility:quote.tolls.eligibility}:{}),
    ...(quote.tolls?.format==='advance_estimate_2026'||quote.tolls?.status==='absorbed'?{advance:{
      policy:quote.tolls.policy,status:quote.tolls.status,referenceHash:quote.tolls.referenceHash,
      ...(quote.tolls.pricingCategory?{pricingCategory:quote.tolls.pricingCategory}:{}),
      legs:quote.tolls.legs.map(({geometryHash,...financial})=>financial)}}:{}),
    ...(isOfficial(quote.tolls)?{official:{coverageHash:quote.tolls.coverageHash,fleetHash:quote.tolls.fleetHash,
      ...(quote.tolls.format==='official_network_2026'?{networkVersion:quote.tolls.networkVersion}:{}),
      routes:quote.tolls.legs.map(leg=>({...(quote.tolls.format==='official_network_2026'?{}:{geometryHash:leg.geometryHash}),
        ...(quote.tolls.tariffVersion===officialRates.CREDIT_VERSION?{congestionEvents:leg.congestionEvents}:{}),
        crossing:leg.crossing,direction:leg.direction,congestionDay:leg.congestionDay}))}}:{})})).digest('hex');
}
function validCreditEvents(leg,seen,tokens){
  if(!Array.isArray(leg.congestionEvents)||leg.congestionEvents.length>32||leg.dailyAssumption!==null)return false;
  let charges=0,credits=0;const sources=new Set();
  for(const event of leg.congestionEvents){
    if(!plain(event)||event.day!==leg.congestionDay||!/^2026-\d{2}-\d{2}$/.test(event.day)||
      new Date(event.day+'T12:00:00Z').toISOString().slice(0,10)!==event.day)return false;
    const before={chargedCents:event.chargedBefore,creditedCents:event.creditedBefore};
    if(seen.has(event.day)&&canonical(seen.get(event.day))!==canonical(before))return false;
    if(event.creditSource!==null){
      if(typeof event.creditToken!=='string'||!/^[a-f0-9]{64}$/.test(event.creditToken)||tokens.has(event.creditToken))return false;
      tokens.add(event.creditToken);sources.add(event.creditSource);
      const source=['lincoln','holland'].includes(event.creditSource)?
        (leg.direction==='ny_bound'&&event.creditSource===leg.crossing?leg.components[0]:null):leg.components.slice(3).find(c=>c.facility===event.creditSource);
      if(!source||event.crossingPaidCents!==source.amountCents)return false;
    }else if(event.creditToken!==null||event.crossingPeriod!==null||event.creditEligibility!==null||event.crossingPaidCents!==0)return false;
    const result=officialRates.creditAmounts(event);
    if(result.amountCents!==event.chargeCents||result.creditCents!==event.creditCents)return false;
    seen.set(event.day,result.stateAfter);charges+=event.chargeCents;credits+=event.creditCents;
  }
  return leg.components[1].amountCents===charges&&leg.components[2].amountCents===-credits&&
    (leg.congestionEvents.length>0?leg.congestionDay!==null:leg.congestionDay===null)&&
    leg.creditSource===(sources.size===1?[...sources][0]:null);
}
function validOfficial(t) {
  const network=t.format==='official_network_2026';
  const daily=network&&t.tariffVersion===officialRates.CREDIT_VERSION,seen=new Map(),tokens=new Set();
  if(network&&t.networkVersion!=='reviewed-road-network-2026-v2')return false;
  if(!daily&&t.tariffVersion!==officialRates.VERSION||![t.coverageHash,t.fleetHash].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))return false;
  for(const leg of t.legs){
    if(!['lincoln','holland','gwb'].includes(leg.crossing)||!['ny_bound','nj_bound'].includes(leg.direction)||
      typeof leg.geometryHash!=='string'||!/^[a-f0-9]{64}$/.test(leg.geometryHash)||
      leg.congestionDay!==null&&(typeof leg.congestionDay!=='string'||!/^2026-\d{2}-\d{2}$/.test(leg.congestionDay))||
      leg.dailyAssumption!==null&&(typeof leg.dailyAssumption!=='string'||leg.dailyAssumption.length>200)||
      !Array.isArray(leg.components)||leg.components.length<3||leg.components.length>23)return false;
    const [pa,mta,credit,...other]=leg.components;
    if(pa.kind!=='port_authority'||pa.label!=='Port Authority crossing'||pa.facility!==leg.crossing||
      !(leg.direction==='ny_bound'?[1479,1679]:[0]).includes(pa.amountCents)||
      mta.kind!=='mta_congestion'||mta.label!=='MTA congestion'||mta.facility!=='manhattan_crz'||![0,225,900].includes(mta.amountCents)||
      credit.kind!=='crossing_credit'||credit.label!=='Eligible credit'||credit.facility!=='manhattan_crz_credit'||
      (network?(!Number.isSafeInteger(credit.amountCents)||credit.amountCents>0||credit.amountCents< (daily?-500:-300)):![0,-300].includes(credit.amountCents))||
      !network&&credit.amountCents<0&&(leg.direction!=='ny_bound'||leg.crossing==='gwb'||mta.amountCents!==900))return false;
    if(daily){if(!validCreditEvents(leg,seen,tokens))return false;}
    else if(network){
      if(leg.creditSource!==null&&!['lincoln','holland','queens_midtown','hugh_carey'].includes(leg.creditSource))return false;
      if(credit.amountCents<0){
        const source=['lincoln','holland'].includes(leg.creditSource)?(leg.direction==='ny_bound'&&leg.creditSource===leg.crossing?pa:null):other.find(c=>c.facility===leg.creditSource);
        if(mta.amountCents!==900||!source||source.amountCents< -credit.amountCents)return false;
      }
    }
    const ids=new Set([pa.facility,mta.facility,credit.facility]);
    for(const c of other){if(c.kind!=='other'||typeof c.facility!=='string'||!/^[a-z0-9_-]{3,60}$/.test(c.facility)||ids.has(c.facility)||
      typeof c.label!=='string'||!c.label.trim()||c.label.length>80||/[\x00-\x1f<>]/.test(c.label)||
      !Number.isSafeInteger(c.amountCents)||c.amountCents<0||c.amountCents>100000)return false;ids.add(c.facility);}
    if(leg.components.reduce((n,c)=>n+c.amountCents,0)!==leg.amountCents)return false;
  }
  return true;
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
        !['none','estimated','included','waived','absorbed'].includes(t.status)) return false;
    if(t.pricingCategory!==undefined&&(!categories.validSnapshot(t.pricingCategory)||
      t.format!=='advance_estimate_2026'&&t.status!=='absorbed'))return false;
    if(t.format!==undefined&&(t.format==='advance_estimate_2026'?(!advance.valid(t)||t.status!=='estimated'):(!isOfficial(t)||t.status!=='estimated'||!validOfficial(t))))return false;
    if((t.format==='advance_estimate_2026'||t.status==='absorbed')&&!advance.covered(
      {state:t.eligibility?.pickupState,county:t.eligibility?.pickupCounty},{state:t.eligibility?.dropoffState,county:t.eligibility?.dropoffCounty}))return false;
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
      if(t.status==='absorbed') {
        if(t.policy!==advance.FALLBACK||t.scope!=='nj_nyc_five_boroughs'||!t.eligibility||p.interstate!==true||p.tollsIncluded!==false||
          t.amountCents!==0||t.estimatedRouteCents!==null||t.allowanceCents!==0||p.tollsCents!==0||t.legs.length!==0||t.reason!=='estimate_unavailable')return false;
      } else {
      if (p.tollsIncluded !== false || !Number.isSafeInteger(t.amountCents) || t.amountCents < 0 || p.tollsCents !== t.amountCents || t.legs.length < 1) return false;
      for (const leg of t.legs) if (!plain(leg) || !['none','estimated'].includes(leg.status) || !Number.isSafeInteger(leg.amountCents) || leg.amountCents < 0 || leg.status === 'none' && leg.amountCents !== 0) return false;
      if (!Number.isSafeInteger(t.allowanceCents) || t.allowanceCents < 0 || sum(t.legs.map(leg => leg.amountCents)) !== t.estimatedRouteCents ||
          Math.max(0,t.estimatedRouteCents-t.allowanceCents) !== t.amountCents || (t.status === 'none' && t.estimatedRouteCents !== 0)) return false;
      }
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
  const {tollComponents,tollAssumptions,...pricing}=quote.pricingBreakdown;
  return {...pricing,tollStatus:quote.tolls.status};
}
function customerQuote(quote){
  if(quote.tolls?.format!=='advance_estimate_2026'&&quote.tolls?.status!=='absorbed')return quote;
  return {...quote,pricingBreakdown:customerPricing(quote),tolls:{version:1,status:quote.tolls.status,amountCents:quote.tolls.amountCents}};
}
module.exports={REVIEW_MESSAGE,reviewError,failureReason:advance.failureReason,cents,sum,usdCents,routeTolls,vehicleProfile,customerEstimateProfile,requestModifiers,verifiedState,eligibility,aggregateTolls,attachTolls,validQuote,customerPricing,
  customerQuote,
  advanceCoverage:advance.covered,advanceEligible:advance.eligible,priceAdvanceRoutes:(routes,profile,eligibility)=>advance.estimate(routes,profile,eligibility,routeTolls),
  officialFieldMask:officialRoutes.FIELD_MASK,priceOfficialRoutes:officialRoutes.priceRoutes};
