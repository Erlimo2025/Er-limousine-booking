const test=require('node:test'),assert=require('node:assert/strict');
const network=require('../services/toll-road-network'),geo=require('../services/toll-route-evidence'),rates=require('../services/official-toll-rates');
const f=require('./helpers/official-toll-fixtures.cjs');
// All road geometry, fleet evidence, extra-road prices and history below are
// synthetic. No real commercial E-ZPass classification/statement is verified.
function fixture(crossing='lincoln',direction='ny_bound'){
 const raw=f.profile();return {c:f.catalog(),profile:{...raw,official:raw.official2026},route:{data:f.googleRoute(crossing,direction),origin:'ChIJ_origin',destination:'ChIJ_destination',departure:'2026-11-10T17:00:00Z'},
 eligibility:{policy:'interstate_only',pickupState:direction==='ny_bound'?'NJ':'NY',dropoffState:direction==='ny_bound'?'NY':'NJ',pickupPlaceId:'ChIJ_origin',dropoffPlaceId:'ChIJ_destination'}};
}
const price=h=>network.priceRoutes([h.route],h.profile,{OFFICIAL_TOLL_COVERAGE_JSON:JSON.stringify(h.c)},h.eligibility,{now:Date.parse(h.route.departure)});
const point=(a,b,t)=>a.map((n,i)=>n+(b[i]-n)*t);
function setPath(h,points,seconds=300){h.route.data={...h.route.data,distanceMeters:30000,duration:(seconds*(points.length-1))+'s',staticDuration:(seconds*(points.length-1))+'s',
 legs:[{steps:points.slice(1).map((p,i)=>({polyline:{encodedPolyline:f.encode([points[i],p])},staticDuration:seconds+'s'}))}]};}
function extend(h,from,points,prefix){let prev=h.c.nodes.find(n=>n.id===from);const ids=[];
 for(const [i,p]of points.entries()){
  const node={id:prefix+'_n'+i,point:p,state:'NY'},road={id:prefix+'_road'+i,from:prev.id,to:node.id,corridor:f.corridor(prev.point,p),kind:'free',bothDirections:true,evidence:'synthetic-extension-survey',...f.span};
  h.c.nodes.push(node);h.c.roads.push(road);ids.push(road.id);prev=node;
 }return ids;
}
function mtaFixture(){
 const h=fixture('gwb'),path=geo.geometry(h.route.data).points;
 const extra=[[-73.94,40.835],[-73.942,40.82],[-73.942,40.802],[-73.943,40.784],[-73.943,40.766],[-73.95,40.749],[-73.955,40.744],[-73.97,40.744],[-73.98,40.744]];
 const links=extend(h,'gwb_n4',extra,'queens');path.push(...extra);setPath(h,path,60);
 const road=h.c.roads.find(r=>r.id===links[7]);road.kind='facility';road.facility='queens_midtown';
 h.c.facilities.push({id:'queens_midtown',kind:'table',authority:'mta',timeBasis:'entry',label:'Queens Midtown Tunnel',evidence:'synthetic-qmt-survey',
  rates:[{entry:road.from,exit:road.to,vehicleClass:'1',tollPass:'US_NJ_EZPASSNJ',currency:'USD',amountCents:777,days:[0,1,2,3,4,5,6],startMinute:0,endMinute:1440,evidence:'synthetic-qmt-rate-proof',version:'synthetic-not-an-actual-mta-rate',...f.span}]});
 return h;
}

test('nine different address pairs reuse one network without endpoint/whole-route preapproval',()=>{
 const h=fixture(),base=geo.geometry(h.route.data).points,totals=[],hashes=new Set(),catalogHash=geo.digest(h.c);
 for(const [i,pickup]of [0,.2,.45].entries())for(const [j,destination]of [.4,.7,1].entries()){
  const path=structuredClone(base);path[0]=point(base[0],base[1],pickup);path[path.length-1]=point(base[3],base[4],destination);setPath(h,path);
  h.route.origin=h.eligibility.pickupPlaceId='ChIJ_nj_address_'+i;h.route.destination=h.eligibility.dropoffPlaceId='ChIJ_nyc_address_'+j;
  const q=price(h);totals.push(q.amountCents);hashes.add(q.legs[0].geometryHash);assert.equal(q.format,'official_network_2026');
 }
 assert.deepEqual(totals,Array(9).fill(2079));assert.equal(hashes.size,9);assert.equal(geo.digest(h.c),catalogHash);assert.equal(h.c.routes,undefined);
 assert.doesNotMatch(JSON.stringify(h.c),/originPlaceId|destinationPlaceId|geometrySha256/);
});

test('new provider point sampling and step boundaries reuse the same physical road links',()=>{
 const h=fixture(),original=price(h),points=geo.geometry(h.route.data).points;setPath(h,points.flatMap((p,i)=>i?[point(points[i-1],p,.5),p]:[p]),150);
 const q=price(h);assert.equal(q.amountCents,2079);assert.notEqual(q.legs[0].geometryHash,geo.geometry(f.googleRoute()).hash);
 const pricing=require('../services/route-tolls'),base={baseTotal:80,discountedFare:80,discount:0,gratuity:0,originalTotal:80,total:80,currency:'usd',surcharges:[],promotion:null,vehicleKey:'suv'};
 const before=pricing.attachTolls(structuredClone(base),original),after=pricing.attachTolls(structuredClone(base),q);
 assert.equal(before.quoteRevision,after.quoteRevision);assert.ok(pricing.validQuote(before));assert.ok(pricing.validQuote(after));
});

test('duplicate provider vertices do not require new approval or erase a subsequent coverage gap',()=>{
 const h=fixture(),points=geo.geometry(h.route.data).points;
 h.route.data.legs[0].steps[0].polyline.encodedPolyline=f.encode([points[0],points[0],points[1]]);
 assert.equal(price(h).amountCents,2079);h.c.roads=h.c.roads.filter(r=>r.id!=='lincoln_road1');assert.throws(()=>price(h),rates.TollReviewError);
});

test('a benign detour can reuse reviewed free links rather than a full-route hash',()=>{
 const h=fixture(),points=geo.geometry(h.route.data).points,detour=[points[0][0]-.001,points[0][1]-.002];
 h.c.nodes.push({id:'detour_node',point:detour,state:'NJ'});
 for(const [id,from,to]of [['detour_first','lincoln_n0','detour_node'],['detour_second','detour_node','lincoln_n1']]){
  const a=h.c.nodes.find(n=>n.id===from),b=h.c.nodes.find(n=>n.id===to);h.c.roads.push({id,from,to,corridor:f.corridor(a.point,b.point),kind:'free',bothDirections:true,evidence:'synthetic-local-street-audit',...f.span});
 }
 setPath(h,[points[0],detour,...points.slice(1)]);assert.equal(price(h).amountCents,2079);
});

test('a gap between covered endpoint vertices is detected across the full segment',()=>{
 const h=fixture();h.c.roads=h.c.roads.filter(r=>r.id!=='lincoln_road1');
 assert.throws(()=>price(h),e=>e.reason==='unmatched_road_segment');
});

test('unknown, unsupported and expired roads stay manual even with no Google toll indicator',()=>{
 for(const change of [h=>h.c.roads[0].kind='unsupported',h=>h.c.roads[0].validUntil='2026-11-01T00:00:00Z',h=>h.c.roads.shift()]){
  const h=fixture();delete h.route.data.travelAdvisory;change(h);assert.throws(()=>price(h),rates.TollReviewError);
 }
});

test('parallel/overlapping road identities are ambiguous; a free-looking candidate cannot win by price',()=>{
 const h=fixture(),duplicate=structuredClone(h.c.roads.find(r=>r.id==='lincoln_road2'));duplicate.id='untrusted_parallel_road';duplicate.kind='free';delete duplicate.facility;h.c.roads.push(duplicate);
 assert.throws(()=>price(h),e=>e.reason==='ambiguous_road_network');
});

test('the full physical path can rule out an unsupported side road at a shared junction',()=>{
 const h=fixture(),start=h.c.nodes[0],end=h.c.nodes[1],branch={id:'unsupported_side_end',point:[end.point[0],end.point[1]+.001],state:'NJ'};
 h.c.nodes.push(branch);h.c.roads.push({id:'unsupported_side_road',from:start.id,to:branch.id,corridor:f.corridor(start.point,branch.point),kind:'unsupported',bothDirections:true,evidence:'synthetic-unsupported-side-street',...f.span});
 assert.equal(price(h).amountCents,2079);
});

test('coincident geometry with disconnected node identity does not establish a continuous road path',()=>{
 const h=fixture();h.c.nodes.push({...h.c.nodes[1],id:'different_junction'});h.c.roads[1].from='different_junction';
 assert.throws(()=>price(h),rates.TollReviewError);
});

test('directed road links deny an unverified reverse traversal',()=>{
 const h=fixture('lincoln','nj_bound');h.c.roads.find(r=>r.id==='lincoln_road0').bothDirections=false;
 assert.throws(()=>price(h),rates.TollReviewError);assert.equal(price(fixture()).amountCents,2079);
});

test('NJ Turnpike tariff lookup uses actual entry/exit and independently configured reverse cost',()=>{
 const h=fixture(),road=f.addRoadCost(h.c,225);road.rates.push({...road.rates[0],entry:'lincoln_n2',exit:'lincoln_n1',amountCents:350});
 assert.equal(price(h).amountCents,2304);
 h.route.data=f.googleRoute('lincoln','nj_bound');h.eligibility.pickupState='NY';h.eligibility.dropoffState='NJ';
 const q=price(h);assert.equal(q.amountCents,350);assert.equal(q.legs[0].components[0].amountCents,0);assert.equal(q.legs[0].components.at(-1).amountCents,350);
});

test('ticket-system entry or exit missing from the selected path requires review',()=>{
 for(const side of ['start','end']){
  const h=fixture();f.addRoadCost(h.c,225);const path=geo.geometry(h.route.data).points;
  setPath(h,side==='start'?[point(path[1],path[2],.5),...path.slice(2)]:path.slice(0,3));
  if(side==='end')h.eligibility.dropoffState='NJ';
  assert.throws(()=>price(h),rates.TollReviewError);
 }
});

test('extra-road schedules preserve distinct weekday, weekend and rush-hour tariff records',()=>{
 const h=fixture(),facility=f.addRoadCost(h.c,133),base=facility.rates[0];
 facility.rates=[{...base,days:[1,2,3,4,5],startMinute:0,endMinute:420},{...base,days:[1,2,3,4,5],startMinute:420,endMinute:540,amountCents:287},
  {...base,days:[1,2,3,4,5],startMinute:540,endMinute:1440},{...base,days:[0,6],amountCents:350}];
 for(const [departure,pa,extra]of [['2026-11-10T11:30:00Z',1679,133],['2026-11-10T13:00:00Z',1679,287],['2026-11-10T17:00:00Z',1479,133],['2026-11-07T15:00:00Z',1479,350],['2026-11-07T17:00:00Z',1679,350]]){
  h.route.departure=departure;const q=price(h);assert.equal(q.legs[0].components[0].amountCents,pa);assert.equal(q.legs[0].components.at(-1).amountCents,extra);
 }
 h.route.departure='2026-11-10T11:58:00Z';assert.throws(()=>price(h),rates.TollReviewError);
});

test('an extra road cannot inherit PA classification, an NY-issued discount, invalid money or overlapping tariffs',()=>{
 for(const change of [(h,f)=>delete h.profile.official.fleet.authorities.njta,(h,f)=>h.profile.official.fleet.authorities.njta.vehicleClass='2',
  (h,f)=>f.rates[0].tollPass='US_NY_EZPASSNY',(h,f)=>f.rates[0].currency='CAD',(h,f)=>f.rates[0].amountCents=2.25,
  (h,f)=>f.rates.push(structuredClone(f.rates[0]))]){
  const h=fixture(),facility=f.addRoadCost(h.c,225);change(h,facility);assert.throws(()=>price(h),rates.TollReviewError);
 }
});

test('GWB plus a verified Queens Midtown entry earns that tunnel credit, without adding Google totals',()=>{
 const h=mtaFixture(),q=price(h);assert.equal(q.amountCents,1479+777+900-150);assert.equal(q.legs[0].creditSource,'queens_midtown');
 assert.equal(q.legs[0].components[2].amountCents,-150);assert.equal(q.legs[0].components.at(-1).amountCents,777);
 h.route.data.travelAdvisory.tollInfo.estimatedPrice=[{currencyCode:'USD',units:'9999'}];assert.equal(price(h).amountCents,q.amountCents);
 const pricing=require('../services/route-tolls'),quote={baseTotal:80,discountedFare:80,discount:0,gratuity:0,originalTotal:80,total:80,currency:'usd',surcharges:[],promotion:null,vehicleKey:'suv'};
 pricing.attachTolls(quote,q);assert.ok(pricing.validQuote(quote));assert.equal(quote.totalCents,11006);
 const changed=structuredClone(quote);changed.tolls.legs[0].creditSource='lincoln';assert.equal(pricing.validQuote(changed),false);
});

test('NYC tunnel charges require that authority class and an unexpired supported tariff',()=>{
 for(const change of [h=>delete h.profile.official.fleet.authorities.mta,h=>h.c.facilities.at(-1).kind='unsupported',h=>h.c.facilities.at(-1).rates[0].validUntil='2026-11-01T00:00:00Z']){
  const h=mtaFixture();change(h);assert.throws(()=>price(h),rates.TollReviewError);
 }
});

function reverseMta(h,departure='2026-11-10T23:00:00Z'){
 const points=geo.geometry(h.route.data).points.reverse();setPath(h,points,60);h.route.departure=departure;
 [h.route.origin,h.route.destination]=[h.route.destination,h.route.origin];
 h.eligibility={...h.eligibility,pickupState:'NY',dropoffState:'NJ',pickupPlaceId:h.route.origin,dropoffPlaceId:h.route.destination};
 const facility=h.c.facilities.at(-1),rate=facility.rates[0];facility.rates.push({...rate,entry:rate.exit,exit:rate.entry});
 return h;
}
test('both NYC tunnels use 150 cents and verified exit geometry can earn a later credit without a new daily charge',()=>{
 for(const name of ['queens_midtown','hugh_carey']){
  const h=mtaFixture();h.c.facilities.at(-1).id=name;h.c.roads.find(r=>r.facility==='queens_midtown').facility=name;
  assert.equal(price(h).legs[0].components[2].amountCents,-150);
  reverseMta(h);Object.assign(h.profile.official.dailyFacts['2026-11-10'],{status:'already_charged',chargedCents:900,creditedCents:300});
  const q=price(h);assert.equal(q.amountCents,627);assert.equal(q.legs[0].components[1].amountCents,0);assert.equal(q.legs[0].components[2].amountCents,-150);
  assert.equal(q.legs[0].congestionEvents[0].kind,'exit');assert.equal(q.legs[0].creditSource,name);
 }
});
test('round-trip entry and exit credits share one complete day ledger and immutable snapshots enforce the chain',()=>{
 const h=mtaFixture(),reverse=reverseMta(structuredClone(h));
 h.c=reverse.c;
 const q=network.priceRoutes([h.route,reverse.route],h.profile,{OFFICIAL_TOLL_COVERAGE_JSON:JSON.stringify(h.c)},h.eligibility,{now:Date.parse(h.route.departure)});
 assert.equal(q.amountCents,1479+777*2+900-300);assert.equal(q.legs[1].components[1].amountCents,0);assert.equal(q.legs[1].components[2].amountCents,-150);
 assert.equal(q.legs[1].congestionEvents[0].creditedBefore,150);
 const pricing=require('../services/route-tolls'),quote={baseTotal:80,discountedFare:80,discount:0,gratuity:0,originalTotal:80,total:80,currency:'usd',surcharges:[],promotion:null,vehicleKey:'suv'};
 pricing.attachTolls(quote,q);assert.ok(pricing.validQuote(quote));
 for(const change of [x=>x.tolls.legs[1].congestionEvents[0].creditedBefore=0,x=>x.tolls.legs[1].congestionEvents[0].creditCents=300,
  x=>x.tolls.legs[1].congestionEvents[0].creditToken=x.tolls.legs[0].congestionEvents[0].creditToken]){
  const changed=structuredClone(quote);change(changed);pricing.attachTolls(changed,changed.tolls);assert.equal(pricing.validQuote(changed),false);
 }
});
test('multiple zone transitions during one physical tunnel traversal never duplicate its per-trip credit',()=>{
 const h=mtaFixture();h.c.crz.excluded=[f.rectangle(-73.966,40.743,-73.964,40.745)];
 const q=price(h);assert.equal(q.amountCents,3006);assert.equal(q.legs[0].components[2].amountCents,-150);
 assert.equal(q.legs[0].congestionEvents.length,2);assert.equal(q.legs[0].congestionEvents[1].creditCents,0);
});
test('a known 450-cent prior credit leaves only 50 cents for the actual NYC crossing',()=>{
 const h=mtaFixture();Object.assign(h.profile.official.dailyFacts['2026-11-10'],{status:'already_charged',chargedCents:900,creditedCents:450});
 const q=price(h);assert.equal(q.amountCents,2206);assert.equal(q.legs[0].components[1].amountCents,0);assert.equal(q.legs[0].components[2].amountCents,-50);
});
test('accepted network v1 snapshot amounts remain valid while new quotes use the corrected version',()=>{
 const h=mtaFixture(),q=price(h),pricing=require('../services/route-tolls');
 q.tariffVersion=rates.VERSION;delete q.legs[0].congestionEvents;q.legs[0].components[2].amountCents=-300;
 q.legs[0].amountCents=q.amountCents=q.estimatedRouteCents=2856;
 const quote={baseTotal:80,discountedFare:80,discount:0,gratuity:0,originalTotal:80,total:80,currency:'usd',surcharges:[],promotion:null,vehicleKey:'suv'};
 pricing.attachTolls(quote,q);assert.equal(pricing.validQuote(quote),true);assert.equal(quote.totalCents,10856);
 assert.equal(price(h).tariffVersion,rates.CREDIT_VERSION);assert.equal(price(h).amountCents,3006);
});

test('credit eligibility is separate evidence and an overnight entry has no credit',()=>{
 const h=fixture();h.profile.official.crossingCredit.eligibility='ineligible';assert.equal(price(h).amountCents,2379);
 h.profile.official.crossingCredit.eligibility='unknown';assert.throws(()=>price(h),rates.TollReviewError);
 h.profile.official.crossingCredit.eligibility='eligible';h.route.departure='2026-11-11T03:00:00Z';assert.equal(price(h).amountCents,1704);
});

test('a reusable Holland-to-zone connector must match in order and remain current',()=>{
 const h=fixture('holland');assert.equal(price(h).amountCents,2079);
 h.c.crz.creditConnectors=[];assert.throws(()=>price(h),e=>e.reason==='credit_connector_unverified');
});

test('daily facts bind the actual vehicle/day and must cover the whole entry-time interval',()=>{
 const h=fixture(),day='2026-11-10',fact={vehicleRef:h.profile.official.fleet.vehicleRef,status:'already_charged',chargedCents:900,creditedCents:300,historyComplete:true,observedAt:'2026-11-10T12:00:00Z',validUntil:'2026-11-11T05:00:00Z',evidence:'synthetic-day-settlement-proof'};
 h.profile.official.dailyFacts={[day]:fact};delete h.profile.official.dailyPolicy;
 assert.equal(price(h).amountCents,1279);assert.equal(price(h).legs[0].components[1].amountCents,0);assert.equal(price(h).legs[0].components[2].amountCents,-200);
 assert.throws(()=>network.priceRoutes([h.route],h.profile,{OFFICIAL_TOLL_COVERAGE_JSON:JSON.stringify(h.c)},h.eligibility,{now:Date.parse('2026-10-31T12:00:00Z')}),rates.TollReviewError);
 for(const patch of [{vehicleRef:'foreign-vehicle'},{observedAt:'2026-11-11T00:00:00Z'},{validUntil:'2026-11-10T17:11:00Z'},{status:'first_entry'},{evidence:''}]){
  h.profile.official.dailyFacts[day]={...fact,...patch};assert.throws(()=>price(h),rates.TollReviewError);
 }
});

test('same-quote complete vehicle/day ledger is reused; another vehicle/day has no inherited history',()=>{
 const h=fixture(),seen=new Map([[h.profile.official.fleet.vehicleRef+'|2026-11-10',{...h.profile.official.dailyFacts['2026-11-10'],day:'2026-11-10',status:'already_charged',chargedCents:900,creditedCents:300}]]);delete h.profile.official.dailyFacts;
 assert.equal(network.dailyContext(h.profile,'2026-11-10',seen,h.route.departure).status,'already_charged');
 assert.throws(()=>network.dailyContext(h.profile,'2026-11-11',seen,h.route.departure),rates.TollReviewError);
 h.profile.official.fleet.vehicleRef='another-synthetic-vehicle';assert.throws(()=>network.dailyContext(h.profile,'2026-11-10',seen,h.route.departure),rates.TollReviewError);
});

test('pure congestion arithmetic handles all four supported credits, caps the credit and rejects unverified inputs',()=>{
 const facts=f.facts(),base={movement:'entry',crossingTime:facts.zoneEntryTime,zoneEntryTime:facts.zoneEntryTime,fleet:facts.fleet,dailyContext:{day:'2026-11-10',chargedCents:0,creditedCents:0,historyComplete:true,evidence:'synthetic-complete-day'},creditEligibility:'eligible',creditEvidence:'synthetic-credit-proof',crossingPaidCents:1679};
 for(const [creditSource,cents]of Object.entries({lincoln:300,holland:300,queens_midtown:150,hugh_carey:150}))assert.equal(rates.calculateCongestion({...base,creditSource}).creditCents,cents);
 assert.equal(rates.calculateCongestion({...base,creditSource:'queens_midtown',crossingPaidCents:125}).creditCents,125);
 assert.equal(rates.calculateCongestion({...base,creditSource:null}).creditCents,0);
 assert.equal(rates.calculateCongestion({...base,creditSource:'lincoln',dailyContext:{...base.dailyContext,status:'already_charged',chargedCents:900,creditedCents:300}}).amountCents,0);
 for(const value of [null,[],{...base,creditSource:'gwb'},{...base,creditSource:'lincoln',creditEligibility:'unknown'},{...base,creditSource:'lincoln',crossingPaidCents:NaN}])assert.throws(()=>rates.calculateCongestion(value),rates.TollReviewError);
});

test('only one bounded server coverage source can load; legacy address manifests cannot enable new quotes',t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'er-road-network-'));
 t.after(()=>{if(path.dirname(dir)!==os.tmpdir()||!path.basename(dir).startsWith('er-road-network-'))throw Error('Unexpected test directory');fs.rmSync(dir,{recursive:true,force:true});});
 const h=fixture(),file=path.join(dir,'network.json');fs.writeFileSync(file,JSON.stringify(h.c));
 assert.equal(network.priceRoutes([h.route],h.profile,{OFFICIAL_TOLL_NETWORK_FILE:file},h.eligibility,{now:Date.parse(h.route.departure)}).amountCents,2079);
 assert.throws(()=>network.coverage({OFFICIAL_TOLL_NETWORK_FILE:file,OFFICIAL_TOLL_COVERAGE_JSON:JSON.stringify(h.c)}),rates.TollReviewError);
 h.c.version='reviewed-route-geometry-2026-v1';h.c.routes=[];assert.throws(()=>price(h),rates.TollReviewError);
 fs.writeFileSync(file,'synthetic-private-invalid-input');assert.throws(()=>network.coverage({OFFICIAL_TOLL_NETWORK_FILE:file}),e=>e instanceof rates.TollReviewError&&!e.message.includes('private-invalid'));
 fs.truncateSync(file,8*1024*1024+1);assert.throws(()=>network.coverage({OFFICIAL_TOLL_NETWORK_FILE:file}),rates.TollReviewError);
});

test('road/schema bounds reject unverified regional boxes, duplicate identity and custom PA price overrides',()=>{
 for(const change of [h=>h.c.roads[0].corridor=f.rectangle(-74.1,40.6,-73.9,40.9),h=>h.c.nodes.push(structuredClone(h.c.nodes[0])),
  h=>h.c.facilities[0].amountCents=1,h=>h.c.junctionMeters=1000,h=>h.c.roads[0].bothDirections='true',h=>delete h.c.roads[0].evidence]){
  const h=fixture();change(h);assert.throws(()=>price(h),rates.TollReviewError);
 }
});
