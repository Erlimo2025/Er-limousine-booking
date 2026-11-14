const test=require('node:test'),assert=require('node:assert/strict');
const r=require('../services/official-toll-rates'),{facts,profile}=require('./helpers/official-toll-fixtures.cjs');
const at=(time,extra={})=>{const window={earliest:time,latest:time},day=r.parts(time).day;return facts({crossingTime:window,zoneEntryTime:window,dailyContext:{day,status:'first_entry',evidence:'synthetic-day-context-record'},...extra});};
const total=(time,extra)=>r.calculateTariff(at(time,extra)).amountCents;
test('weekday peak Lincoln and Holland: $16.79 + $9 - $3',()=>{for(const crossing of ['lincoln','holland'])assert.equal(total('2026-11-10T13:00:00Z',{crossing}),2279);});
test('weekday noon: PA off-peak and MTA daytime with eligible credit',()=>assert.equal(total('2026-11-10T17:00:00Z'),2079));
test('weekday overnight has no crossing credit',()=>assert.equal(total('2026-11-11T03:31:00Z'),1704));
test('Saturday 10am is PA off-peak and MTA peak',()=>assert.equal(total('2026-11-07T15:00:00Z'),2079));
test('Saturday noon is peak for both',()=>assert.equal(total('2026-11-07T17:00:00Z'),2279));
test('Sunday 8am is off-peak PA and overnight MTA',()=>assert.equal(total('2026-11-08T13:00:00Z'),1704));
test('GWB has no Lincoln/Holland credit when entering the zone',()=>assert.equal(total('2026-11-10T13:00:00Z',{crossing:'gwb'}),2579));
test('GWB without zone entry has only the PA toll',()=>assert.equal(total('2026-11-10T13:00:00Z',{crossing:'gwb',entersCrz:false}),1679));
test('New Jersey bound has no PA toll or new CRZ toll without an entry',()=>assert.equal(total('2026-11-10T13:00:00Z',{direction:'nj_bound',entersCrz:false}),0));
test('verified daily charge context prevents duplicate congestion and credit',()=>{
 const f=at('2026-11-10T13:00:00Z');f.dailyContext.status='already_charged';const q=r.calculateTariff(f);assert.equal(q.amountCents,1679);assert.equal(q.components[2].amountCents,0);
});
test('independently verified other road costs are added once; duplicates or unknown amounts fail',()=>{
 const toll={id:'nj_turnpike',label:'NJ Turnpike',amountCents:225,evidence:'synthetic-road-cost-proof',tariffVersion:'synthetic-road-tariff-v1'};
 assert.equal(total('2026-11-10T13:00:00Z',{otherTolls:[toll]}),2504);
 for(const otherTolls of [[toll,toll],[{...toll,amountCents:NaN}],[{...toll,amountCents:2.25}],[{...toll,evidence:''}]])assert.throws(()=>r.calculateTariff(facts({otherTolls})),r.TollReviewError);
});
test('all 2026 weekday/weekend boundaries, effective dates, holidays and both DST offsets are explicit',()=>{
 const pa=[['2026-11-10T10:59:59Z',1479],['2026-11-10T11:00:00Z',1679],['2026-11-10T15:00:00Z',1479],['2026-11-10T21:00:00Z',1679],['2026-11-11T01:00:00Z',1479],
 ['2026-11-07T15:59:59Z',1479],['2026-11-07T16:00:00Z',1679],['2026-11-08T02:00:00Z',1479]];
 for(const [time,cents]of pa)assert.equal(r.rateAt(time,'pa').cents,cents,time);
 for(const [time,cents]of [['2026-11-10T09:59:59Z',225],['2026-11-10T10:00:00Z',900],['2026-11-11T02:00:00Z',225],['2026-11-07T13:59:59Z',225],['2026-11-07T14:00:00Z',900]])assert.equal(r.rateAt(time,'mta').cents,cents,time);
 assert.equal(r.rateAt('2026-11-01T05:30:00Z','mta').cents,225);assert.equal(r.rateAt('2026-11-01T06:30:00Z','mta').cents,225);
 assert.equal(r.rateAt('2026-03-08T06:59:59Z','mta').cents,225);assert.equal(r.rateAt('2026-03-08T07:00:00Z','mta').cents,225);
 assert.equal(r.rateAt('2026-11-26T13:00:00Z','pa').cents,1679); // Published weekday schedule; no invented holiday waiver.
 for(const time of ['2026-01-04T05:00:59Z','2027-01-01T05:00:00Z','invalid','2026-11-10T13:00:00','2026-02-30T13:00:00Z'])assert.throws(()=>r.rateAt(time,'pa'),r.TollReviewError);
 assert.equal(r.rateAt('2026-11-10T08:00:00-05:00','pa').cents,1679);
 assert.equal(r.rateAt('2026-01-04T05:01:00Z','pa').cents,1479);
 assert.throws(()=>r.rateWindow({earliest:'2026-11-10T14:59:59Z',latest:'2026-11-10T15:00:00Z'},'pa'),/unavailable/);
});
test('the reviewed Port Authority window ends at New York midnight without assuming the January 3 tariff',()=>{
 assert.deepEqual(r.rateAt('2026-12-31T23:59:59-05:00','pa'),{day:'2026-12-31',peak:false,cents:1479});
 for(const time of ['2027-01-01T00:00:00-05:00','2027-01-02T12:00:00-05:00','2027-01-03T12:00:00-05:00']){
  assert.throws(()=>r.rateAt(time,'pa'),error=>error.reason==='unsupported_tariff_date');
  assert.throws(()=>r.parts(time),error=>error.reason==='unsupported_tariff_date');
 }
});
test('the separately published 2027 congestion window preserves weekday, weekend and overnight pricing',()=>{
 const cases=[
  ['2026-12-31T23:59:59-05:00','2026-12-31',false,225],
  ['2027-01-01T00:00:00-05:00','2027-01-01',false,225],
  ['2027-01-01T05:00:00-05:00','2027-01-01',true,900],
  ['2027-01-03T08:59:59-05:00','2027-01-03',false,225],
  ['2027-01-03T09:00:00-05:00','2027-01-03',true,900],
  ['2027-07-06T05:00:00-04:00','2027-07-06',true,900],
  ['2027-12-31T23:59:59-05:00','2027-12-31',false,225]
 ];
 for(const [time,day,peak,cents] of cases)assert.deepEqual(r.rateAt(time,'mta'),{day,peak,cents});
 assert.throws(()=>r.rateAt('2028-01-01T00:00:00-05:00','mta'),error=>error.reason==='unsupported_tariff_date');
 const yearEnd={earliest:'2026-12-31T23:59:59-05:00',latest:'2027-01-01T00:00:00-05:00'};
 assert.throws(()=>r.rateWindow(yearEnd,'mta'),error=>error.reason==='tariff_boundary_uncertain');
});
test('a verified 2026 crossing cannot produce a legacy combined snapshot with a 2027 congestion event',()=>{
 const p=profile().official2026.fleet;
 const crossing={earliest:'2026-12-31T23:59:00-05:00',latest:'2026-12-31T23:59:59-05:00'};
 const zone={earliest:'2027-01-01T00:00:00-05:00',latest:'2027-01-01T00:01:00-05:00'};
 assert.throws(()=>r.calculateTariff(facts({crossingTime:crossing,zoneEntryTime:zone,
  fleet:{...p,validUntil:'2028-01-01T00:00:00-05:00'}})),error=>error.reason==='unsupported_tariff_date');
});
test('unverified route, physical class, tag, daily context, plan, credits and unsupported versions fail closed',()=>{
 for(const change of [{routeVerified:false},{coverageVerified:false},{version:'2027'},{crossing:'guess'},
  {fleet:{...profile().official2026.fleet,paClass:'2Ax'}},{fleet:{...profile().official2026.fleet,tagStatus:'unknown'}},
  {fleet:{...profile().official2026.fleet,mtaPlan:'tlc_per_trip'}},{fleet:{...profile().official2026.fleet,classEvidence:''}},
  {dailyContext:{day:'2026-11-10',status:'unknown',evidence:'synthetic-context'}},{creditEligibility:'unknown'}])assert.throws(()=>r.calculateTariff(facts(change)),r.TollReviewError);
 const f=facts();f.dailyContext.status='first_entry_estimate';assert.throws(()=>r.calculateTariff(f),r.TollReviewError);
 f.dailyContext.operatorPolicyApproved=true;assert.match(r.calculateTariff(f).dailyAssumption,/not an exact/);
});
