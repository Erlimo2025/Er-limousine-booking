'use strict';
const crypto=require('node:crypto');
const tariff=require('./official-toll-rates');
const fail=tariff.review,ref=tariff.reference;
const VERSION='reviewed-route-geometry-2026-v1';
const FIELD_MASK='routes.distanceMeters,routes.duration,routes.staticDuration,routes.travelAdvisory.tollInfo,routes.legs.steps.polyline.encodedPolyline,routes.legs.steps.staticDuration,fallbackInfo';
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?
  Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)).digest('hex');
const point=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&Math.abs(p[0])<=180&&Math.abs(p[1])<=90;
const seconds=value=>typeof value==='string'&&/^\d+(?:\.\d{1,9})?s$/.test(value)?Number(value.slice(0,-1)):NaN;
function decode(encoded){
  if(typeof encoded!=='string'||encoded.length>80000)fail('geometry_missing');
  let cursor=0,lat=0,lng=0;const result=[];
  function value(){let n=0,shift=0,part;do{
    if(cursor>=encoded.length||shift>30)fail('geometry_invalid');part=encoded.charCodeAt(cursor++)-63;
    if(part<0||part>63)fail('geometry_invalid');n+=(part&31)*2**shift;shift+=5;
  }while(part>=32);if(n>2147483647)fail('geometry_invalid');return n%2?-(n+1)/2:n/2;}
  while(cursor<encoded.length){lat+=value();lng+=value();const p=[lng/1e5,lat/1e5];if(!point(p)||result.length>=6000)fail('geometry_invalid');result.push(p);}
  if(result.length<2)fail('geometry_invalid');return result;
}
function distance(a,b){const y=(a[1]+b[1])*Math.PI/360;return Math.hypot((b[0]-a[0])*111320*Math.cos(y),(b[1]-a[1])*111320);}
function nearSegment(p,a,b){
  const scale=Math.cos(p[1]*Math.PI/180),x=(b[0]-a[0])*scale,y=b[1]-a[1],px=(p[0]-a[0])*scale,py=p[1]-a[1];
  const f=Math.max(0,Math.min(1,(px*x+py*y)/(x*x+y*y||1)));
  return {distance:Math.hypot(px-f*x,py-f*y)*111320,fraction:f};
}
function inside(p,polygon){let yes=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
  const a=polygon[i],b=polygon[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;
}return yes;}
function polygon(p){
  if(!Array.isArray(p)||p.length<3||p.length>160||!p.every(point))return false;
  const ring=distance(p[0],p.at(-1))<.001?p.slice(0,-1):p;
  if(ring.length<3||new Set(ring.map(x=>JSON.stringify(x))).size!==ring.length)return false;
  let area=0;
  for(let i=0;i<ring.length;i++){
    const a=ring[i],b=ring[(i+1)%ring.length];area+=a[0]*b[1]-b[0]*a[1];
    for(let j=i+1;j<ring.length;j++){
      if(j===i+1||i===0&&j===ring.length-1)continue;
      const c=ring[j],d=ring[(j+1)%ring.length];
      if(intersection(a,b,c,d)!==null||nearSegment(a,c,d).distance<.001||nearSegment(b,c,d).distance<.001)return false;
    }
  }
  return Math.abs(area)>1e-10;
}
function convex(poly){let sign=0;for(let i=0;i<poly.length;i++){
  const a=poly[i],b=poly[(i+1)%poly.length],c=poly[(i+2)%poly.length],cross=(b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);
  if(Math.abs(cross)<1e-14)continue;if(sign&&Math.sign(cross)!==sign)return false;sign=Math.sign(cross);
}return sign!==0;}
// Sanity envelopes only, NOT certified toll/zone geofences. The reviewed catalog
// must supply the actual corridors and excluded-road geometry before activation.
const envelopes={lincoln:[-74.04,40.748,-73.99,40.78],holland:[-74.06,40.712,-73.998,40.74],gwb:[-73.98,40.835,-73.925,40.87]};
const inEnvelope=(p,b)=>p[0]>=b[0]&&p[0]<=b[2]&&p[1]>=b[1]&&p[1]<=b[3];
function geometry(route){
  if(!route||!Array.isArray(route.legs)||route.legs.length<1||route.legs.length>3)fail('geometry_missing');
  const points=[],segments=[];let elapsed=0,count=0;
  for(const leg of route.legs){
    if(!Array.isArray(leg.steps)||!leg.steps.length)fail('geometry_missing');
    for(const step of leg.steps){
      if(++count>600)fail('geometry_too_large');const path=decode(step.polyline?.encodedPolyline),duration=seconds(step.staticDuration);
      if(!Number.isFinite(duration)||duration<0||duration>21600)fail('timing_missing');
      if(points.length&&distance(points.at(-1),path[0])>25)fail('geometry_disconnected');
      if(!points.length)points.push(path[0]);else if(distance(points.at(-1),path[0])>.01){segments.push({start:elapsed,end:elapsed});points.push(path[0]);}
      for(let i=1;i<path.length;i++){
        if(points.length>=6000||distance(points.at(-1),path[i])>5000)fail('geometry_invalid');
        segments.push({start:elapsed,end:elapsed+duration});points.push(path[i]);
      }
      elapsed+=duration;
    }
  }
  const staticTime=seconds(route.staticDuration),travel=seconds(route.duration);
  if(!Number.isFinite(staticTime)||Math.abs(staticTime-elapsed)>1||!Number.isFinite(travel)||travel<staticTime-1||travel>21600||points.length<2)fail('timing_inconsistent');
  const length=points.reduce((n,p,i)=>n+(i?distance(points[i-1],p):0),0);
  if(!Number.isFinite(route.distanceMeters)||route.distanceMeters<=0||length>route.distanceMeters*1.1+100)fail('geometry_distance_inconsistent');
  return {points,segments,hash:digest(points),traffic:Math.max(0,travel-staticTime),travel};
}
function coverage(env){
  const raw=env.OFFICIAL_TOLL_COVERAGE_JSON;
  if(typeof raw!=='string'||raw.length>1000000)fail('coverage_missing');
  let c;try{c=JSON.parse(raw);}catch(_){fail('coverage_invalid');}
  if(!c||c.version!==VERSION||!ref(c.evidence)||!Array.isArray(c.routes)||!c.routes.length||c.routes.length>200||
    !polygon(c.crz?.polygon)||!ref(c.crz.evidence)||!Array.isArray(c.crz.excluded)||c.crz.excluded.length>16||!c.crz.excluded.every(polygon)||
    !Array.isArray(c.crossings)||c.crossings.length!==3||new Set(c.crossings.map(x=>x.id)).size!==3)fail('coverage_invalid');
  for(const gate of c.crossings)if(!['lincoln','holland','gwb'].includes(gate.id)||!point(gate.nj)||!point(gate.ny)||!polygon(gate.corridor)||
    gate.corridor.length>12||!convex(gate.corridor)||!ref(gate.evidence)||!Number.isFinite(gate.portalRadiusMeters)||gate.portalRadiusMeters<5||gate.portalRadiusMeters>150||
    distance(gate.nj,gate.ny)<200||distance(gate.nj,gate.ny)>4000||gate.nj[0]>=gate.ny[0]||
    ![gate.nj,gate.ny,...gate.corridor].every(p=>inEnvelope(p,envelopes[gate.id]))||!inside(gate.nj,gate.corridor)||!inside(gate.ny,gate.corridor))fail('coverage_invalid');
  if(![...c.crz.polygon,...c.crz.excluded.flat()].every(p=>inEnvelope(p,[-74.05,40.65,-73.9,40.79])))fail('coverage_invalid');
  // Geometry catalog changes invalidate all prior full-route coverage attestations.
  c.catalogHash=digest({crossings:c.crossings,crz:c.crz});return c;
}
function crossingEvents(path,catalog){
  const events=[];
  for(const gate of catalog.crossings){
    let first=null;
    for(let i=0;i<path.length-1;i++){
      const a=path[i],b=path[i+1],mid=[(a[0]+b[0])/2,(a[1]+b[1])/2];
      if(!inside(a,gate.corridor)||!inside(b,gate.corridor)||!inside(mid,gate.corridor)){first=null;continue;}
      const hits=[['nj',nearSegment(gate.nj,a,b)],['ny',nearSegment(gate.ny,a,b)]]
        .filter(([,hit])=>hit.distance<=gate.portalRadiusMeters).sort((x,y)=>x[1].fraction-y[1].fraction);
      for(const [side]of hits){
        if(!first)first={side,index:i};
        else if(first.side!==side){events.push({crossing:gate.id,direction:side==='ny'?'ny_bound':'nj_bound',start:first.index,end:i,segment:i});first=null;}
      }
    }
  }
  if(events.length!==1)fail('crossing_missing_or_ambiguous');return events[0];
}
function intersection(a,b,c,d){
  const x=b[0]-a[0],y=b[1]-a[1],u=d[0]-c[0],v=d[1]-c[1],den=x*v-y*u;
  if(Math.abs(den)<1e-14)return null;const t=((c[0]-a[0])*v-(c[1]-a[1])*u)/den,s=((c[0]-a[0])*y-(c[1]-a[1])*x)/den;
  return t>0&&t<1&&s>=0&&s<=1?t:null;
}
function zoneEntries(path,zone){
  const polygons=[zone.polygon,...zone.excluded],inZone=p=>inside(p,zone.polygon)&&!zone.excluded.some(poly=>inside(p,poly));
  let prior=inZone(path[0]);const entries=[];
  for(let i=0;i<path.length-1;i++){
    const a=path[i],b=path[i+1],cuts=[0,1];
    for(const poly of polygons)for(let k=0;k<poly.length;k++){
      const c=poly[k],d=poly[(k+1)%poly.length];
      // Parallel travel along a zone/exclusion edge is not a verified road match.
      if(distance(a,b)>20&&nearSegment(a,c,d).distance<4&&nearSegment(b,c,d).distance<4)fail('zone_boundary_ambiguous');
      const t=intersection(a,b,c,d);if(t!==null)cuts.push(t);
    }
    cuts.sort((x,y)=>x-y);
    for(let j=1;j<cuts.length;j++){
      if(cuts[j]-cuts[j-1]<1e-10)continue;const t=(cuts[j]+cuts[j-1])/2,now=inZone([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);
      if(now&&!prior)entries.push(i);prior=now;
    }
  }
  return entries;
}
function windowAt(g,index,departure,profile){
  const timing=profile.official?.timing;
  if(!timing||!ref(timing.evidence)||!Number.isInteger(timing.uncertaintySeconds)||timing.uncertaintySeconds<0||timing.uncertaintySeconds>3600)fail('timing_policy_unverified');
  const start=tariff.instant(departure),s=g.segments[index],slack=timing.uncertaintySeconds;
  if(!Number.isFinite(start)||!s)fail('timing_missing');
  return {earliest:new Date(start+Math.max(0,s.start-slack)*1000).toISOString(),latest:new Date(start+(s.end+g.traffic+slack)*1000).toISOString()};
}
function priceRoutes(routes,profile,env,eligibility){
  if(!profile?.official||!Array.isArray(routes)||!routes.length||routes.length>2)fail('fleet_or_account_unverified');
  const catalog=coverage(env),seen=new Set(),legs=[],reviewHashes=[],fleetHash=digest(profile.official);
  for(const [index,route]of routes.entries()){
    const g=geometry(route.data),gate=crossingEvents(g.points,catalog),entries=zoneEntries(g.points,catalog.crz);
    const matches=catalog.routes.filter(r=>r.geometrySha256===g.hash&&r.originPlaceId===route.origin&&r.destinationPlaceId===route.destination&&r.fleetSha256===fleetHash);
    if(matches.length!==1)fail('whole_route_coverage_unverified');const manifest=matches[0];
    const last=tariff.instant(route.departure)+(g.travel+profile.official.timing?.uncertaintySeconds)*1000;
    if(manifest.catalogSha256!==catalog.catalogHash||manifest.crossing!==gate.crossing||manifest.direction!==gate.direction||
      manifest.crzEntries!==entries.length||manifest.allTollsReviewed!==true||!ref(manifest.evidence)||
      tariff.instant(manifest.validFrom)>tariff.instant(route.departure)||tariff.instant(manifest.validUntil)<last||!Array.isArray(manifest.otherTolls))fail('whole_route_coverage_unverified');
    const chargedRanges=[];
    for(const item of manifest.otherTolls){
      const range=item.segments;
      if(!Array.isArray(range)||range.length!==2||!range.every(Number.isInteger)||range[0]<0||range[1]<range[0]||range[1]>=g.segments.length||
        range[0]<=gate.end&&range[1]>=gate.start||entries.some(e=>e>=range[0]&&e<=range[1])||chargedRanges.some(r=>range[0]<=r[1]&&range[1]>=r[0])||
        /google|aggregate|total|lincoln|holland|gwb|crz|congestion/i.test(item.id||''))fail('overlapping_or_unverified_tolls');
      const first=windowAt(g,range[0],route.departure,profile),last=windowAt(g,range[1],route.departure,profile);
      if(tariff.instant(item.validFrom)>tariff.instant(first.earliest)||tariff.instant(item.validUntil)<tariff.instant(last.latest))fail('other_toll_schedule_unverified');
      chargedRanges.push(range);
    }
    const crossingTime=windowAt(g,gate.segment,route.departure,profile);
    let zoneEntryTime=null,dailyContext=null;
    if(entries.length){
      // An additional MTA tunnel can change the credit. A PA crossing alone is
      // insufficient evidence of the complete route's congestion-credit rules.
      if(!ref(manifest.creditEvidence)||!['eligible','ineligible'].includes(manifest.creditEligibility)||
        !['none','lincoln','holland'].includes(manifest.crzCreditSource)||
        manifest.crzCreditSource==='none'&&manifest.creditEligibility!=='ineligible'||
        manifest.crzCreditSource!=='none'&&(manifest.crzCreditSource!==gate.crossing||gate.direction!=='ny_bound'))fail('credit_coverage_unverified');
      zoneEntryTime=windowAt(g,entries[0],route.departure,profile);const day=tariff.rateWindow(zoneEntryTime,'mta').day;
      for(const entry of entries)if(tariff.rateWindow(windowAt(g,entry,route.departure,profile),'mta').day!==day)fail('multiple_zone_days_unverified');
      const policy=profile.official.dailyPolicy;
      if(seen.has(day))dailyContext={day,status:'already_charged',evidence:'same-quote-prior-direction'};
      else if(policy?.kind==='assume_first_entry_estimate'&&policy.operatorApproved===true&&ref(policy.evidence))
        dailyContext={day,status:'first_entry_estimate',operatorPolicyApproved:true,evidence:policy.evidence};
      else fail('daily_context_unknown');
    }
    const result=tariff.calculateTariff({version:tariff.VERSION,routeVerified:true,coverageVerified:true,coverageEvidence:manifest.evidence,
      crossing:gate.crossing,direction:gate.direction,crossingTime,fleet:profile.official.fleet,
      entersCrz:entries.length>0,zoneEntryTime,dailyContext,creditEligibility:manifest.creditEligibility,creditEvidence:manifest.creditEvidence,
      otherTolls:manifest.otherTolls});
    if(result.congestionDay)seen.add(result.congestionDay);
    reviewHashes.push(digest(manifest));
    legs.push({status:'estimated',amountCents:result.amountCents,components:result.components,
      crossing:gate.crossing,direction:gate.direction,geometryHash:g.hash,congestionDay:result.congestionDay,dailyAssumption:result.dailyAssumption});
  }
  const amountCents=legs.reduce((n,leg)=>n+leg.amountCents,0);
  if(!Number.isSafeInteger(amountCents)||amountCents<0)fail('invalid_total');
  return {version:1,format:'official_2026',tariffVersion:tariff.VERSION,status:'estimated',amountCents,estimatedRouteCents:amountCents,allowanceCents:0,
    eligibility,legs,coverageHash:digest({catalog:catalog.catalogHash,manifests:reviewHashes}),fleetHash};
}
module.exports={VERSION,FIELD_MASK,digest,decode,geometry,coverage,crossingEvents,zoneEntries,windowAt,priceRoutes};
