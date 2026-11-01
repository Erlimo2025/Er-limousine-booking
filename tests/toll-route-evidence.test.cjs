const test=require('node:test'),assert=require('node:assert/strict');
const e=require('../services/toll-route-evidence'),r=require('../services/official-toll-rates'),f=require('./helpers/official-toll-fixtures.cjs');
function fixture(crossing='lincoln',direction='ny_bound',departure='2026-11-10T17:00:00Z'){
 const c=f.catalog(),data=f.googleRoute(crossing,direction),origin='ChIJ_fixture_origin',destination='ChIJ_fixture_destination';
 return {c,data,route:{data,origin,destination,departure},direction,profile:{...f.profile(),official:f.profile().official2026},env(){return {OFFICIAL_TOLL_COVERAGE_JSON:JSON.stringify(c)};}};
}
const eligibility=h=>({policy:'interstate_only',pickupState:h.direction==='nj_bound'?'NY':'NJ',dropoffState:h.direction==='nj_bound'?'NJ':'NY',pickupPlaceId:'ChIJ_fixture_origin',dropoffPlaceId:'ChIJ_fixture_destination'});
const price=h=>e.priceRoutes([h.route],h.profile,h.env(),eligibility(h),{now:Date.parse(h.route.departure)});
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
 path.push([-73.94,40.835],[-73.942,40.82],[-73.945,40.80],[-73.95,40.782],[-73.96,40.77],[-73.98,40.755]);
 for(let i=5;i<path.length;i++){
  h.c.nodes.push({id:'gwb_n'+i,point:path[i],state:'NY'});
  h.c.roads.push({id:'gwb_road'+(i-1),from:'gwb_n'+(i-1),to:'gwb_n'+i,kind:'free',bothDirections:true,corridor:f.corridor(path[i-1],path[i]),evidence:'synthetic-ny-road-survey',...f.span});
 }
 h.data.legs[0].steps=path.slice(1).map((p,i)=>({staticDuration:'300s',polyline:{encodedPolyline:f.encode([path[i],p])}}));
 h.data.duration=h.data.staticDuration=(h.data.legs[0].steps.length*300)+'s';h.data.distanceMeters=25000;
 const q=price(h);assert.equal(q.amountCents,2379);assert.equal(q.legs[0].components[1].amountCents,900);assert.equal(q.legs[0].components[2].amountCents,0);
});
test('missing road coverage, duplicate network identity, stale evidence and wrong server endpoint binding fail closed',()=>{
 for(const change of [h=>h.c.roads=[],h=>h.c.roads.push(structuredClone(h.c.roads[0])),h=>delete h.c.roads[0].evidence,
  h=>h.route.origin='forged',h=>h.c.nodes[0].state='NY',h=>h.c.version='reviewed-route-geometry-2026-v1',h=>h.c.routes=[],h=>h.c.validUntil='2026-01-05T00:00:00Z',
  h=>h.c.roads[0].corridor=f.rectangle(-80,40,-79.99,40.01)]){
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
  h=>h.profile.official.crossingCredit.eligibility='unknown',h=>delete h.profile.official.crossingCredit,h=>h.profile.official.crossingCredit.evidence='',
  h=>delete h.profile.official.fleet.vehicleRef,h=>h.profile.official.dailyPolicy.vehicleRef='another-vehicle']){const h=fixture();change(h);assert.throws(()=>price(h),r.TollReviewError);}
});
test('independent directions share only a same-quote congestion day and never add a second daily charge or credit',()=>{
 const h=fixture('lincoln','nj_bound'),second={data:f.googleRoute(),origin:h.route.destination,destination:h.route.origin,departure:'2026-11-10T23:00:00Z'},q=e.priceRoutes([h.route,second],h.profile,h.env(),eligibility(h));
 assert.equal(q.legs[0].components[1].amountCents,0);assert.equal(q.legs[1].components[0].amountCents,1679);
 assert.equal(q.legs[1].components[1].amountCents,900);assert.equal(q.legs[1].components[2].amountCents,-300);
 const one=fixture();delete one.profile.official.dailyPolicy;
 one.profile.official.dailyFacts={'2026-11-10':{status:'already_charged',vehicleRef:one.profile.official.fleet.vehicleRef,evidence:'synthetic-settled-day-proof',observedAt:'2026-11-10T12:00:00Z',validUntil:'2026-11-11T05:00:00Z'}};
 assert.equal(price(one).legs[0].components[1].amountCents,0);assert.equal(price(one).legs[0].components[2].amountCents,0);
 one.route.departure='2026-11-11T17:00:00Z';assert.throws(()=>price(one),r.TollReviewError);
});
test('other roads need a unique class/pass/direction/entry-exit tariff; unknown or overlapping evidence is never zero',()=>{
 const h=fixture();f.addRoadCost(h.c,225);assert.equal(price(h).amountCents,2304);
 for(const change of [f=>f.rates.push(structuredClone(f.rates[0])),f=>f.rates[0].entry='lincoln_n0',f=>f.rates[0].currency='CAD',
  f=>f.rates[0].validUntil='2026-11-01T00:00:00Z',f=>f.rates[0].amountCents=null,f=>f.rates[0].vehicleClass='unverified',f=>f.kind='unsupported']){
  const h=fixture();change(f.addRoadCost(h.c,225));assert.throws(()=>price(h),r.TollReviewError);
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
