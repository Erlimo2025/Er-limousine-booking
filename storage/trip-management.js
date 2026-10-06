const crypto=require('node:crypto');
const {managementDto,applyTripManagement}=require('../services/trip-management');
const {enqueueBookingEmail}=require('./booking-emails');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const error=(status=409)=>Object.assign(new Error(status===401?'Authentication required.':status===404?'Customer trip unavailable.':'Trip update unavailable. Please refresh and try again.'),{status});
const at=value=>value===null || value===undefined?NaN:new Date(value).getTime();
const iso=value=>Number.isFinite(at(value))?new Date(value).toISOString():null;
function samePayload(event,input){
 const d=event.details;
 return event.kind===input.kind && d?.expectedPickupAt===input.expectedPickupAt &&
  (input.kind==='customer_cancelled' || d?.newDate===input.date && d?.newTime===input.time &&
   iso(event.new_start_at)===iso(input.startAt) && iso(event.new_end_at)===iso(input.endAt));
}
function tripManagementStorage(pool,transaction,validateRecord,assertActionLock,queryClient=()=>pool){
 const read=async fn=>{try{return await fn();}catch(e){if(e.status)throw e;throw Object.assign(new Error('Reservation service temporarily unavailable. Please try again.'),{status:503,storageFailure:true});}};
 const response=(row,record,now,extra={})=>({record,startAt:iso(row.scheduled_start_at),endAt:iso(row.scheduled_end_at),management:managementDto(record,row.scheduled_start_at,row.scheduled_end_at,now),...extra});
 return {
  customerTripManagement:(customerId,id,now)=>read(async()=>{
   if(typeof id!=='string' || !uuid.test(id))return null;
   const row=(await queryClient().query('SELECT record,scheduled_start_at,scheduled_end_at FROM er_reservations WHERE customer_id=$1 AND id=$2',[customerId,id])).rows[0];
   return row?response(row,validateRecord(row.record),now):null;
  }),
  customerTripManagementResponse:(auth,id,now)=>read(async()=>{
   const row=(await queryClient().query("SELECT r.record,r.scheduled_start_at,r.scheduled_end_at FROM er_reservations r JOIN er_customers c ON c.id=r.customer_id JOIN er_customer_sessions s ON s.customer_id=c.id WHERE r.customer_id=$1 AND r.id=$2 AND c.account_status='active' AND s.token_hash=$3 AND s.expires_at>$4",[auth.id,id,auth.sessionHash,new Date(now)])).rows[0];
   return row?response(row,validateRecord(row.record),now):null;
  }),
  tripEvent:(id,bookingId)=>read(async()=>{
   if(typeof id!=='string' || !uuid.test(id) || typeof bookingId!=='string' || !uuid.test(bookingId))return null;
   return (await queryClient().query('SELECT * FROM er_customer_trip_events WHERE id=$1 AND booking_id=$2',[id,bookingId])).rows[0] || null;
  }),
  manageCustomerTrip:(auth,id,input,now,proof=null)=>transaction(async client=>{
   if(!auth || typeof auth.id!=='string' || !uuid.test(auth.id) || typeof auth.sessionHash!=='string')throw error(401);
   if(typeof id!=='string' || !uuid.test(id))throw error(404);
   if(!input || !['pickup_time_changed','customer_cancelled'].includes(input.kind) || !uuid.test(input.requestId) || input.confirmed!==true || !Number.isFinite(at(now)))throw error(400);
   const customer=(await client.query("SELECT id FROM er_customers WHERE id=$1 AND account_status='active' FOR UPDATE",[auth.id])).rows[0];
   if(!customer || !(await client.query('SELECT 1 FROM er_customer_sessions WHERE customer_id=$1 AND token_hash=$2 AND expires_at>$3 FOR SHARE',[auth.id,auth.sessionHash,new Date(now)])).rows.length)throw error(401);
   // Match reservation creation's customer -> FIRST15 -> reservation lock order.
   await client.query('SELECT pg_advisory_xact_lock($1)',[730903]);
   const row=(await client.query('SELECT record,scheduled_start_at,scheduled_end_at FROM er_reservations WHERE customer_id=$1 AND id=$2 FOR UPDATE',[auth.id,id])).rows[0];
   if(!row)throw error(404);
   const record=validateRecord(row.record);
   await assertActionLock(record.checkoutFingerprint || 'reservation:'+record.id);
   const previous=(await client.query('SELECT * FROM er_customer_trip_events WHERE booking_id=$1 AND customer_id=$2 AND request_id=$3',[id,auth.id,input.requestId])).rows[0];
   if(previous){if(!samePayload(previous,input))throw error();return response(row,record,now,{changed:false,event:previous});}
   if(input.kind==='customer_cancelled' && record.status==='cancelled')return response(row,record,now,{changed:false,event:null});
   const mutation=applyTripManagement(record,row.scheduled_start_at,row.scheduled_end_at,input,now,proof);
   if(!mutation.changed)return response(row,record,now,{changed:false,event:null});
   const newStart=mutation.startAt,newEnd=mutation.endAt,details=mutation.details;
   validateRecord(record);
   const event=(await client.query('INSERT INTO er_customer_trip_events(id,booking_id,customer_id,request_id,kind,old_start_at,new_start_at,old_end_at,new_end_at,details,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING *',[crypto.randomUUID(),id,auth.id,input.requestId,input.kind,row.scheduled_start_at,newStart,row.scheduled_end_at,newEnd,JSON.stringify(details),new Date(now)])).rows[0];
   if(input.kind==='customer_cancelled' && record.paymentStatus==='paid')await require('./refunds').prepareRefund(client,record,auth,event,proof?.refundSource,now);
   validateRecord(record);
   await client.query('UPDATE er_reservations SET record=$2::jsonb,scheduled_start_at=$3,scheduled_end_at=$4,version=version+1,updated_at=$5 WHERE id=$1',[id,JSON.stringify(record),newStart,newEnd,new Date(now)]);
   if(input.kind==='customer_cancelled')await client.query('DELETE FROM er_first_ride_claims WHERE booking_id=$1',[id]);
   for(const kind of input.kind==='pickup_time_changed'?['customer_pickup_time_updated','admin_pickup_time_updated']:['customer_trip_cancelled','admin_trip_cancelled'])await enqueueBookingEmail(client,record,kind,event);
   return response({...row,scheduled_start_at:newStart,scheduled_end_at:newEnd},record,now,{changed:true,event});
  })
 };
}
module.exports={tripManagementStorage};
