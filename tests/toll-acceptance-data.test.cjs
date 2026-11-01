const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {validate,defaultRoot}=require('../scripts/validate-toll-acceptance.cjs');
const network=require('../services/toll-road-network'),{TollReviewError}=require('../services/official-toll-rates');

test('public acceptance data preserves source integrity and all unknown/unapproved states',()=>{
 const report=validate();
 assert.equal(report.publicRoadCandidates,3722);assert.equal(report.approvedRoadLinks,0);
 assert.equal(report.plannedRouteCases,45);assert.equal(report.realRouteCasesExecuted,0);assert.equal(report.timeProfiles,15);
});

test('public candidate geometry cannot become runtime approved coverage',()=>{
 assert.throws(()=>network.coverage({OFFICIAL_TOLL_NETWORK_FILE:path.join(defaultRoot,'candidate-nj-roads.geojson')}),TollReviewError);
});

test('acceptance inventory, tariff references and planned routes cannot authorize runtime tolls',()=>{
 for(const file of ['network-inventory.json','published-tariff-reference.json','route-testing-matrix.json'])
  assert.throws(()=>network.coverage({OFFICIAL_TOLL_COVERAGE_JSON:fs.readFileSync(path.join(defaultRoot,file),'utf8')}),TollReviewError);
});

test('acceptance matrix covers public origins, both directions and preserved business/payment controls',()=>{
 const m=JSON.parse(fs.readFileSync(path.join(defaultRoot,'route-testing-matrix.json'),'utf8'));
 const place=new Map(m.locations.map(l=>[l.id,l]));
 for(const id of ['orange_hall','orange_library','newark_hall','newark_penn','west_orange','east_orange','montclair'])
  assert.ok(m.cases.some(c=>c.pickup===id&&c.dropoff==='midtown_west'));
 for(const crossing of ['lincoln','holland','gwb'])for(const state of ['NJ','NY'])
  assert.ok(m.cases.some(c=>c.candidateCrossing===crossing&&place.get(c.pickup).state===state));
 assert.equal(m.cases.filter(c=>c.pickup.startsWith('ewr_')).length,4);
 assert.ok(m.cases.some(c=>c.tripType==='hourly'));assert.ok(m.cases.some(c=>c.tripType==='round_trip'));
 assert.ok(m.cases.some(c=>place.get(c.pickup).state===place.get(c.dropoff).state));
 assert.match(m.paymentAcceptance.join(' '),/legacy|pre-existing/);assert.match(m.paymentAcceptance.join(' '),/15000/);
});

test('accepted published credit references do not certify routes, fleet or a full route amount',()=>{
 const r=JSON.parse(fs.readFileSync(path.join(defaultRoot,'published-tariff-reference.json'),'utf8'));
 for(const source of ['queens_midtown','hugh_carey']){
  const c=r.mtaCrz.credits.find(c=>c.source===source);assert.equal(c.peakMaximumCents,150);
  assert.equal(c.observations.find(o=>o.sourceId==='mta_crz_schedule').phase1Cents,150);
 }
 for(const e of r.conditionalComponentExamples)assert.equal(e.totalRouteTollsCents,null);
 assert.equal(r.mtaCrz.dailyCreditLimitCents,500);assert.equal(r.approvedForActivation,false);
});
