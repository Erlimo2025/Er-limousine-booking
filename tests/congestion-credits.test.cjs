const test=require('node:test'),assert=require('node:assert/strict');
const r=require('../services/official-toll-rates'),f=require('./helpers/official-toll-fixtures.cjs');
// Synthetic fleet/history inputs. No real Suburban, account, road or statement
// is certified. Values below follow MTA document/138931 Phase 1 Class 1.
function facts(source='lincoln',time='2026-11-10T12:00:00-05:00',ledger={chargedCents:0,creditedCents:0},kind='entry'){
 const window={earliest:time,latest:time};
 return {movement:kind,zoneEntryTime:window,crossingTime:window,fleet:f.profile().official2026.fleet,creditSource:source,
  crossingPaidCents:source==='queens_midtown'||source==='hugh_carey'?1203:1479,creditEligibility:'eligible',creditEvidence:'synthetic-credit-entitlement',
  dailyContext:{day:r.parts(time).day,historyComplete:true,evidence:'synthetic-complete-vehicle-day',...ledger}};
}
for(const [source,cents]of Object.entries({lincoln:300,holland:300,queens_midtown:150,hugh_carey:150})){
 test(source+' uses its own eligible Phase 1 peak credit',()=>{
  const q=r.calculateCongestion(facts(source));assert.equal(q.amountCents,900);assert.equal(q.creditCents,cents);
  assert.deepEqual(q.stateAfter,{chargedCents:900,creditedCents:cents});
 });
 test(source+' later eligible entry keeps the daily charge and remaining credit separate',()=>{
  const q=r.calculateCongestion(facts(source,undefined,{chargedCents:900,creditedCents:150}));
  assert.equal(q.amountCents,0);assert.equal(q.creditCents,cents);assert.equal(q.stateAfter.creditedCents,150+cents);
 });
}
test('eligible NYC tunnel exits receive 150 cents after a daily charge; PA exits do not qualify',()=>{
 for(const source of ['queens_midtown','hugh_carey']){const q=r.calculateCongestion(facts(source,undefined,{chargedCents:900,creditedCents:300},'exit'));assert.equal(q.amountCents,0);assert.equal(q.creditCents,150);}
 for(const source of ['lincoln','holland'])assert.throws(()=>r.calculateCongestion(facts(source,undefined,{chargedCents:900,creditedCents:300},'exit')),r.TollReviewError);
});
test('later crossing credits accumulate only to the 500-cent daily limit',()=>{
 let state={chargedCents:0,creditedCents:0};
 for(const [source,expected]of [['lincoln',300],['queens_midtown',150],['hugh_carey',50],['holland',0]]){
  const q=r.calculateCongestion(facts(source,undefined,state));assert.equal(q.creditCents,expected);state=q.stateAfter;
 }
 assert.deepEqual(state,{chargedCents:900,creditedCents:500});
 assert.equal(r.calculateCongestion(facts('holland',undefined,{chargedCents:900,creditedCents:300})).creditCents,200);
});
test('credit eligibility, actual paid crossing amount and GWB non-eligibility are explicit',()=>{
 const base=facts();assert.equal(r.calculateCongestion({...base,creditEligibility:'ineligible'}).creditCents,0);
 assert.equal(r.calculateCongestion({...base,crossingPaidCents:125}).creditCents,125);
 assert.equal(r.calculateCongestion({...base,creditSource:null}).creditCents,0);
 for(const patch of [{creditSource:'gwb'},{creditEligibility:'unknown'},{creditEvidence:''},{crossingPaidCents:-1},{crossingPaidCents:1.5},{crossingPaidCents:NaN},
  {fleet:{...base.fleet,paClass:'2Ax'}},{fleet:{...base.fleet,tagStatus:'unknown'}},{fleet:{...base.fleet,mtaPlan:'tlc_per_trip'}}])assert.throws(()=>r.calculateCongestion({...base,...patch}),r.TollReviewError);
});
test('unknown, incomplete, impossible or assumed daily history requires review even after a claimed charge',()=>{
 const base=facts();
 for(const history of [null,{}, {day:base.dailyContext.day,status:'already_charged',evidence:'synthetic-history'},
  {...base.dailyContext,historyComplete:false},{...base.dailyContext,creditedCents:undefined},{...base.dailyContext,status:'first_entry_estimate',operatorPolicyApproved:true},
  {...base.dailyContext,day:'2026-11-11'},{...base.dailyContext,chargedCents:0,creditedCents:1},{...base.dailyContext,chargedCents:900,creditedCents:501},
  {...base.dailyContext,chargedCents:225,creditedCents:300},{...base.dailyContext,chargedCents:'900'},{...base.dailyContext,chargedCents:900,creditedCents:1.5}])
  assert.throws(()=>r.calculateCongestion({...base,dailyContext:history}),r.TollReviewError);
});
test('overnight entries charge once with no credit; later overnight entries never add another daily toll',()=>{
 for(const source of Object.keys(r.CREDIT_CENTS)){
  const first=r.calculateCongestion(facts(source,'2026-11-10T22:30:00-05:00'));assert.equal(first.amountCents,225);assert.equal(first.creditCents,0);
  const later=r.calculateCongestion(facts(source,'2026-11-10T23:30:00-05:00',first.stateAfter));assert.equal(later.amountCents,0);assert.equal(later.creditCents,0);
 }
});
test('overnight-first then eligible peak credit remains manual until its settlement rule is established',()=>{
 assert.throws(()=>r.calculateCongestion(facts('holland',undefined,{chargedCents:225,creditedCents:0})),e=>e.reason==='overnight_daily_credit_unverified');
 assert.equal(r.calculateCongestion(facts(null,undefined,{chargedCents:225,creditedCents:0})).amountCents,0);
});
test('rate/day boundaries and crossing-versus-zone period disagreement require review',()=>{
 const base=facts('queens_midtown');
 for(const crossingTime of [{earliest:'2026-11-10T20:59:59-05:00',latest:'2026-11-10T21:00:00-05:00'},
  {earliest:'2026-11-10T22:00:00-05:00',latest:'2026-11-10T22:00:00-05:00'},
  {earliest:'2026-11-11T12:00:00-05:00',latest:'2026-11-11T12:00:00-05:00'}])assert.throws(()=>r.calculateCongestion({...base,crossingTime}),r.TollReviewError);
});
test('a new New York day requires its own complete history and resets the credit allowance',()=>{
 const next=facts('lincoln','2026-11-11T08:00:00-05:00');assert.equal(r.calculateCongestion(next).creditCents,300);
 next.dailyContext.day='2026-11-10';assert.throws(()=>r.calculateCongestion(next),r.TollReviewError);
 assert.notEqual(r.CREDIT_VERSION,r.VERSION);
});
