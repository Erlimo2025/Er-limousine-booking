// Test-only adapter; runtime mutations always use PostgreSQL transactions.
const crypto=require('node:crypto');
const {validateRecord}=require('../../storage/postgres');
const {managementDto,applyTripManagement}=require('../../services/trip-management');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const clone=value=>value?structuredClone(value):null;
const iso=value=>value===null || value===undefined?null:Number.isFinite(new Date(value).getTime())?new Date(value).toISOString():null;
const error=(status=409)=>Object.assign(new Error(status===401?'Authentication required.':status===404?'Customer trip unavailable.':'Trip update unavailable. Please refresh and try again.'),{status});
function tripManagementMemory(shared,fail,atomic,actionScope,emails){
 shared.tripEvents ||=new Map();
 const result=(record,row,now,extra={})=>({record:clone(record),startAt:iso(row.start),endAt:iso(row.end),management:managementDto(record,row.start,row.end,now),...extra});
 return {
  customerTripManagement:async(customerId,id,now)=>{
   fail('read');const row=shared.tripRows.get(id),record=shared.records.find(r=>r.id===id);
   return row?.customer_id===customerId && record?result(validateRecord(clone(record)),row,now):null;
  },
  customerTripManagementResponse:async(auth,id,now)=>{
   fail('read');const row=shared.tripRows.get(id),record=shared.records.find(r=>r.id===id),customer=shared.customers.get(auth.id),session=shared.customerSessions.get(auth.sessionHash);
   return record && row?.customer_id===auth.id && customer?.account_status==='active' && session?.customer_id===auth.id && session.expires>now?result(validateRecord(clone(record)),row,now):null;
  },
  tripEvent:async(id,bookingId)=>{fail('read');const event=shared.tripEvents.get(id);return event?.booking_id===bookingId?clone(event):null;},
  manageCustomerTrip:async(auth,id,input,now,proof=null)=>atomic(async()=>{
   fail('read');
   if(!auth || typeof auth.id!=='string' || !uuid.test(auth.id) || typeof auth.sessionHash!=='string')throw error(401);
   if(typeof id!=='string' || !uuid.test(id))throw error(404);
   if(!input || !['pickup_time_changed','customer_cancelled'].includes(input.kind) || !uuid.test(input.requestId) || input.confirmed!==true || !Number.isFinite(new Date(now).getTime()))throw error(400);
   const customer=shared.customers.get(auth.id),session=shared.customerSessions.get(auth.sessionHash);
   if(customer?.account_status!=='active' || session?.customer_id!==auth.id || !(session.expires>now))throw error(401);
   const row=shared.tripRows.get(id),stored=shared.records.find(r=>r.id===id);
   if(row?.customer_id!==auth.id || !stored)throw error(404);
   const record=validateRecord(clone(stored));
   if(actionScope.getStore()!==(record.checkoutFingerprint || 'reservation:'+record.id))throw error();
   const previous=[...shared.tripEvents.values()].find(e=>e.booking_id===id && e.customer_id===auth.id && e.request_id===input.requestId);
   if(previous){
    const d=previous.details;
    if(previous.kind!==input.kind || d.expectedPickupAt!==input.expectedPickupAt || input.kind==='pickup_time_changed' &&
     (d.newDate!==input.date || d.newTime!==input.time || iso(previous.new_start_at)!==iso(input.startAt) || iso(previous.new_end_at)!==iso(input.endAt)))throw error();
    return result(record,row,now,{changed:false,event:clone(previous)});
   }
   if(input.kind==='customer_cancelled' && record.status==='cancelled')return result(record,row,now,{changed:false,event:null});
   const mutation=applyTripManagement(record,row.start,row.end,input,now,proof);
   if(!mutation.changed)return result(record,row,now,{changed:false,event:null});
   validateRecord(record);
   const event={id:crypto.randomUUID(),booking_id:id,customer_id:auth.id,request_id:input.requestId,kind:input.kind,
    old_start_at:iso(row.start),new_start_at:mutation.startAt,old_end_at:iso(row.end),new_end_at:mutation.endAt,
    details:clone(mutation.details),created_at:new Date(now).toISOString()};
   fail('write');fail('tripEvent');fail('emailEnqueue');
   if(input.kind==='customer_cancelled' && record.paymentStatus==='paid'){fail('refundWrite');require('./refund-memory.cjs').prepareMemoryRefund(shared,record,auth,event,proof?.refundSource,now);}
   // All guards run before committing the record, schedule, audit and outbox together.
   shared.records=shared.records.map(r=>r.id===id?clone(record):r);
   const updated={...row,start:mutation.startAt,end:mutation.endAt};shared.tripRows.set(id,updated);
   shared.tripEvents.set(event.id,clone(event));
   if(input.kind==='customer_cancelled')for(const [key,value]of shared.claims)if(value===id)shared.claims.delete(key);
   for(const kind of input.kind==='pickup_time_changed'?['customer_pickup_time_updated','admin_pickup_time_updated']:['customer_trip_cancelled','admin_trip_cancelled'])emails.enqueue(record,kind,event);
   return result(record,updated,now,{changed:true,event:clone(event)});
  })
 };
}
module.exports={tripManagementMemory};
