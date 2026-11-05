'use strict';

// A selected-route customer estimate, never a commercial settlement certificate.
// Pure adapter: no requests, route changes, storage or payment operations.
const crypto=require('node:crypto');
const advance=require('./advance-toll-estimate'),rates=require('./official-toll-rates'),categories=require('./toll-pricing-categories');
const FORMAT='google_routes_backup_v1',POLICY='selected-route-google-toll-estimate-v1';
const recoverable=new Set(('crossing_missing_or_ambiguous crossing_not_matched crossing_ambiguous direction_conflict '+
 'geometry_missing geometry_invalid geometry_disconnected geometry_distance_inconsistent geometry_too_large '+
 'timing_missing timing_inconsistent timing_static_invalid timing_travel_invalid timing_route_limit timing_step_sum_mismatch timing_unavailable '+
 'day_boundary_uncertain unsupported_tariff_date unsupported_tariff unverified_time '+
 'congestion_entry_unknown reverse_congestion_entry_unknown reverse_starting_zone_unknown daily_provider_overlap_unknown '+
 'daily_context_unknown crossing_credit_unverified congestion_event_unverified credit_period_uncertain overnight_daily_credit_unverified').split(' '));
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=rates.review;
const dateFormatter=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
const day=timestamp=>{const p=Object.fromEntries(dateFormatter.formatToParts(new Date(timestamp)).map(p=>[p.type,p.value]));return `${p.year}-${p.month}-${p.day}`;};
const seconds=value=>typeof value==='string'&&/^\d+(?:\.\d{1,9})?s$/.test(value)?Number(value.slice(0,-1)):NaN;
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const assumptions=profile=>({emissionType:profile.emissionType,tollPasses:[...profile.tollPasses],
 estimateOnly:true,commercialRatesVerified:false,congestionCoverageVerified:false,companyAbsorbsDifferences:true});
function validAssumptions(p){
 return plain(p)&&['GASOLINE','DIESEL','ELECTRIC','HYBRID'].includes(p.emissionType)&&
  Array.isArray(p.tollPasses)&&p.tollPasses.length===1&&p.tollPasses[0]==='US_NJ_EZPASSNJ'&&
  p.estimateOnly===true&&p.commercialRatesVerified===false&&p.congestionCoverageVerified===false&&p.companyAbsorbsDifferences===true;
}
function routeHash(e,leg,index){
 return hash({origin:index?e.dropoffPlaceId:e.pickupPlaceId,destination:index?e.pickupPlaceId:e.dropoffPlaceId,
  departure:leg.departure,distanceMeters:leg.distanceMeters,travelSeconds:leg.travelSeconds});
}
function eligibleLocations(e){
 return plain(e)&&e.policy==='interstate_only'&&e.pickupState!==e.dropoffState&&
  [e.pickupPlaceId,e.dropoffPlaceId].every(id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,255}$/.test(id))&&
  e.pickupPlaceId!==e.dropoffPlaceId&&advance.covered({state:e.pickupState,county:e.pickupCounty},{state:e.dropoffState,county:e.dropoffCounty});
}
function noDailyOverlap(legs){
 // Google has no vehicle-day ledger or itemized CRZ component. Never invent a
 // subtraction from two positive aggregates whose possible charge days overlap.
 return legs.length<2||legs.some(l=>l.googleRouteCents===0)||legs[0].arrivalDay<legs[1].departureDay;
}
function estimate(routes,profile,eligibility,parseProvider,primaryReason){
 const pricingCategory=categories.snapshot(profile);
 try{
  if(!recoverable.has(primaryReason))fail('estimate_unavailable');
  if(!advance.eligible(profile)||!validAssumptions(assumptions(profile)))fail('vehicle_estimate_profile_missing');
  if(!eligibleLocations(eligibility))fail('service_coverage_unverified');
  if(!Array.isArray(routes)||routes.length<1||routes.length>2)fail('route_unavailable');
  const legs=[];let previousArrival=-Infinity;
  for(const [index,r]of routes.entries()){
   if(!r||r.origin!==(index?eligibility.dropoffPlaceId:eligibility.pickupPlaceId)||r.destination!==(index?eligibility.pickupPlaceId:eligibility.dropoffPlaceId)||!plain(r.data))fail('route_unavailable');
   if(r.data.unusableForTolls)fail('provider_fallback_route');
   if(typeof r.departure!=='string')fail('unverified_time');
   const departure=rates.instant(r.departure),travelSeconds=seconds(r.data.duration);
   if(!Number.isSafeInteger(r.data.distanceMeters)||r.data.distanceMeters<=0||!Number.isFinite(travelSeconds)||travelSeconds<=0||travelSeconds>21600)fail('route_metrics_invalid');
   if(departure<previousArrival)fail('route_time_order');
   const arrival=departure+travelSeconds*1000;previousArrival=arrival;
   const toll=parseProvider(r.data);
   // An absent advisory/'none' result is not an explicit reliable USD price.
   if(toll.status!=='estimated'||!Number.isSafeInteger(toll.amountCents)||toll.amountCents<0)fail('provider_amount_unknown');
   if(toll.amountCents>100000)fail('estimate_out_of_bounds');
   const leg={status:'estimated',source:'google_routes',direction:index?'return':'outbound',
    amountCents:toll.amountCents,googleRouteCents:toll.amountCents,departure:new Date(departure).toISOString(),
    departureDay:day(departure),arrivalDay:day(arrival),distanceMeters:r.data.distanceMeters,travelSeconds};
   leg.routeHash=routeHash(eligibility,leg,index);legs.push(leg);
  }
  if(!noDailyOverlap(legs))fail('daily_provider_overlap_unknown');
  const amountCents=legs.reduce((n,l)=>n+l.amountCents,0);
  if(!Number.isSafeInteger(amountCents))fail('invalid_total');
  return {version:1,format:FORMAT,policy:POLICY,status:'estimated',currency:'USD',amountCents,estimatedRouteCents:amountCents,
   allowanceCents:0,eligibility,legs,googleAssumptions:assumptions(profile),primaryReviewReason:primaryReason,
   ...(pricingCategory?{pricingCategory}:{})};
 }catch(error){
  return {version:1,status:'unknown',amountCents:null,estimatedRouteCents:null,allowanceCents:0,legs:[],eligibility,
   reviewReason:advance.failureReason(error instanceof rates.TollReviewError?error.reason:null)};
 }
}
function valid(t){
 try{
  if(!plain(t)||t.version!==1||t.format!==FORMAT||t.policy!==POLICY||t.status!=='estimated'||t.currency!=='USD'||
   !recoverable.has(t.primaryReviewReason)||!eligibleLocations(t.eligibility)||!validAssumptions(t.googleAssumptions)||
   !Array.isArray(t.legs)||t.legs.length<1||t.legs.length>2)return false;
  if(t.pricingCategory!==undefined&&(!categories.validSnapshot(t.pricingCategory)||
   t.pricingCategory.emissionType!==t.googleAssumptions.emissionType||JSON.stringify(t.pricingCategory.tollPasses)!==JSON.stringify(t.googleAssumptions.tollPasses)))return false;
  let previousArrival=-Infinity,total=0;
  for(const [index,l]of t.legs.entries()){
   if(!plain(l)||l.status!=='estimated'||l.source!=='google_routes'||l.direction!==(index?'return':'outbound')||
    !Number.isSafeInteger(l.amountCents)||l.amountCents<0||l.amountCents>100000||l.googleRouteCents!==l.amountCents||
    !Number.isSafeInteger(l.distanceMeters)||l.distanceMeters<=0||!Number.isFinite(l.travelSeconds)||l.travelSeconds<=0||l.travelSeconds>21600||
    Object.keys(l).some(k=>!['status','source','direction','amountCents','googleRouteCents','departure','departureDay','arrivalDay','distanceMeters','travelSeconds','routeHash'].includes(k)))return false;
   const departure=rates.instant(l.departure),arrival=departure+l.travelSeconds*1000;
   if(l.departure!==new Date(departure).toISOString()||departure<previousArrival||l.departureDay!==day(departure)||l.arrivalDay!==day(arrival)||l.routeHash!==routeHash(t.eligibility,l,index))return false;
   previousArrival=arrival;total+=l.amountCents;
  }
  return noDailyOverlap(t.legs)&&Number.isSafeInteger(total)&&t.estimatedRouteCents===total&&
   Number.isSafeInteger(t.allowanceCents)&&t.allowanceCents>=0&&t.amountCents===Math.max(0,total-t.allowanceCents);
 }catch(_){return false;}
}
// Bind financial/request assumptions; a different custom diagnostic alone is
// not a different customer price. No geometry or provider response is retained.
function revision(t){return {policy:t.policy,googleAssumptions:t.googleAssumptions,
 ...(t.pricingCategory?{pricingCategory:t.pricingCategory}:{}),legs:t.legs};}
module.exports={FORMAT,POLICY,canFallback:reason=>recoverable.has(reason),estimate,valid,revision};
