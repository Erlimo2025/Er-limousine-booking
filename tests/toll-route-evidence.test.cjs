const test=require('node:test'),assert=require('node:assert/strict');
const e=require('../services/toll-route-evidence'),r=require('../services/official-toll-rates'),f=require('./helpers/official-toll-fixtures.cjs');
function fixture(crossing='lincoln',direction='ny_bound',departure='2026-11-10T17:00:00Z'){
 const c=f.catalog(),data=f.googleRoute(crossing,direction),origin='ChIJ_fixture_origin',destination='ChIJ_fixture_destination';
 const m=f.manifest(c,data,origin,destination,{crossing,direction,crzEntries:direction==='ny_bound'&&crossing!=='gwb'?1:0});c.routes.push(m);
 return {c,m,data,route:{data,origin,destination,departure},profile:{official:f.profile().official2026},env(){return {OFFICIAL_TOLL_COVERAGE_JSON:JSON.stringify(c)};}};
}
const price=h=>e.priceRoutes([h.route],h.profile,h.env(),{policy:'interstate_only',pickupState:'NJ',dropoffState:'NY',pickupPlaceId:h.route.origin,dropoffPlaceId:h.route.destination});
test('server geometry identifies each complete crossing in both directions; labels and instructions are ignored',()=>{
 for(const crossing of ['lincoln','holland','gwb'])for(const direction of ['ny_bound','nj_bound']){
  const h=fixture(crossing,direction);h.data.description='via an entirely different tunnel';h.data.legs[0].steps[0].navigationInstruction={instructions:'Holland Tunnel'};
  const q=price(h);assert.equal(q.legs[0].crossing,crossing);assert.equal(q.legs[0].direction,direction);
  assert.equal(q.amountCents,direction==='nj_bound'?0:crossing==='gwb'?1479:2079);
 }
});
test('no Google full-route/leg aggregate is added to published component costs',()=>{
 for(const value of [null,{currencyCode:'CAD',units:'999'},{currencyCode:'USD',units:'-1'}]){
  const h=fixture();h.data.travelAdvisory={tollInfo:{estimatedPrice:value?[value]:[]}};h.data.legs[0].travelAdvisory={tollInfo:{estimatedPrice:[{currencyCode:'USD',units:'500'}]}};
  assert.equal(price(h).amountCents,2079);
 }
});
test('a GWB route entering the geometric zone later has the daily toll and no Lincoln/Holland credit',()=>{
 const h=fixture('gwb'),path=e.geometry(h.data).points;
 path.push([-73.941,40.83],[-73.945,40.80],[-73.96,40.775],[-73.98,40.755]);
 h.data.legs[0].steps=path.slice(1).map((p,i)=>({staticDuration:'300s',polyline:{encodedPolyline:f.encode([path[i],p])}}));
 h.data.duration=h.data.staticDuration=(h.data.legs[0].steps.length*300)+'s';h.m.geometrySha256=e.geometry(h.data).hash;h.m.crzEntries=1;
 const q=price(h);assert.equal(q.amountCents,2379);assert.equal(q.legs[0].components[1].amountCents,900);assert.equal(q.legs[0].components[2].amountCents,0);
});
test('a missing or changed complete-route manifest, endpoint binding or geometry catalog fails closed',()=>{
 for(const change of [h=>h.c.routes=[],h=>h.c.routes.push(structuredClone(h.m)),h=>h.m.allTollsReviewed=false,
  h=>h.m.originPlaceId='forged',h=>h.m.geometrySha256='0'.repeat(64),h=>h.m.catalogSha256='0'.repeat(64),h=>h.m.fleetSha256='0'.repeat(64),h=>h.m.validUntil='2026-01-05T00:00:00Z',
  h=>h.c.crz.excluded.push(f.rectangle(-73.999,40.75,-73.998,40.751))]){
  const h=fixture();change(h);assert.throws(()=>price(h),r.TollReviewError);
 }
});
test('missing, malformed, oversize, disconnected and incomplete provider geometry/timing requires review',()=>{
 for(const change of [h=>delete h.data.legs,h=>h.data.legs[0].steps[0].polyline.encodedPolyline='?',h=>h.data.legs[0].steps[0].polyline.encodedPolyline='a'.repeat(80001),
  h=>h.data.legs[0].steps[1].polyline.encodedPolyline=f.encode([[-73,40],[-72.99,40]]),h=>delete h.data.legs[0].steps[0].staticDuration,
  h=>h.data.staticDuration='999s',h=>h.data.duration='900s',h=>h.data.legs[0].steps[0].staticDuration='NaNs']){
  const h=fixture();change(h);assert.throws(()=>price(h),r.TollReviewError);
 }
 assert.throws(()=>e.coverage({}),r.TollReviewError);assert.throws(()=>e.decode('~'.repeat(20)),r.TollReviewError);
});
test('nearby portal visits without a continuous corridor and routes with multiple crossings are not unique evidence',()=>{
 const h=fixture(),gate=h.c.crossings[0],detour=[gate.nj,[-74.04,40.75],gate.ny];assert.throws(()=>e.crossingEvents(detour,h.c),r.TollReviewError);
 const path=e.geometry(h.data).points;assert.throws(()=>e.crossingEvents([...path,...[...path].reverse()],h.c),r.TollReviewError);
 assert.throws(()=>e.crossingEvents([[-74.1,40.7],[-74.09,40.71]],h.c),r.TollReviewError);
});
test('actual zone segment intersections respect excluded roads, detect a transit between outside endpoints, and reject parallel boundary travel',()=>{
 const zone={polygon:f.rectangle(-74.006,40.70,-73.96,40.764),excluded:[f.rectangle(-74.004,40.70,-74.002,40.764)]};
 assert.deepEqual(e.zoneEntries([[-74.003,40.71],[-74.003,40.75]],zone),[]);
 assert.deepEqual(e.zoneEntries([[-74.003,40.75],[-73.999,40.75]],zone),[0]);
 assert.equal(e.zoneEntries([[-74.01,40.75],[-73.95,40.75]],{...zone,excluded:[]}).length,1);
 assert.throws(()=>e.zoneEntries([[-74.006,40.72],[-74.006,40.75]],zone),r.TollReviewError);
 assert.deepEqual(e.zoneEntries([[-74.001,40.75],[-74.01,40.75]],{...zone,excluded:[]}),[]); // Starting inside is not a new entry.
});
test('crossing-time ranges use preceding route steps and traffic uncertainty, not just the pickup time',()=>{
 const h=fixture('lincoln','ny_bound','2026-11-10T14:55:00Z');assert.equal(r.rateAt(h.route.departure,'pa').cents,1679);
 assert.equal(price(h).legs[0].components[0].amountCents,1479); // Crossed after 10:00 New York.
 h.route.departure='2026-11-10T14:48:00Z';assert.throws(()=>price(h),/unavailable/); // 09:58–10:03 crossing interval.
 h.route.departure='2026-11-10T14:35:00Z';h.data.duration='2400s';assert.throws(()=>price(h),r.TollReviewError);
});
test('unknown daily-entry policy, account/class/tag proof, TLC plan and expired attestations cannot be used',()=>{
 for(const change of [h=>delete h.profile.official.dailyPolicy,h=>h.profile.official.dailyPolicy.operatorApproved=false,
  h=>h.profile.official.fleet.paClass='2Ax',h=>h.profile.official.fleet.singleRearWheels=false,h=>h.profile.official.fleet.tagStatus='mid_tier',
  h=>h.profile.official.fleet.mtaPlan='tlc_per_trip',h=>h.profile.official.fleet.validUntil='2026-11-01T00:00:00Z',h=>delete h.profile.official.timing,
  h=>h.m.creditEligibility='unknown',h=>delete h.m.crzCreditSource,h=>h.m.crzCreditSource='queens_midtown',h=>h.m.crzCreditSource='hugh_carey',
  h=>h.m.crzCreditSource='holland',h=>h.m.crzCreditSource='none',h=>delete h.m.creditEvidence]){const h=fixture();change(h);h.m.fleetSha256=e.digest(h.profile.official);assert.throws(()=>price(h),r.TollReviewError);}
});
test('independent directions share only a same-quote congestion day and never add a second daily charge or credit',()=>{
 const h=fixture(),second={...h.route,departure:'2026-11-10T23:00:00Z'},q=e.priceRoutes([h.route,second],h.profile,h.env(),{});
 assert.equal(q.legs[0].components[1].amountCents,900);assert.equal(q.legs[1].components[0].amountCents,1679);
 assert.equal(q.legs[1].components[1].amountCents,0);assert.equal(q.legs[1].components[2].amountCents,0);
 second.departure='2026-11-11T17:00:00Z';assert.equal(e.priceRoutes([h.route,second],h.profile,h.env(),{}).legs[1].components[1].amountCents,900);
});
test('other toll road costs need independent nonoverlapping spans, dates and tariff evidence; unknown inventory is never zero',()=>{
 const item={id:'nj_road',label:'NJ road',amountCents:225,evidence:'synthetic-road-proof',tariffVersion:'synthetic-rate-2026',segments:[0,0],validFrom:'2026-01-04T05:01:00Z',validUntil:'2027-01-01T04:59:59Z'};
 const h=fixture();h.m.otherTolls=[item];assert.equal(price(h).amountCents,2304);
 for(const tolls of [[{...item,segments:[1,2]}],[item,{...item,id:'another_fee'}],[{...item,id:'google_total'}],[{...item,validUntil:'2026-11-01T00:00:00Z'}],[{...item,amountCents:null}]]){
  const h=fixture();h.m.otherTolls=tolls;assert.throws(()=>price(h),r.TollReviewError);
 }
});
test('catalog geography, duplicate gates and invalid corridors cannot label another location a PA crossing',()=>{
 for(const change of [h=>h.c.crossings[0].nj=[-80,40],h=>h.c.crossings[1].id='lincoln',h=>h.c.crossings[0].corridor.reverse().splice(1,1),h=>h.c.crz.polygon[0]=[-80,35],
  h=>h.c.crz.polygon=[[-74,40.72],[-73.98,40.75],[-74,40.75],[-73.98,40.72]],h=>h.c.crz.polygon=[[-74,40.72],[-73.99,40.73],[-73.98,40.74]]]){
  const h=fixture();change(h);assert.throws(()=>price(h),r.TollReviewError);
 }
});
test('offline inspector prints only candidate metadata, never raw coordinates, evidence or private provider payloads',t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'er-official-inspector-'));
 t.after(()=>{if(path.dirname(dir)!==os.tmpdir()||!path.basename(dir).startsWith('er-official-inspector-'))throw Error('Unexpected temporary path');fs.rmSync(dir,{recursive:true,force:true});});
 const h=fixture(),routePath=path.join(dir,'route.json'),catalogPath=path.join(dir,'catalog.json');
 fs.writeFileSync(routePath,JSON.stringify({privateMarker:'synthetic-private-marker',routes:[h.data]}));fs.writeFileSync(catalogPath,JSON.stringify(h.c));
 const run=()=>spawnSync(process.execPath,[path.join(__dirname,'../scripts/inspect-toll-route.cjs'),'--route',routePath,'--coverage',catalogPath],{encoding:'utf8'});
 let result=run();assert.equal(result.status,0);const body=JSON.parse(result.stdout);assert.equal(body.status,'candidate_requires_operator_review');assert.equal(body.crossing,'lincoln');assert.equal(body.geometrySha256,e.geometry(h.data).hash);
 assert.doesNotMatch(result.stdout,/synthetic-|encodedPolyline|latitude|longitude|74\.021/);
 fs.writeFileSync(routePath,'synthetic-private-marker');result=run();assert.equal(result.status,1);assert.doesNotMatch(result.stderr,/synthetic-private-marker|route\.json/);
});
