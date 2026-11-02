'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const format=require('../public/trip-date-format'),{bookingMessage}=require('../services/booking-emails');

test('US trip dates format calendar components without converting ISO wall dates',()=>{
 for(const [iso,expected]of [['2026-11-17','11/17/2026'],['2027-01-02','01/02/2027'],['2028-02-29','02/29/2028'],['2000-02-29','02/29/2000']])assert.equal(format.date(iso),expected);
 for(const value of ['2026-02-29','2100-02-29','2026-04-31','2026-13-01','0000-01-01','2026-01-00','11/17/2026',null,{},'2026-11-17T00:00:00Z'])assert.equal(format.date(value),'—');
});
test('US date entry normalizes only valid month/day/year to the original ISO wire format',()=>{
 for(const [input,expected]of [['11/17/2026','2026-11-17'],['1/2/2027','2027-01-02'],[' 02/29/2028 ','2028-02-29'],['11172026','2026-11-17']])assert.equal(format.fromDateInput(input),expected);
 for(const value of ['17/11/2026','2026-11-17','2/29/2026','2/31/2026','11/17/26','111726','',null])assert.equal(format.fromDateInput(value),null);
});
test('12-hour trip times preserve midnight, noon, minutes and the original 24-hour values',()=>{
 for(const [iso,expected]of [['00:00','12:00 AM'],['00:05','12:05 AM'],['01:09','1:09 AM'],['11:59','11:59 AM'],['12:00','12:00 PM'],['13:30','1:30 PM'],['23:59','11:59 PM']])assert.equal(format.time(iso),expected);
 for(const value of ['24:00','12:60','1:30','12:30 PM','',null])assert.equal(format.time(value),'—');
});
test('manual time entry requires an explicit AM/PM instead of guessing a day period',()=>{
 for(const [input,iso]of [['12:00 AM','00:00'],['12:00 PM','12:00'],[' 1:30 pm ','13:30'],['01:02am','01:02'],['11:59 PM','23:59']])assert.equal(format.fromTimeInput(input),iso);
 for(const value of ['13:00','12:00','00:00 AM','24:00 PM','1:60 PM','1:5 PM','',null])assert.equal(format.fromTimeInput(value),null);
});
test('trip displays use New York wall-clock components independently of the host timezone',()=>{
 const previous=process.env.TZ;
 try{for(const zone of ['Asia/Tokyo','America/Los_Angeles','UTC']){process.env.TZ=zone;assert.equal(format.trip('2026-11-17','13:30'),'11/17/2026 · 1:30 PM (New York time)');assert.equal(format.trip('2026-03-08','00:15'),'03/08/2026 · 12:15 AM (New York time)');}}
 finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
 assert.equal(format.zone,'America/New_York');
});
test('absolute confirmation/account timestamps display in New York including DST and date rollover',()=>{
 for(const [instant,expected]of [
  ['2026-11-18T00:05:00Z','11/17/2026 · 7:05 PM (New York time)'],
  ['2026-07-01T04:00:00Z','07/01/2026 · 12:00 AM (New York time)'],
  ['2026-03-08T06:59:00Z','03/08/2026 · 1:59 AM (New York time)'],
  ['2026-03-08T07:00:00Z','03/08/2026 · 3:00 AM (New York time)'],
  ['2026-11-01T05:59:00Z','11/01/2026 · 1:59 AM (New York time)'],
  ['2026-11-01T06:00:00Z','11/01/2026 · 1:00 AM (New York time)']])assert.equal(format.instant(instant),expected);
 assert.equal(format.instant('2026-11-18T00:05:00Z',false),'11/17/2026');
 for(const value of ['',null,undefined,'invalid'])assert.equal(format.instant(value),'—');
});
test('browser and server use the same pure formatting implementation',()=>{
 const context=vm.createContext({});vm.runInContext(fs.readFileSync(require.resolve('../public/trip-date-format'),'utf8'),context);
 for(const name of ['date','time','trip','fromDateInput','fromTimeInput','instant'])assert.equal(typeof context.TripDateFormat[name],'function');
 assert.equal(context.TripDateFormat.trip('2026-11-17','00:00'),format.trip('2026-11-17','00:00'));assert.ok(Object.isFrozen(format));
});
function record(){return {id:'11111111-1111-4111-8111-111111111111',status:'awaiting_payment',paymentStatus:'unpaid',customer:{firstName:'Test',lastName:'Customer',email:'test@example.test',phone:'2025550199'},trip:{pickup:'Orange, NJ',dropoff:'Manhattan',date:'2026-11-17',time:'13:30',returnDate:'2026-11-18',returnTime:'00:15',vehicle:'suv',passengers:2},quote:{vehicle:'Luxury SUV',total:150,currency:'usd'},deferredPayment:true};}
const contact={email:'bookings@example.test',phone:'2025550199'};
test('customer reservation and payment emails show US dates and AM/PM while retaining immutable ISO snapshots',()=>{
 for(const kind of ['customer_reservation_created','payment_confirmed']){
  const r=record();if(kind==='payment_confirmed')r.paymentStatus='paid';const before=JSON.stringify(r),m=bookingMessage(r,kind,contact);
  for(const text of ['11/17/2026 · 1:30 PM (New York time)','11/18/2026 · 12:15 AM (New York time)']){assert.ok(m.text.includes(text));assert.ok(m.html.includes(text));}
  assert.doesNotMatch(m.text,/2026-11-17|2026-11-18|13:30|00:15/);assert.equal(JSON.stringify(r),before);
 }
 const admin=bookingMessage(record(),'reservation_created',contact);assert.match(admin.text,/2026-11-17 13:30 \(America\/New_York\)/);
});
function event(kind){return {id:'22222222-2222-4222-8222-222222222222',booking_id:record().id,kind,old_start_at:'2026-11-17T18:30:00Z',new_start_at:'2026-11-19T05:15:00Z',details:{oldDate:'2026-11-17',oldTime:'13:30',newDate:'2026-11-19',newTime:'00:15'}};}
test('reschedule emails format both audit-event schedule snapshots, never a later reservation edit',()=>{
 const r=record(),e=event('pickup_time_changed'),before=JSON.stringify([r,e]);r.trip.date='2026-11-25';const unchanged=JSON.stringify(r),m=bookingMessage(r,'customer_pickup_time_updated',contact,null,e);
 assert.match(m.text,/Old pickup date\/time: 11\/17\/2026 · 1:30 PM/);assert.match(m.text,/New pickup date\/time: 11\/19\/2026 · 12:15 AM/);assert.doesNotMatch(m.text,/11\/25\/2026/);assert.equal(JSON.stringify(r),unchanged);assert.equal(JSON.stringify(e),JSON.stringify(JSON.parse(before)[1]));
});
test('customer cancellation and refund emails use the same display format without changing their payment states',()=>{
 for(const kind of ['customer_trip_cancelled','customer_refund_confirmed','customer_refund_review']){
  const r=record();r.status='cancelled';r.paymentStatus='paid';r.refundStatus=kind==='customer_refund_confirmed'?'confirmed':'review_required';const e=event('customer_cancelled'),before=JSON.stringify([r,e]),m=bookingMessage(r,kind,contact,null,e);
  assert.match(m.text,/Pickup date\/time: 11\/17\/2026 · 1:30 PM/);assert.equal(JSON.stringify([r,e]),before);
 }
});
