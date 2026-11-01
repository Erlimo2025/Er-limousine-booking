const test=require('node:test'),{after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{createRequire}=require('node:module');
const plan=require('../docs/toll-acceptance/2026/first-route-cases.json'),official=require('./helpers/official-toll-fixtures.cjs'),geo=require('../services/toll-route-evidence');
const factoryPath=path.join(__dirname,'tolls.test.cjs'),source=fs.readFileSync(factoryPath,'utf8'),cut=source.indexOf("test('provider Money");
assert.ok(cut>0);
const {fixture,normal,origin,access,place,enabled}=new Function('require','__dirname',source.slice(0,cut)+'\nreturn {fixture,normal,origin,access,place,enabled};')(createRequire(factoryPath),__dirname);
const locations=new Map(plan.locations.map(l=>[l.id,l])),results=[];let manualCases=0,sourceAuditPassed=false;

// These coordinates, roads and fleet/day attestations are synthetic controls.
// Public address labels do not convert this mock into a real Google route or
// independently verified road/class evidence. Nothing is approved or deployed.
function simulation(h,c){
 const pickup=locations.get(c.pickup).input,dropoff=locations.get(c.destination).input;
 h.state.searchResults[pickup]=[place('NJ','ChIJ_simulation_'+c.id,pickup)];h.state.searchResults[dropoff]=[place('NY','ChIJ_simulation_midtown',dropoff)];
 const catalog=official.catalog(),data=official.googleRoute(c.requestedCrossing);
 if(c.requestedCrossing==='gwb'){
  const points=geo.geometry(data).points,extension=[[-73.939,40.836],[-73.94,40.821],[-73.94,40.806],[-73.947,40.791],[-73.955,40.776],[-73.97,40.758]];
  let prior=catalog.nodes.find(n=>n.id==='gwb_n4');
  for(const [i,point]of extension.entries()){
   const node={id:'simulation_midtown_n'+i,point,state:'NY'};catalog.nodes.push(node);
   catalog.roads.push({id:'simulation_midtown_road'+i,from:prior.id,to:node.id,corridor:official.corridor(prior.point,point),kind:'free',bothDirections:true,evidence:'synthetic-only-not-reviewed-real-infrastructure',...official.span});prior=node;
  }
  points.push(...extension);data.legs=[{steps:points.slice(1).map((p,i)=>({staticDuration:'60s',polyline:{encodedPolyline:official.encode([points[i],p])}}))}];
  data.duration=data.staticDuration=String((points.length-1)*60)+'s';
 }
 h.context.process.env.OFFICIAL_TOLL_COVERAGE_JSON=JSON.stringify(catalog);h.state.routeResult=()=>structuredClone(data);
 return {...normal,pickup,dropoff,date:'2026-11-10',time:'12:00'};
}

test('DESK REVIEW source geometry is not a certified NJ-to-NY network or verified vehicle',()=>{
 const {audit}=require('../scripts/audit-toll-road-candidates.cjs'),review=audit();
 assert.equal(review.inputSha256,'ad3620669acf14f6df33472e325d2b2dd6abb03ffee74fb3b1bdb2d087d00c3b');
 assert.equal(review.approvedRoadLinks,0);assert.equal(review.approvedRuntimeFacilities,0);assert.equal(review.approvedForActivation,false);
 for(const f of review.facilities){assert.deepEqual(f.stateAttributePairs,['NJ/NJ']);assert.equal(f.runtimeApproval,'not_approved');}
 assert.equal(review.operatorEvidence.vehicleClassification,'pending_user_confirmation');
 assert.equal(review.operatorEvidence.googleRouteGeometry,'pending_no_test_key_or_route_export');
 assert.equal(review.supplementalNyc.candidateFeatureCount,409);assert.equal(review.supplementalNyc.approvedRoadLinks,0);
 assert.equal(plan.approvedForActivation,false);for(const c of plan.cases){assert.equal(c.realRouteStatus,'unverified');assert.equal(c.settledNetTollsCents,null);assert.equal(c.verifiedVehicleClass,null);}
 sourceAuditPassed=true;
});

test('GUARD all six public-address trials require manual review with either unapproved source geometry or missing class',async t=>{
 for(const c of plan.cases){
  const pickup=locations.get(c.pickup).input,dropoff=locations.get(c.destination).input;
  for(const missing of ['unapproved_nj_geometry','unapproved_nyc_geometry','missing_vehicle_profile']){
   const env=missing.startsWith('unapproved_')?{...enabled,OFFICIAL_TOLL_COVERAGE_JSON:undefined,OFFICIAL_TOLL_NETWORK_FILE:path.join(__dirname,'../docs/toll-acceptance/2026/candidate-'+(missing==='unapproved_nj_geometry'?'nj':'nyc')+'-roads.geojson')}:
    {...enabled,TOLL_VEHICLE_PROFILES_JSON:undefined};
   const h=await fixture(t,1375,env);h.state.searchResults[pickup]=[place('NJ','ChIJ_simulation_guard_'+c.id,pickup)];h.state.searchResults[dropoff]=[place('NY','ChIJ_simulation_guard_midtown',dropoff)];
   h.state.routeResult=()=>official.googleRoute(c.requestedCrossing);
   const trip={...normal,pickup,dropoff,crossing:c.requestedCrossing,vehicleClass:'1',historyComplete:true,creditEligibility:'eligible',tolls:{amountCents:0}};
   const q=await h.request('/api/quote',trip);assert.equal(q.status,422);assert.equal(q.body.code,'TOLL_ESTIMATE_UNAVAILABLE');assert.equal(q.body.checkoutAllowed,false);
   for(const paymentChoice of ['now','later']){const r=await h.request('/api/checkout',{...trip,paymentChoice});assert.equal(r.status,422);assert.equal(r.body.code,'TOLL_ESTIMATE_UNAVAILABLE');}
   assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);assert.equal(h.state.payments.calls.length,0);
  }
  manualCases++;
 }
});

for(const c of plan.cases)for(const paymentChoice of ['now','later'])test('SIMULATION '+c.pickup+' '+c.requestedCrossing+' '+(paymentChoice==='now'?'Pay Now':'Pay Later'),async t=>{
 const h=await fixture(t),trip=simulation(h,c),q=await h.request('/api/quote',trip);
 assert.equal(q.status,200);assert.equal(q.body.tolls.legs[0].crossing,c.requestedCrossing);
 const components=q.body.tolls.legs[0].components;
 assert.equal(components[0].amountCents,1479);assert.equal(components[1].amountCents,900);assert.equal(components[2].amountCents,c.requestedCrossing==='gwb'?0:-300);
 assert.equal(q.body.tolls.amountCents,c.requestedCrossing==='gwb'?2379:2079);assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);
 const r=await h.request('/api/checkout',{...trip,paymentChoice,quoteRevision:q.body.quoteRevision});assert.equal(r.status,200);assert.equal(h.records().length,1);
 const booking=h.records()[0];assert.equal(booking.quote.totalCents,q.body.totalCents);assert.equal(booking.paymentStatus,'unpaid');
 assert.equal(h.state.creates.length,paymentChoice==='now'?1:0);
 if(paymentChoice==='later')assert.equal(booking.status,'awaiting_payment');
 for(let i=0;i<2;i++){const complete=await h.request('/api/booking/'+r.body.bookingId+'/checkout',{}, {...origin,cookie:access(r)});assert.equal(complete.status,200);}
 assert.equal(h.state.creates.length,1);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,q.body.totalCents);
 const session=[...h.state.sessions.values()][0];session.status='complete';session.payment_status='paid';assert.equal((await h.webhook(session)).status,200);
 assert.equal(h.records()[0].paymentStatus,'paid');assert.equal(h.records()[0].quote.totalCents,q.body.totalCents);
 results.push({caseId:c.id,paymentChoice,status:'passed_software_simulation_only',quoteMatchesStoredAndStripeMock:true,
  mockCheckoutCreates:1,mockWebhookPaid:true,realRouteVerified:false,realVehicleClassVerified:false,actualCustomerCharged:false});
});

after(()=>{
 const destination=process.env.ER_FIRST_ROUTE_RESULTS_FILE;if(!destination)return;
 const absolute=path.resolve(destination),relative=path.relative(os.tmpdir(),absolute);
 if(relative.startsWith('..')||path.isAbsolute(relative)||path.basename(absolute)!=='first-route-software-results.json')throw Error('Results path must be the dedicated temporary review file');
 fs.writeFileSync(absolute,JSON.stringify({schema:'er-first-route-software-results-v1',engineCommit:plan.engineCommit,
  mode:'local_HTTP_synthetic_providers_only',publicSourceDeskReviewPassed:sourceAuditPassed,manualReviewCasesPassed:manualCases,
  softwareFlowCasesPassed:results.length,expectedFlowCases:12,softwareControlsPassed:sourceAuditPassed&&manualCases===6&&results.length===12,
  realRoutesPassed:0,realVehicleClassesVerified:0,settledEzpassComparisonsCompleted:0,liveStripeCalls:0,realCustomerCharges:0,
  automaticCustomerChargingActivated:false,results},null,2)+'\n');
});
