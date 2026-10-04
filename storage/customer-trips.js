const ewr=require('../ewr-pickups');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const iso=value=>typeof value==='string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value;
function tripQuery(query,now) {
 const invalid=()=>{throw Object.assign(new Error('Invalid request.'),{status:400});};
 const view=query.view===undefined?'upcoming':query.view;
 if(!['upcoming','past'].includes(view))invalid();
 const text=query.limit===undefined?'20':query.limit;
 if(typeof text!=='string'||! /^(?:[1-9]|[1-4][0-9]|50)$/.test(text))invalid();
 let cursor=null;
 if(query.cursor!==undefined){
  if(typeof query.cursor!=='string'||query.cursor.length>512||! /^[A-Za-z0-9_-]+$/.test(query.cursor))invalid();
  try {
   const bytes=Buffer.from(query.cursor,'base64url');
   if(bytes.toString('base64url')!==query.cursor)invalid();
   cursor=JSON.parse(bytes.toString('utf8'));
   if(!cursor||Array.isArray(cursor)||Object.keys(cursor).sort().join(',')!=='at,id,schedule,view'||cursor.view!==view||typeof cursor.id!=='string'||!uuid.test(cursor.id)||!iso(cursor.schedule)||!iso(cursor.at)||Date.parse(cursor.at)>now||Date.parse(cursor.at)<now-24*3600000)invalid();
  }catch(_){invalid();}
 }
 return {view,limit:Number(text),cursor,at:cursor?.at || new Date(now).toISOString()};
}
function tripDto(record) {
 const t=record.trip;
 const terminal=id=>typeof id==='string'&&Object.hasOwn(ewr,id)?ewr[id].label:null;
 return {reference:record.id,status:record.status,paymentStatus:record.paymentStatus,tripType:t.tripType,
  pickup:t.pickup,dropoff:t.dropoff,date:t.date,time:t.time,timeZone:'America/New_York',
  ...(t.tripType==='roundtrip'?{returnDate:t.returnDate,returnTime:t.returnTime}:{}),
  ...(t.tripType==='hourly'?{hours:Number(t.hours)}:{}),vehicle:record.quote.vehicle,passengers:t.passengers,
  pickupTerminal:terminal(t.pickupPlaceId),dropoffTerminal:terminal(t.dropoffPlaceId),
  total:record.quote.total,currency:record.quote.currency,createdAt:record.createdAt};
}
function customerTripsStorage(pool,safe,validate) {
 const rowDto=row=>tripDto(validate(row.record));
 return {
  reservationOwner:id=>safe(async()=> (await pool.query('SELECT customer_id FROM er_reservations WHERE id=$1',[id])).rows[0]?.customer_id || null),
  customerTrip:(customerId,id)=>safe(async()=>{
   if(typeof id!=='string'||!uuid.test(id))return null;
   const row=(await pool.query('SELECT record FROM er_reservations WHERE customer_id=$1 AND id=$2',[customerId,id])).rows[0];
   return row?rowDto(row):null;
  }),
  customerTrips:(customerId,q)=>safe(async()=>{
   const upcoming=q.view==='upcoming',op=upcoming?'>':'<',order=upcoming?'ASC':'DESC';
   const predicate=upcoming?"scheduled_end_at>$2 AND record->>'status' NOT IN ('completed','cancelled')":"(scheduled_end_at<=$2 OR record->>'status' IN ('completed','cancelled'))";
   const values=[customerId,q.at,q.limit+1];
   let cursor='';
   if(q.cursor){values.push(q.cursor.schedule,q.cursor.id);cursor=` AND (scheduled_end_at,id) ${op} ($4::timestamptz,$5::uuid)`;}
   const rows=(await pool.query(`SELECT record,scheduled_end_at,id FROM er_reservations WHERE customer_id=$1 AND ${predicate}${cursor} ORDER BY scheduled_end_at ${order},id ${order} LIMIT $3`,values)).rows;
   const page=rows.slice(0,q.limit),last=page.at(-1);
   return {trips:page.map(rowDto),nextCursor:rows.length>q.limit?Buffer.from(JSON.stringify({view:q.view,at:q.at,schedule:new Date(last.scheduled_end_at).toISOString(),id:last.id})).toString('base64url'):null};
  })
 };
}
module.exports={customerTripsStorage,tripQuery,tripDto};
