'use strict';

// Offline public-data review only. No .env, networking, GPS, accounts or database.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const defaultRoot=path.join(__dirname,'../docs/toll-acceptance/2026');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const read=(root,name)=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));

function csvRows(text){
 const rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
  else if(c===','&&!quoted){row.push(cell);cell='';}
  else if(c==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}
  else cell+=c;
 }
 assert.equal(quoted,false,'Unclosed CSV quote');assert.equal(cell,'','CSV must end with newline');assert.equal(row.length,0);
 return rows;
}

function validate(root=defaultRoot){
 const sources=read(root,'sources.json'),geometry=read(root,'candidate-nj-roads.geojson'),provenance=read(root,'geometry-provenance.json'),
  inventory=read(root,'network-inventory.json'),rates=read(root,'published-tariff-reference.json'),matrix=read(root,'route-testing-matrix.json'),manifest=read(root,'checksums.json'),
  nyc=read(root,'candidate-nyc-roads.geojson'),nycProvenance=read(root,'nyc-geometry-provenance.json'),deskReview=read(root,'road-evidence-review.json'),first=read(root,'first-route-cases.json');
 for(const d of [sources,inventory,rates,matrix])assert.equal(d.approvedForActivation,false,'Candidate data must not approve activation');
 assert.equal(geometry.activationApproved,false);assert.equal(provenance.activationApproved,false);
 assert.equal(inventory.runtimeCatalog,null);assert.equal(inventory.approvedRoadLinks,0);assert.equal(inventory.approvedFacilities,0);
 assert.equal(rates.runtimeLoadable,false);
 const ids=new Set(sources.sources.map(s=>s.id));assert.equal(ids.size,sources.sources.length);
 for(const s of sources.sources){
  const url=new URL(s.url);assert.equal(url.protocol,'https:');assert.equal(url.username,'');assert.equal(url.password,'');
  assert.doesNotMatch(url.search,/api[_-]?key|access[_-]?token|password|secret/i);
  if(s.sha256!==null&&s.sha256!==undefined)assert.match(s.sha256,/^[a-f0-9]{64}$/);
 }
 function refs(value){
  if(!value||typeof value!=='object')return;
  for(const [key,v]of Object.entries(value)){
   if(key==='sourceId')assert.ok(ids.has(v),'Unknown source reference '+v);
   if(key==='sourceIds')for(const id of v)assert.ok(ids.has(id),'Unknown source reference '+id);
   refs(v);
  }
 }
 for(const d of [geometry,provenance,inventory,rates,matrix,nyc,nycProvenance,deskReview,first])refs(d);
 assert.equal(geometry.schema,'er-toll-acceptance-geometry-candidate-v1');
 assert.equal(geometry.type,'FeatureCollection');assert.equal(geometry.features.length,3722);assert.equal(geometry.featureCount,3722);
 assert.equal(provenance.count,3722);assert.equal(provenance.pages.reduce((n,p)=>n+p.count,0),3722);
 for(const [i,p]of provenance.pages.entries()){assert.equal(p.offset,i*1000);assert.match(p.sha256,/^[a-f0-9]{64}$/);}
 const featureIds=new Set(),fields=new Set(['OBJECTID','RCL_NGUID','PRIMENAME','SHLD_NUM','SHLD_TYPE','ONEWAY','ROADCLASS','SRI','SOURCE','DATEUPDATE','STATE_L','STATE_R','ELEVTYP_F','ELEVTYP_T','ACCESSSTYP','STATUSTYP','sourceId','reviewStatus','tollStatus','geometrySha256']);
 for(const f of geometry.features){
  assert.equal(f.type,'Feature');assert.equal(f.geometry.type,'LineString');assert.ok(f.geometry.coordinates.length>=2);
  assert.equal(f.id,'njogis_'+f.properties.OBJECTID);assert.equal(featureIds.has(f.id),false);featureIds.add(f.id);
  assert.equal(f.properties.reviewStatus,'candidate_unreviewed');assert.equal(f.properties.tollStatus,'unknown');assert.equal(f.properties.sourceId,'njogis_centerlines');
  assert.equal(f.properties.geometrySha256,sha(JSON.stringify(f.geometry)));
  assert.equal(f.properties.STATUSTYP,'A');
  for(const k of Object.keys(f.properties))assert.ok(fields.has(k),'Unexpected exported field '+k);
  for(const p of f.geometry.coordinates){assert.equal(p.length,2);assert.ok(p.every(Number.isFinite));assert.ok(p[0]>-76&&p[0]<-72&&p[1]>39&&p[1]<42);}
 }
 assert.equal(nyc.schema,'er-toll-acceptance-nyc-geometry-candidate-v1');assert.equal(nyc.type,'FeatureCollection');assert.equal(nyc.activationApproved,false);
 assert.equal(nyc.features.length,409);assert.equal(nyc.featureCount,409);assert.equal(nycProvenance.featureCount,409);assert.equal(nycProvenance.activationApproved,false);
 assert.equal(nycProvenance.sourceId,'nyc_oti_centerlines');assert.equal(nycProvenance.datasetId,'inkn-q76z');assert.match(nycProvenance.responseSha256,/^[a-f0-9]{64}$/);
 const query=new URL(nycProvenance.url);assert.equal(query.origin,'https://data.cityofnewyork.us');assert.equal(query.pathname,'/resource/inkn-q76z.geojson');
 assert.equal(query.searchParams.get('$where'),nycProvenance.where);assert.equal(query.searchParams.get('$limit'),'1500');assert.equal(query.searchParams.get('$order'),'objectid ASC');
 assert.equal(query.searchParams.get('$select'),nycProvenance.fields.join(','));
 const nycIds=new Set(),nycFields=new Set([...nycProvenance.fields.filter(f=>f!=='the_geom'),'sourceId','reviewStatus','tollStatus','geometrySha256']);
 for(const f of nyc.features){
  assert.equal(f.type,'Feature');assert.equal(f.geometry.type,'MultiLineString');assert.ok(f.geometry.coordinates.length>0);
  assert.equal(f.id,'nyc_cscl_'+f.properties.objectid);assert.equal(nycIds.has(f.id),false);nycIds.add(f.id);
  assert.equal(f.properties.reviewStatus,'candidate_unreviewed');assert.equal(f.properties.tollStatus,'unknown');assert.equal(f.properties.sourceId,'nyc_oti_centerlines');
  assert.equal(f.properties.geometrySha256,sha(JSON.stringify(f.geometry)));
  for(const k of Object.keys(f.properties))assert.ok(nycFields.has(k),'Unexpected NYC public field '+k);
  for(const line of f.geometry.coordinates){assert.ok(line.length>=2);for(const p of line){assert.equal(p.length,2);assert.ok(p.every(Number.isFinite));assert.ok(p[0]>-76&&p[0]<-72&&p[1]>39&&p[1]<42);}}
 }
 assert.equal(inventory.supplementalNyc.featureCount,409);assert.equal(inventory.supplementalNyc.runtimeCatalog,null);assert.equal(inventory.supplementalNyc.approvedRoadLinks,0);
 for(const facility of inventory.portAuthority)for(const id of facility.nycCoreCandidateFeatureIds)assert.ok(nycIds.has(id));
 assert.deepEqual(deskReview,require('./audit-toll-road-candidates.cjs').audit(root),'Public desk review differs from source attributes');
 assert.equal(first.approvedForActivation,false);assert.equal(first.approvedRoadLinks,0);assert.equal(first.approvedRuntimeFacilities,0);assert.equal(first.cases.length,6);
 const firstLocations=new Set(first.locations.map(l=>l.id)),firstCaseIds=new Set(),firstPairs=new Set();
 for(const l of first.locations){assert.equal(l.placeId,null);assert.equal(l.coordinates,null);}
 for(const c of first.cases){
  assert.equal(firstCaseIds.has(c.id),false);firstCaseIds.add(c.id);assert.equal(firstPairs.has(c.pickup+'/'+c.requestedCrossing),false);firstPairs.add(c.pickup+'/'+c.requestedCrossing);
  assert.ok(firstLocations.has(c.pickup)&&firstLocations.has(c.destination));assert.ok(['lincoln','holland','gwb'].includes(c.requestedCrossing));
  assert.equal(c.realRouteStatus,'unverified');assert.equal(c.settledComparisonStatus,'pending_user_records');assert.equal(c.vehicleClassStatus,'pending_user_confirmation');
  for(const key of ['observedCrossing','routeGeometrySha256','departureTime','observedFacilityTime','verifiedEndpointStates','verifiedVehicleClass','completeVehicleDayHistory','googleEstimateCents','officialFullRouteTollsCents','settledNetTollsCents'])assert.equal(c[key],null);
 }
 const simulation=read(root,'first-route-software-results.json');assert.equal(simulation.mode,'local_HTTP_synthetic_providers_only');assert.equal(simulation.softwareControlsPassed,true);
 assert.equal(simulation.publicSourceDeskReviewPassed,true);assert.equal(simulation.manualReviewCasesPassed,6);assert.equal(simulation.softwareFlowCasesPassed,12);assert.equal(simulation.results.length,12);
 for(const key of ['realRoutesPassed','realVehicleClassesVerified','settledEzpassComparisonsCompleted','liveStripeCalls','realCustomerCharges'])assert.equal(simulation[key],0);
 assert.equal(simulation.automaticCustomerChargingActivated,false);const flowPairs=new Set();
 for(const r of simulation.results){
  assert.ok(firstCaseIds.has(r.caseId));assert.ok(['now','later'].includes(r.paymentChoice));assert.equal(flowPairs.has(r.caseId+'/'+r.paymentChoice),false);flowPairs.add(r.caseId+'/'+r.paymentChoice);
  assert.equal(r.status,'passed_software_simulation_only');assert.equal(r.quoteMatchesStoredAndStripeMock,true);assert.equal(r.mockCheckoutCreates,1);assert.equal(r.mockWebhookPaid,true);
  assert.equal(r.realRouteVerified,false);assert.equal(r.realVehicleClassVerified,false);assert.equal(r.actualCustomerCharged,false);
 }
 for(const f of inventory.portAuthority){assert.equal(f.runtimePortals,null);assert.equal(f.runtimeCorridor,null);assert.equal(f.vehicleProof,'missing');assert.ok(f.candidateFeatureIds.length>0);for(const id of f.candidateFeatureIds)assert.ok(featureIds.has(id));}
 for(const a of inventory.approachCandidates){assert.equal(a.freeCoverageApproved,false);assert.equal(a.tollStatus,'unknown');for(const id of a.featureIds)assert.ok(featureIds.has(id));}
 for(const key of ['turnpikeCandidateFeatureIds','parkwayCandidateFeatureIds'])for(const id of inventory.njta[key])assert.ok(featureIds.has(id));
 assert.equal(inventory.crz.runtimePolygon,null);for(const e of inventory.crz.exclusions)assert.equal(e.runtimePolygon,null);
 for(const c of inventory.crz.creditConnectors)assert.equal(c.runtimeRoadTokens,null);
 assert.equal(rates.currency,'USD');assert.equal(rates.moneyUnit,'integer_cents');
 for(const p of rates.portAuthority){assert.equal(p.nyBoundOffPeakCents,1479);assert.equal(p.nyBoundPeakCents,1679);assert.equal(p.njBoundPaCents,0);assert.equal(p.operatorClassAndTagEvidence,'missing');}
 for(const r of rates.njtaTurnpike.rows){assert.ok(Number.isSafeInteger(r.ezpassCents)&&r.ezpassCents>0);assert.ok(Number.isSafeInteger(r.njOffPeakCents)&&r.njOffPeakCents>0);assert.equal(r.operatorEligibility,'unverified');assert.equal(r.routeUse,'unverified');}
 const adjustment=rates.njtaTurnpike.collectionAdjustments[0];refs(adjustment);
 assert.equal(adjustment.firstExit,'18W');assert.equal(adjustment.subsequentExit,'19W');assert.equal(adjustment.maximumElapsedMinutes,20);
 assert.equal(adjustment.effectiveDate,null);assert.equal(adjustment.routeEligibility,'unverified');assert.match(adjustment.runtimeImplementation,/none/);
 for(const name of ['queens_midtown','hugh_carey']){const r=rates.mtaCrz.credits.find(c=>c.source===name);assert.equal(r.peakMaximumCents,150);assert.match(r.status,/published_reference/);}
 assert.equal(rates.mtaCrz.dailyCreditLimitCents,500);
 assert.ok(rates.runtimeAcceptanceBlockers.some(b=>b.id==='OVERNIGHT_LATER_CREDIT'));assert.ok(rates.runtimeAcceptanceBlockers.some(b=>b.id==='DAILY_CREDIT_CONTEXT'));
 const credits=read(root,'credit-acceptance-scenarios.json');refs(credits);assert.equal(credits.approvedForActivation,false);assert.equal(credits.scenarios.length,12);
 for(const c of credits.scenarios){assert.equal(c.status,'not_run');assert.equal(c.coverageApproved,false);for(const id of c.routeCaseIds)assert.ok(matrix.cases.some(row=>row.id===id));for(const k of ['observedCrossing','actualGoogleEstimateCents','actualSettledCreditCents','actualHistoryEvidence'])assert.equal(c[k],null);}
 for(const e of rates.conditionalComponentExamples){assert.equal(e.totalRouteTollsCents,null);assert.equal(e.otherRouteTollsCents,null);assert.equal(e.knownComponentsCents,e.paCents+e.crzCents+e.creditCents);}
 assert.equal(matrix.status,'planned_not_executed');assert.equal(matrix.cases.length,45);
 const places=new Map(matrix.locations.map(l=>[l.id,l])),profiles=new Set(matrix.timeProfiles.map(p=>p.id)),caseIds=new Set(),usedProfiles=new Set();
 for(const l of places.values()){assert.equal(l.placeId,null);assert.equal(l.coordinates,null);assert.equal(l.verification,'public_reference_only_not_route_evidence');}
 for(const c of matrix.cases){
  assert.equal(caseIds.has(c.id),false);caseIds.add(c.id);assert.ok(places.has(c.pickup)&&places.has(c.dropoff));assert.equal(c.status,'not_run');
  for(const k of ['observedCrossing','selectedRouteEvidence','interchangesObserved','googleAggregateCents','verifiedComponentTotalCents','settledNetTollsCents'])assert.equal(c[k],null);
  for(const p of c.timeProfiles){assert.ok(profiles.has(p));usedProfiles.add(p);}
 }
 assert.deepEqual([...usedProfiles].sort(),[...profiles].sort());
 const csv=csvRows(fs.readFileSync(path.join(root,'route-testing-matrix.csv'),'utf8'));
 assert.equal(csv.length,matrix.cases.length+1);
 for(const [i,c]of matrix.cases.entries())assert.deepEqual(csv[i+1],[c.id,places.get(c.pickup).input,places.get(c.dropoff).input,c.tripType,c.candidateCrossing??'',c.timeProfiles.join('|'),c.goal,c.status]);
 assert.equal(csvRows(fs.readFileSync(path.join(root,'comparison-template.csv'),'utf8')).length,1,'Do not commit private transaction rows');
 assert.equal(manifest.algorithm,'sha256_utf8_lf');
 const filenames=fs.readdirSync(root).filter(n=>n!=='checksums.json').sort();
 assert.deepEqual(Object.keys(manifest.files).sort(),filenames,'Public package manifest incomplete');
 for(const [name,hash]of Object.entries(manifest.files)){assert.equal(path.basename(name),name);assert.equal(sha(fs.readFileSync(path.join(root,name),'utf8').replace(/\r\n/g,'\n')),hash,'Artifact hash differs: '+name);}
 return {publicRoadCandidates:geometry.features.length,publicNycRoadCandidates:nyc.features.length,approvedRoadLinks:0,plannedRouteCases:matrix.cases.length,firstRouteTrials:first.cases.length,realRouteCasesExecuted:0,timeProfiles:profiles.size,sourceReferences:ids.size};
}

if(require.main===module){try{console.log(JSON.stringify({status:'public_candidate_package_valid_not_activation_approval',...validate()},null,2));}catch(error){console.error('Acceptance package check failed: '+error.message);process.exitCode=1;}}
module.exports={validate,csvRows,defaultRoot};
