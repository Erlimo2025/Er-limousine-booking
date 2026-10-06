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
function bookingMessage(record,kind,contact,myTripsUrl=null){
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
     const message=job.payload || bookingMessage(await store.get(job.booking_id),job.kind,contact,link);
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
