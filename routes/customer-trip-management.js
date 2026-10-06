const {tripDto}=require('../storage/customer-trips');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail=(message='Trip update unavailable. Please refresh and try again.',status=409)=>Object.assign(new Error(message),{status});
function withCompanyContact(trip,contact){if(trip?.management)trip.management.contact={phone:contact.phone,email:contact.email};return trip;}
function installCustomerTripManagement(app,{store,customerAuth,route,rateLimit,siteUrl,contact,parseServiceDateTime,cancellationProof,timeChangeProof,refundService,runEmails,now=Date.now}){
 const mutation=(req,res,next)=>{
  res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
  if(req.get('origin')!==new URL(siteUrl).origin || req.get('sec-fetch-site') && !['same-origin','none'].includes(req.get('sec-fetch-site')) || !req.is('application/json'))return res.status(403).json({error:'Invalid request.'});
  next();
 };
 for(const [path,kind] of [['pickup-time','pickup_time_changed'],['cancel','customer_cancelled']])app.post('/api/customer/trips/:id/'+path,route(customerAuth.requireCustomer),mutation,rateLimit('trip-management',30),route(async(req,res)=>{
  const body=req.body,keys=kind==='pickup_time_changed'?['date','time','expectedPickupAt','requestId','confirmed']:['expectedPickupAt','requestId','confirmed'];
  if(!body || Array.isArray(body) || Object.keys(body).length!==keys.length || Object.keys(body).some(k=>!keys.includes(k)) || body.confirmed!==true || typeof body.requestId!=='string' || !uuid.test(body.requestId) ||
   typeof body.expectedPickupAt!=='string' || !Number.isFinite(Date.parse(body.expectedPickupAt)) || new Date(body.expectedPickupAt).toISOString()!==body.expectedPickupAt)throw fail('Invalid trip update.',400);
  const limitKey=require('node:crypto').createHash('sha256').update('trip-management|'+kind+'|'+req.customer.id).digest('hex');
  if(!await store.customerLoginLimit(limitKey,now()))throw fail('Too many requests. Please try again later.',429);
  const owner=req.customer.id,auth={id:owner,sessionHash:req.customerSessionHash};
  const initial=await store.customerTripManagement(owner,req.params.id,now());if(!initial)throw fail('Customer trip unavailable.',404);
  const result=await store.withActionLock(initial.record.checkoutFingerprint || 'reservation:'+initial.record.id,async()=>{
   const current=await store.customerTripManagement(owner,req.params.id,now());if(!current)throw fail('Customer trip unavailable.',404);
   const input={...body,kind};let proof=null;
   if(kind==='pickup_time_changed'){
    if(typeof body.date!=='string' || typeof body.time!=='string')throw fail('Invalid pickup date or time.',400);
    input.startAt=parseServiceDateTime(body.date,body.time,'pickup');
    input.endAt=current.record.trip.tripType==='roundtrip'?Date.parse(current.endAt):input.startAt+(current.record.trip.tripType==='hourly'?Number(current.record.trip.hours)*3600000:0);
    // Validate the schedule first; do not expire a session for an invalid/stale edit.
    const same=input.startAt===Date.parse(current.startAt) && input.endAt===Date.parse(current.endAt) && body.date===current.record.trip.date && body.time===current.record.trip.time;
    if(!same){
     require('../services/trip-management').applyTripManagement(structuredClone(current.record),current.startAt,current.endAt,input,now(),{safe:true,sessionId:current.record.stripeSessionId || null});
     proof=await timeChangeProof(current.record);if(!proof.safe)throw fail('Payment is processing. Please contact ER Limousine.');
    }
   }else if(current.record.status!=='cancelled'){
    // Reject before provider work; final row-locked mutation checks these again.
    if(current.startAt!==body.expectedPickupAt || !current.management.canCancel)throw fail();
    proof=current.record.paymentStatus==='paid'?{safe:true,sessionId:current.record.stripeSessionId,refundSource:await refundService.capture(current.record)}:await cancellationProof(current.record);
    if(!proof.safe)throw fail('Payment is processing. Please contact ER Limousine.');
   }
   const updated=await store.manageCustomerTrip(auth,req.params.id,input,now(),proof);
   if(kind==='customer_cancelled' && updated.record.refundStatus)await refundService.submit(updated.record.id);
   const fresh=await store.customerTripManagementResponse(auth,req.params.id,now());if(!fresh)throw fail('Authentication required.',401);
   return {...updated,...fresh};
  });
  res.json({ok:true,changed:result.changed,trip:withCompanyContact(tripDto(result.record,result.management),contact)});
  void runEmails().catch(()=>{});
 }));
}
module.exports={installCustomerTripManagement,withCompanyContact};
