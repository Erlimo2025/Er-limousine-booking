'use strict';
// Advance estimate policy, not E-ZPass settlement or certified road coverage.
const geo=require('./toll-route-evidence'),rates=require('./official-toll-rates');
const reference=require('./data/toll-estimate-reference-2026.json');
const categories=require('./toll-pricing-categories');
const VERSION='interstate-advance-estimate-2026-v1',FALLBACK='company_includes_unknown_tolls_v1';
// Closed diagnostic vocabulary: never return provider/request text or locations.
const failureReasons=new Set(('estimate_unavailable vehicle_estimate_profile_missing location_unverified service_coverage_unverified '+
 'provider_request_failed provider_configuration_unavailable provider_response_invalid provider_fallback_route provider_amount_unknown provider_toll_evidence_conflict '+
 'route_unavailable route_metrics_invalid route_time_order geometry_missing geometry_invalid geometry_disconnected geometry_distance_inconsistent geometry_too_large '+
 'crossing_missing_or_ambiguous direction_conflict congestion_entry_unknown reverse_congestion_entry_unknown reverse_starting_zone_unknown daily_provider_overlap_unknown '+
 'timing_missing timing_inconsistent timing_unavailable day_boundary_uncertain unsupported_tariff_date unsupported_tariff unverified_time '+
 'daily_context_unknown crossing_credit_unverified congestion_event_unverified credit_period_uncertain overnight_daily_credit_unverified estimate_out_of_bounds invalid_total').split(' '));
const failureReason=reason=>failureReasons.has(reason)?reason:'estimate_unavailable';
const counties=new Set(['New York County','Kings County','Queens County','Bronx County','Richmond County']);
const servicePlace=p=>p?.state==='NJ'||p?.state==='NY'&&counties.has(p.county);
function covered(from,to){return servicePlace(from)&&servicePlace(to);}
function included(eligibility,reason='estimate_unavailable'){
 // Compatibility helper for already accepted company-included snapshots only.
 return {version:1,status:'absorbed',amountCents:0,estimatedRouteCents:null,allowanceCents:0,legs:[],
  eligibility,policy:FALLBACK,reason,scope:'nj_nyc_five_boroughs'};
}
function eligible(profile){
 if(profile?.customerEstimate!==undefined)return categories.validProfile(profile);
 const p=profile?.estimate;
 return !!(p?.paClass1Eligible===true&&p.axles===2&&p.singleRearWheels===true&&p.noTrailer===true&&
  p.mtaPlan==='standard_daily'&&p.tlcLicensed===false&&typeof p.crossingCreditEligible==='boolean'&&
  profile.tollPasses?.length===1&&profile.tollPasses[0]==='US_NJ_EZPASSNJ');
}
function segments(paths){return paths.flatMap(line=>line.slice(1).map((b,i)=>[line[i],b]));}
const facilities=reference.crossings.map(c=>({...c,nj:segments(c.nj),ny:segments(c.ny)}));
const witnesses=segments(reference.crzStreetWitnesses.flatMap(s=>s.paths));
function samples(g){
 const result=[];
 for(let i=0;i<g.points.length-1;i++){
  const a=g.points[i],b=g.points[i+1],distance=geo.distance(a,b),n=Math.max(1,Math.ceil(distance/40));
  for(let j=0;j<n;j++)result.push({point:[a[0]+(b[0]-a[0])*(j+.5)/n,a[1]+(b[1]-a[1])*(j+.5)/n],segment:i,order:result.length,meters:distance/n});
  if(result.length>12000)rates.review('geometry_too_large');
 }
 return result;
}
const near=(p,lines)=>lines.some(([a,b])=>geo.nearSegment(p,a,b).distance<=45);
function streetWitness(points,lines=witnesses){
 let first=null,length=0;
 for(const p of points){
  if(!near(p.point,lines)){first=null;length=0;continue;}
  if(first===null)first=p;length+=p.meters;if(length>=200)return first;
 }
 return null;
}
function detect(g,refs=facilities){
 const points=samples(g),matches=[];
 for(const f of refs){
  const nj=points.filter(p=>near(p.point,f.nj)),ny=points.filter(p=>near(p.point,f.ny));
  if(nj.reduce((n,p)=>n+p.meters,0)<150||ny.reduce((n,p)=>n+p.meters,0)<150)continue;
  // Require traversal between distinct agency reference portions, not a name,
  // nearby address, single intersecting point or invented connecting road.
  const west=nj.reduce((a,b)=>a.point[0]<b.point[0]?a:b),east=ny.reduce((a,b)=>a.point[0]>b.point[0]?a:b);
  if(geo.distance(west.point,east.point)<600||east.point[0]-west.point[0]<.004)continue;
  matches.push({crossing:f.id,direction:west.order<east.order?'ny_bound':'nj_bound',start:Math.min(west.segment,east.segment),end:Math.max(west.segment,east.segment)});
 }
 if(matches.length!==1)rates.review('crossing_missing_or_ambiguous');return {gate:matches[0],points};
}
function windowRate(g,start,end,departure,kind){
 const first=rates.instant(departure)+g.segments[start].start*1000,last=rates.instant(departure)+(g.segments[end].end+g.traffic)*1000;
 if(last<first||last-first>8*3600000)rates.review('timing_unavailable');
 let rate=rates.rateAt(first,kind);
 for(let t=first;t<=last;t+=60000){const r=rates.rateAt(t,kind);if(r.day!==rate.day)rates.review('day_boundary_uncertain');if(r.cents>rate.cents)rate=r;}
 const final=rates.rateAt(last,kind);if(final.day!==rate.day)rates.review('day_boundary_uncertain');return final.cents>rate.cents?final:rate;
}
function estimate(routes,profile,eligibility,parseProvider){
 const pricingCategory=categories.snapshot(profile);
 try{
  if(!eligible(profile)||!Array.isArray(routes)||!routes.length||routes.length>2)rates.review('vehicle_estimate_profile_missing');
  const ledger=new Map(),providerByDay=new Map(),legs=[];let priorEnd=0;
  for(const [i,r]of routes.entries()){
   if(!r||r.origin!==(i?eligibility.dropoffPlaceId:eligibility.pickupPlaceId)||r.destination!==(i?eligibility.pickupPlaceId:eligibility.dropoffPlaceId))rates.review('route_unavailable');
   if(r.data?.unusableForTolls)rates.review('provider_fallback_route');
   const g=geo.geometry(r.data),departure=rates.instant(r.departure);if(departure<priorEnd)rates.review('route_time_order');priorEnd=departure+g.travel*1000;
   const {gate,points}=detect(g),paRate=windowRate(g,gate.start,gate.end,r.departure,'pa'),pa=gate.direction==='ny_bound'?paRate.cents:0;
   const chargeBefore=ledger.get(paRate.day)?.chargedCents||0;
   if(gate.direction!==((i?eligibility.dropoffState:eligibility.pickupState)==='NJ'?'ny_bound':'nj_bound'))rates.review('direction_conflict');
   // A matched local street below 60th is positive entry evidence, not a full
   // CRZ polygon. West Street/FDR are never included in this witness inventory.
   const witness=streetWitness(points);
   const enters=gate.direction==='ny_bound'&&(['lincoln','holland'].includes(gate.crossing)||witness!==null);
   const nyPoints=gate.direction==='ny_bound'?g.points.slice(gate.end+1):g.points.slice(0,gate.start+1);
   const northOnly=nyPoints.length>0&&nyPoints.every(p=>p[1]>40.78);
   if(gate.direction==='nj_bound'&&(i?eligibility.dropoffCounty:eligibility.pickupCounty)!=='New York County'&&!northOnly)rates.review('reverse_congestion_entry_unknown');
   if(gate.direction==='nj_bound'&&!northOnly&&(!witness||witness.order!==0))rates.review('reverse_starting_zone_unknown');
   if(gate.crossing==='gwb'&&!enters&&!northOnly&&gate.direction==='ny_bound')rates.review('congestion_entry_unknown');
   let congestion=0,credit=0,day=null;
   if(enters){
    const mta=windowRate(g,gate.end,witness?Math.max(gate.end,witness.segment):gate.end,r.departure,'mta');day=mta.day;
    const before=ledger.get(day)||{chargedCents:0,creditedCents:0};
    const source=['lincoln','holland'].includes(gate.crossing)?gate.crossing:null;
    const c=rates.creditAmounts({kind:'entry',period:mta.peak?'peak':'overnight',creditSource:source,
     crossingPeriod:mta.peak?'peak':'overnight',creditEligibility:(pricingCategory?pricingCategory.crossingCreditAssumption==='eligible_peak':profile.estimate.crossingCreditEligible)?'eligible':'ineligible',crossingPaidCents:pa,
     chargedBefore:before.chargedCents,creditedBefore:before.creditedCents});
    congestion=c.amountCents;credit=c.creditCents;ledger.set(day,c.stateAfter);
   }
   const google=parseProvider(r.data);if(google.status==='unknown')rates.review('provider_amount_unknown');
   if(google.status==='none'&&pa>0)rates.review('provider_toll_evidence_conflict');
   // Google has no vehicle/day ledger. A nonzero aggregate on another same-day
   // leg could contain a second copy of CRZ. Do not guess a subtraction or
   // charge that uncertain overlap; require a final quote instead.
   if(chargeBefore>0&&google.amountCents>0||congestion>0&&(providerByDay.get(paRate.day)||0)>0)rates.review('daily_provider_overlap_unknown');
   providerByDay.set(paRate.day,(providerByDay.get(paRate.day)||0)+google.amountCents);
   const officialSubtotalCents=pa+congestion-credit;
   // A single whole-route estimate envelope: never aggregate + components.
   // The company absorbs any shortfall, including unsupported commercial or
   // congestion differences. The residual is NOT an invented road tariff.
   const amountCents=Math.max(google.amountCents,officialSubtotalCents);if(amountCents>100000)rates.review('estimate_out_of_bounds');
   legs.push({status:'estimated',amountCents,googleRouteCents:google.amountCents,officialSubtotalCents,
    paCents:pa,congestionCents:congestion,creditCents:credit,day,crossing:gate.crossing,direction:gate.direction,geometryHash:g.hash});
  }
  const amountCents=legs.reduce((n,l)=>n+l.amountCents,0);if(!Number.isSafeInteger(amountCents)||amountCents<0)rates.review('invalid_total');
  return {version:1,format:'advance_estimate_2026',policy:VERSION,status:'estimated',amountCents,estimatedRouteCents:amountCents,
   ...(pricingCategory?{pricingCategory}:{}),
   allowanceCents:0,eligibility,legs,assumption:'First chargeable entry per booking/day; no assertion of actual vehicle-day history.',referenceHash:geo.digest(reference)};
 }catch(error){return {version:1,status:'unknown',amountCents:null,estimatedRouteCents:null,allowanceCents:0,legs:[],eligibility,
  ...(pricingCategory?{pricingCategory}:{}),reviewReason:failureReason(error instanceof rates.TollReviewError?error.reason:null)};}
}
function valid(t){
 if(t.format!=='advance_estimate_2026'||t.policy!==VERSION||!t.eligibility||t.eligibility.pickupState===t.eligibility.dropoffState||
  typeof t.referenceHash!=='string'||!/^[a-f0-9]{64}$/.test(t.referenceHash)||!Array.isArray(t.legs)||t.legs.length<1||t.legs.length>2)return false;
 if(t.pricingCategory!==undefined&&(!categories.validSnapshot(t.pricingCategory)||
  t.pricingCategory.crossingCreditAssumption==='none'&&t.legs.some(l=>l.creditCents!==0)))return false;
 const ledger=new Map();
 return t.legs.every(l=>{
  if(l.day!==null){
   if(typeof l.day!=='string'||!/^2026-\d{2}-\d{2}$/.test(l.day))return false;
   const before=ledger.get(l.day)||{charge:0,credit:0};
   if(l.congestionCents>0&&before.charge>0||l.creditCents>0&&(l.direction!=='ny_bound'||!['lincoln','holland'].includes(l.crossing)))return false;
   const charge=before.charge+l.congestionCents,credit=before.credit+l.creditCents;
   if(credit>500||credit>charge||l.creditCents>300||charge===225&&credit>0)return false;
   ledger.set(l.day,{charge,credit});
  }else if(l.congestionCents!==0||l.creditCents!==0)return false;
  return ['lincoln','holland','gwb'].includes(l.crossing)&&['ny_bound','nj_bound'].includes(l.direction)&&
  /^[a-f0-9]{64}$/.test(l.geometryHash)&&[l.googleRouteCents,l.officialSubtotalCents,l.paCents,l.congestionCents,l.creditCents,l.amountCents].every(n=>Number.isSafeInteger(n)&&n>=0)&&
  (l.direction==='ny_bound'?[1479,1679]:[0]).includes(l.paCents)&&[0,225,900].includes(l.congestionCents)&&l.creditCents<=500&&
  l.officialSubtotalCents===l.paCents+l.congestionCents-l.creditCents&&l.amountCents<=100000&&l.amountCents===Math.max(l.googleRouteCents,l.officialSubtotalCents);
 });
}
module.exports={VERSION,FALLBACK,covered,included,eligible,estimate,valid,detect,samples,windowRate,streetWitness,failureReason};
