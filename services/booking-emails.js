const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Remove only adjacent repeated terminal labels in the rendered customer address.
// The stored address and distinct terminal information remain untouched.
const customerPickup=value=>value.replace(/(^|,\s*)(Terminal\s+([ABC]))\s*,\s*(?:Terminal\s+\3\s*,\s*)+/gi,'$1$2, ');
function customerSupportHtml(contact){
 const email=typeof contact.email==='string' && contact.email.length<=200 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(contact.email)?'<a href="mailto:'+escape(encodeURIComponent(contact.email))+'">'+escape(contact.email)+'</a>':escape(contact.email);
 const phone=contact.phone,digits=typeof phone==='string'?phone.replace(/\D/g,''):'';
 const safePhone=typeof phone==='string' && /^\+?[0-9 ().-]{7,40}$/.test(phone) && /^[0-9]{7,15}$/.test(digits);
 const dial=safePhone?(digits.length===10?'+1'+digits:phone.startsWith('+') || digits.length===11 && digits.startsWith('1')?'+'+digits:digits):null;
 return 'Contact ER Limousine Service: '+email+(phone?' | '+(dial?'<a href="tel:'+dial+'" style="color:#008000;text-decoration:underline;">'+escape(phone)+'</a>':escape(phone)):'');
}
const tripActionKinds=['customer_pickup_time_updated','admin_pickup_time_updated','customer_trip_cancelled','admin_trip_cancelled','customer_refund_confirmed','admin_refund_confirmed','customer_refund_review','admin_refund_review'];
function tripActionMessage(record,kind,contact,event){
 const changed=kind.endsWith('pickup_time_updated'),refundConfirmed=kind.endsWith('refund_confirmed'),refundReview=kind.endsWith('refund_review'),admin=kind.startsWith('admin_'),d=event?.details;
 const validDate=value=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
 const validTime=value=>typeof value==='string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
 // Only a stored, reservation-bound audit event can describe a customer action.
 // Use its immutable schedule snapshot, even if another edit occurred before delivery.
 if(!event || event.booking_id!==record.id || event.kind!==(changed?'pickup_time_changed':'customer_cancelled') ||
  typeof event.id!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(event.id) ||
  event.old_start_at==null || !Number.isFinite(new Date(event.old_start_at).getTime()) || !d || Array.isArray(d) || !validDate(d.oldDate) || !validTime(d.oldTime) ||
  changed && (event.new_start_at==null || !Number.isFinite(new Date(event.new_start_at).getTime()) || !validDate(d.newDate) || !validTime(d.newTime)))throw Error('Email unavailable.');
 if(refundConfirmed && (record.status!=='cancelled' || record.paymentStatus!=='paid' || record.refundStatus!=='confirmed'))throw Error('Email unavailable.');
 if(refundReview && (record.status!=='cancelled' || record.paymentStatus!=='paid' || !['review_required','failed'].includes(record.refundStatus)))throw Error('Email unavailable.');
 const t=record.trip,c=record.customer,timezone=admin?'America/New_York':'New York time';
 const rows=[['Reservation ID',record.id],['Pickup',admin?t.pickup:customerPickup(t.pickup)],['Destination',t.dropoff]];
 if(admin)rows.splice(1,0,['Customer name',c.firstName+' '+c.lastName],['Customer email',c.email],['Customer phone',c.phone]);
 const oldTime=d.oldDate+' '+d.oldTime+' ('+timezone+')';
 if(changed)rows.push(['Old pickup date/time',oldTime],['New pickup date/time',d.newDate+' '+d.newTime+' ('+timezone+')']);
 else {
  rows.push(['Pickup date/time',oldTime],['Reservation status','Cancelled'],['Payment status',record.paymentStatus==='paid'?'Paid':'Unpaid']);
  if(record.paymentStatus==='paid' && ['processing','review_required','confirmed','failed'].includes(record.refundStatus))rows.push(['Refund status',{processing:'Processing — not yet confirmed',confirmed:'Full refund confirmed',review_required:'Operator review required — not confirmed',failed:'Operator review required — not confirmed'}[record.refundStatus]]);
 }
 rows.push(['Vehicle',t.vehicle==='suv'?'Luxury SUV':record.quote.vehicle]);
 const paid=record.paymentStatus==='paid';
 const intro=changed?(admin?'A customer updated the pickup date/time for this reservation.':'Your pickup date/time has been updated.'):
  refundConfirmed || paid && record.refundStatus==='confirmed'?'This trip remains cancelled. The full refund has been confirmed. Your bank may take additional time to display it.':
  paid && record.refundStatus==='processing'?'Your trip has been cancelled and your full refund is processing. No refund has been confirmed yet. You do not need to pay again.':
  paid && ['review_required','failed'].includes(record.refundStatus)?'Your trip has been cancelled. The refund requires operator review. Please contact ER Limousine Service. No refund has been confirmed.':
  paid?'This trip was cancelled. Payment was received for this cancelled reservation. Please contact ER Limousine Service for payment review. No refund has been confirmed.':
  admin?'A customer cancelled this unpaid reservation.':'Your trip has been cancelled. No payment is required for this cancelled reservation.';
 const title=changed?'Pickup Time Updated':refundConfirmed?'Refund Confirmed':refundReview?'Refund Review Required':'Trip Cancelled',support='Contact ER Limousine Service: '+contact.email+(contact.phone?' | '+contact.phone:'');
 return {to:admin?contact.email:c.email,subject:title+(admin?' — '+record.id:' | ER Limousine Service'),
  text:'ER Limousine Service\n\n'+intro+'\n\n'+rows.map(([k,v])=>k+': '+v).join('\n')+'\n\n'+support,
  html:'<h1>ER Limousine Service</h1><p>'+escape(intro)+'</p><table>'+rows.map(([k,v])=>'<tr><th align="left">'+escape(k)+'</th><td>'+escape(v)+'</td></tr>').join('')+'</table><p>'+(admin?escape(support):customerSupportHtml(contact))+'</p>'};
}
function bookingMessage(record,kind,contact,myTripsUrl=null,event=null){
 if(tripActionKinds.includes(kind))return tripActionMessage(record,kind,contact,event);
 const reservation=['reservation_created','customer_reservation_created'].includes(kind),admin=['reservation_created','admin_payment_confirmed'].includes(kind);
 if(!['reservation_created','customer_reservation_created','payment_confirmed','admin_payment_confirmed'].includes(kind))throw Error('Email unavailable.');
 const t=record.trip,q=record.quote,customer=record.customer;
 if(!reservation && record.paymentStatus!=='paid')throw Error('Email unavailable.');
 const vehicle=t.vehicle==='suv'?'Luxury SUV':q.vehicle;
 const amount=new Intl.NumberFormat('en-US',{style:'currency',currency:q.currency}).format(q.total);
 const timezone=admin?'America/New_York':'New York time';
 const rows=[['Reservation ID',record.id],['Pickup',admin?t.pickup:customerPickup(t.pickup)],['Destination',t.dropoff],['Pickup date/time',t.date+' '+t.time+' ('+timezone+')'],['Vehicle',vehicle]];
 if(t.returnDate)rows.push(['Return pickup',t.returnDate+' '+t.returnTime+' ('+timezone+')']);
 if(reservation || admin){
  if(admin)rows.splice(1,0,['Customer name',customer.firstName+' '+customer.lastName],['Customer email',customer.email],['Customer phone',customer.phone]);
  if(admin)rows.push(['Passenger count',t.passengers]);
  if(admin && t.flightNumber)rows.push(['Flight information',t.flightNumber]);
  if(admin && t.notes)rows.push(['Notes',t.notes]);
  rows.push([reservation?(admin?'Authoritative total':'Total'):'Amount paid',amount],['Payment status',record.paymentStatus==='paid'?'Paid':'Unpaid']);
  if(reservation && (record.deferredPayment===true || record.checkoutFingerprint))rows.push(['Payment choice',record.deferredPayment===true?'Pay Later':'Pay Now']);
 }else rows.push(['Amount paid',amount],['Payment status','Payment confirmed']);
 const cancelled=record.status==='cancelled',paid=record.paymentStatus==='paid';
 const intro=cancelled?'This reservation is cancelled.'+(!reservation?' Payment received. Please contact ER Limousine Service for payment review.':' Please contact ER Limousine Service with any questions.'):
  reservation?(admin?'A new ER Limousine Service reservation has been created.':paid?'Your trip has been successfully reserved. Payment is confirmed.':'Your trip has been successfully reserved. Payment has not been completed and is still due.'):
  admin?'Payment has been confirmed for this ER Limousine Service reservation.':'Thank you for choosing ER Limousine Service. Your payment has been confirmed.';
 const support='Contact ER Limousine Service: '+contact.email+(contact.phone?' | '+contact.phone:'');
 const link=kind==='customer_reservation_created' && !cancelled && myTripsUrl;
 const action=link?'Open My Trips to view your reservation'+(!paid?' and use Complete Payment':'')+': '+link:'';
 return {to:admin?contact.email:customer.email,
  subject:(reservation?(admin?'New reservation':cancelled?'Reservation Cancelled':paid?'Reservation Confirmed':'Reservation Confirmed — Payment Due'):'Payment Confirmed')+(admin?' — '+record.id:' | ER Limousine Service'),
  text:'ER Limousine Service\n\n'+intro+'\n\n'+rows.map(([k,v])=>k+': '+v).join('\n')+(action?'\n\n'+action:'')+'\n\n'+support,
  html:'<h1>ER Limousine Service</h1><p>'+escape(intro)+'</p><table>'+rows.map(([k,v])=>'<tr><th align="left">'+escape(k)+'</th><td>'+escape(v)+'</td></tr>').join('')+'</table>'+(action?'<p><a href="'+escape(link)+'">Open My Trips'+(!paid?' / Complete Payment':'')+'</a></p>':'')+'<p>'+(admin?escape(support):customerSupportHtml(contact))+'</p>'};
}
function createBookingEmails({store,provider,contact,siteUrl,now=Date.now,reportFailure=()=>{}}){
 let running=null,myTripsUrl=null;
 try{const u=new URL(siteUrl);if(!u.username && !u.password && (u.protocol==='https:' || u.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname)))myTripsUrl=new URL('/account/dashboard',u.origin).href;}catch(_){}

 const enabled=!!provider?.enabled && typeof provider.sendBookingEmail==='function';
 function run(){
  if(!enabled)return Promise.resolve();
  if(running)return running;
  running=(async()=>{
   for(let i=0;i<10;i++){
    const job=await store.claimBookingEmail(now());if(!job)break;if(job.reviewRequired){reportFailure();continue;}
    try{
     const link=job.kind==='customer_reservation_created' && !job.payload && myTripsUrl && await store.reservationOwner(job.booking_id)?myTripsUrl:null;
     const event=!job.payload && tripActionKinds.includes(job.kind)?await store.tripEvent(job.event_id,job.booking_id):null;
     const message=job.payload || bookingMessage(await store.get(job.booking_id),job.kind,contact,link,event);
     const prepared=await store.prepareBookingEmail(job.id,job.claim_token,message,now());
     if(!prepared)continue;
     // A stale worker must never submit after its lease or provider retry window.
     if(now()>=new Date(prepared.lease_until).getTime() || now()-new Date(prepared.first_submitted_at).getTime()>=23*3600000)continue;
     await provider.sendBookingEmail({...prepared.payload,idempotencyKey:'booking-email/'+job.id});
     await store.finishBookingEmail(job.id,job.claim_token,true,now());
    }catch(_){reportFailure();try{await store.finishBookingEmail(job.id,job.claim_token,false,now());}catch(_){reportFailure();}}
   }
  })().catch(()=>reportFailure()).finally(()=>{running=null;});
  return running;
 }
 return {run};
}
module.exports={createBookingEmails,bookingMessage};
