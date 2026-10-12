// Test-only relational archive state; never changes reservation JSON or payment helpers.
const {archiveInput,canArchive,archiveError}=require('../../storage/admin-archives');
const {page,adminDto}=require('../../storage/admin-reservations');
function adminArchiveMemory(shared,fail,atomic,actionScope){
 shared.adminArchives ||= new Map();shared.archiveEvents ||= new Map();
 function ny(date,time){
  const wall=Date.parse(date+'T'+time+':00Z');let at=wall;
  for(let i=0;i<3;i++){const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)),part=k=>parts.find(p=>p.type===k).value;const actual=part('year')+'-'+part('month')+'-'+part('day')+'T'+part('hour')+':'+part('minute')+':00Z';const difference=wall-Date.parse(actual);if(!difference)break;at+=difference;}
  return at;
 }
 const schedule=r=>{const row=shared.tripRows.get(r.id),start=row?.start || new Date(ny(r.trip.date,r.trip.time)).toISOString();return {start,finish:row?.end || new Date(r.trip.tripType==='roundtrip'?ny(r.trip.returnDate,r.trip.returnTime):Date.parse(start)+(r.trip.tripType==='hourly'?Number(r.trip.hours)*3600000:0)).toISOString()};};
 return {
  adminArchiveState:async id=>{fail('read');return shared.records.some(r=>r.id===id)?{archived_at:null,archived_by:null,...shared.adminArchives.get(id)}:null;},
  manageAdminArchive:(auth,id,input,action,now)=>atomic(async()=>{
   archiveInput(id,input);fail('read');const r=shared.records.find(r=>r.id===id);if(!r)throw archiveError(404,'Booking not found.');
   if(actionScope.getStore()!==(r.checkoutFingerprint || 'reservation:'+id))throw archiveError();
   if(!auth.authorized())throw archiveError(401,'Authentication required.');
   const key=id+':'+input.requestId,prior=shared.archiveEvents.get(key),old=shared.adminArchives.get(id);
   if(prior){if(prior.action!==action)throw archiveError();return {changed:false,archived:!!old};}
   if(action==='archive'&&!old&&!canArchive(r,schedule(r).finish,now))throw archiveError(409,'Cancel or complete an active trip before archiving it.');
   const changed=action==='archive'?!old:!!old;fail('write');
   if(changed){if(action==='archive')shared.adminArchives.set(id,{archived_at:new Date(now).toISOString(),archived_by:auth.actorId});else shared.adminArchives.delete(id);}
   shared.archiveEvents.set(key,{booking_id:id,request_id:input.requestId,action,actor_id:auth.actorId,occurred_at:new Date(now).toISOString(),changed});
   return {changed,archived:action==='archive'};
  }),
  searchAdminReservations:async q=>{
   fail('read');const rows=shared.records.map(record=>({record,id:record.id,...schedule(record),archived_at:null,archived_by:null,...shared.adminArchives.get(record.id)})).filter(row=>{
    const r=row.record;if((q.view==='archived')!==!!row.archived_at)return false;
    if(q.status==='active'&&['cancelled','completed'].includes(r.status)||!['all','active'].includes(q.status)&&r.status!==q.status)return false;
    if(q.timing==='upcoming'&&row.finish<=q.at||q.timing==='past'&&row.finish>q.at||['today','tomorrow'].includes(q.timing)&&r.trip.date!==q[q.timing])return false;
    if(q.vehicle!=='all'&&r.trip.vehicle!==q.vehicle)return false;
    if(q.payment==='paid'&&r.paymentStatus!=='paid'||q.payment==='unpaid'&&r.paymentStatus==='paid')return false;
    const dto=adminDto(r),airports=[dto.trip.pickupAirport?.code,dto.trip.dropoffAirport?.code];if(q.airport!=='all'&&(q.airport==='other'?airports.some(Boolean):!airports.includes(q.airport.toUpperCase())))return false;
    const text=[r.id,r.customer.firstName,r.customer.lastName,r.customer.email,r.customer.phone,r.trip.pickup,r.trip.dropoff,r.trip.flightNumber].join(' ').toLowerCase();
    if(!q.terms.every(term=>text.includes(term)||/^\d+$/.test(term)&&r.customer.phone.replace(/\D/g,'').includes(term)))return false;
    return !q.cursor || row.start>q.cursor.start || row.start===q.cursor.start&&row.id>q.cursor.id;
   }).sort((a,b)=>a.start.localeCompare(b.start)||a.id.localeCompare(b.id));return page(rows,q);
  }
 };
}
module.exports={adminArchiveMemory};
