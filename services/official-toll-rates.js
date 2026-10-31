'use strict';

// Arithmetic only. The routing adapter must establish these facts on the server.
// Published schedules checked 2026-10-31; no inference from OL plates or 2Ax.
const VERSION = 'pa-class1-mta-standard-2026-v1';
const START = Date.parse('2026-01-04T05:01:00Z'); // PA effective 00:01 New York.
const END = Date.parse('2027-01-01T05:00:00Z'); // Refuse an unreviewed future year.
const formatter = new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York',
  year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const crossings = new Set(['lincoln','holland','gwb']);
const reference = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._:/#-]{7,159}$/.test(value);
class TollReviewError extends Error {
  constructor(reason) { super('Toll estimate unavailable — contact us for a final quote'); this.reason=reason; }
}
const review = reason => { throw new TollReviewError(reason); };
function instant(value) {
  if(typeof value==='number'){if(!Number.isFinite(value))review('unverified_time');return value;}
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value))review('unverified_time');
  const [year,month,day]=value.slice(0,10).split('-').map(Number),calendar=new Date(Date.UTC(year,month-1,day));
  if(calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day||/[+-]14:(?!00)/.test(value))review('unverified_time');
  const time=Date.parse(value);if(!Number.isFinite(time))review('unverified_time');return time;
}
function parts(timestamp) {
  const time=instant(timestamp);
  if(!Number.isFinite(time)||time<START||time>=END)review('unsupported_tariff_date');
  const p=Object.fromEntries(formatter.formatToParts(new Date(time)).map(x=>[x.type,x.value]));
  return {day:`${p.year}-${p.month}-${p.day}`,weekend:['Sat','Sun'].includes(p.weekday),minute:Number(p.hour)*60+Number(p.minute)};
}
function rateAt(timestamp,kind) {
  if(!['pa','mta'].includes(kind))review('unsupported_tariff');
  const p=parts(timestamp),m=p.minute;
  const peak=kind==='pa'?(p.weekend?m>=660&&m<1260:m>=360&&m<600||m>=960&&m<1200):m>=(p.weekend?540:300)&&m<1260;
  return {day:p.day,peak,cents:kind==='pa'?(peak?1679:1479):(peak?900:225)};
}
function rateWindow(window,kind) {
  if(!window||typeof window.earliest!=='string'||typeof window.latest!=='string')review('unverified_crossing_time');
  const start=instant(window.earliest),end=instant(window.latest);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||end-start>8*3600000)review('unverified_crossing_time');
  const first=rateAt(start,kind),last=rateAt(end,kind);
  const same=r=>r.day===first.day&&r.cents===first.cents;
  if(!same(last))review('tariff_boundary_uncertain');
  // Check all minute boundaries, including a rate change crossed and changed back.
  for(let time=Math.floor(start/60000)*60000+60000;time<end;time+=60000)if(!same(rateAt(time,kind)))review('tariff_boundary_uncertain');
  return first;
}
function verifiedFleet(fleet,at) {
  if(!fleet||fleet.paClass!=='1'||fleet.axles!==2||fleet.singleRearWheels!==true||fleet.noTrailer!==true||
    fleet.accountIssuer!=='NJ'||fleet.tagStatus!=='mounted_readable'||fleet.mtaPlan!=='standard_daily'||fleet.tlcLicensed!==false||
    !reference(fleet.classEvidence)||!reference(fleet.tagEvidence)||!reference(fleet.planEvidence)||
    instant(fleet.validUntil)<=at)review('fleet_or_account_unverified');
}
function calculateTariff(facts) {
  if(!facts||facts.version!==VERSION||facts.routeVerified!==true||facts.coverageVerified!==true||!reference(facts.coverageEvidence)||
    !crossings.has(facts.crossing)||!['ny_bound','nj_bound'].includes(facts.direction))review('route_or_coverage_unverified');
  const pa=rateWindow(facts.crossingTime,'pa');
  verifiedFleet(facts.fleet,instant(facts.crossingTime.latest));
  if(typeof facts.entersCrz!=='boolean')review('crz_unverified');
  let congestion=0,credit=0,day=null,dailyAssumption=null;
  if(facts.entersCrz){
    const mta=rateWindow(facts.zoneEntryTime,'mta');day=mta.day;
    verifiedFleet(facts.fleet,instant(facts.zoneEntryTime.latest));
    const daily=facts.dailyContext;
    if(!daily||daily.day!==day||!['first_entry','already_charged','first_entry_estimate'].includes(daily.status)||!reference(daily.evidence))review('daily_context_unknown');
    if(daily.status==='first_entry_estimate'){
      if(daily.operatorPolicyApproved!==true)review('daily_context_unknown');
      dailyAssumption='First chargeable entry assumed under an operator-approved estimate policy; not an exact E-ZPass settlement.';
    }
    if(daily.status!=='already_charged'){
      congestion=mta.cents;
      if(mta.peak&&['lincoln','holland'].includes(facts.crossing)&&facts.direction==='ny_bound'){
        if(!['eligible','ineligible'].includes(facts.creditEligibility)||!reference(facts.creditEvidence))review('crossing_credit_unverified');
        if(facts.creditEligibility==='eligible')credit=Math.min(300,congestion,pa.cents);
      }
    }
  }
  if(!Array.isArray(facts.otherTolls)||facts.otherTolls.length>20)review('other_tolls_unverified');
  const components=[{kind:'port_authority',label:'Port Authority crossing',facility:facts.crossing,
    amountCents:facts.direction==='ny_bound'?pa.cents:0},
    {kind:'mta_congestion',label:'MTA congestion',facility:'manhattan_crz',amountCents:congestion},
    {kind:'crossing_credit',label:'Eligible credit',facility:'manhattan_crz_credit',amountCents:credit?-credit:0}];
  const ids=new Set([facts.crossing,'manhattan_crz','manhattan_crz_credit']);
  for(const toll of facts.otherTolls){
    if(!toll||typeof toll.id!=='string'||!/^[a-z0-9_-]{3,60}$/.test(toll.id)||ids.has(toll.id)||/google|aggregate|total|lincoln|holland|gwb|crz|congestion/i.test(toll.id)||
      typeof toll.label!=='string'||!toll.label.trim()||toll.label.length>80||/[\x00-\x1f<>]/.test(toll.label)||
      !Number.isSafeInteger(toll.amountCents)||toll.amountCents<0||toll.amountCents>100000||
      !reference(toll.evidence)||!reference(toll.tariffVersion))review('other_tolls_unverified');
    ids.add(toll.id);components.push({kind:'other',label:toll.label,facility:toll.id,amountCents:toll.amountCents});
  }
  const amountCents=components.reduce((n,c)=>n+c.amountCents,0);
  if(!Number.isSafeInteger(amountCents)||amountCents<0)review('invalid_total');
  return {version:VERSION,amountCents,components,congestionDay:day,dailyAssumption};
}
module.exports={VERSION,START,END,TollReviewError,review,reference,instant,parts,rateAt,rateWindow,verifiedFleet,calculateTariff};
