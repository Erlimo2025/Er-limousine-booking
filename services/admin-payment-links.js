const {paymentVerificationPending}=require('../storage/customer-trips');
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const error=(status,message='Payment link unavailable. Refresh and try again.')=>Object.assign(new Error(message),{status,paymentLinkSafe:true});
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function eligible(record){return !!record && record.status!=='cancelled' && ['unpaid','failed'].includes(record.paymentStatus) && record.paymentReviewRequired!==true && record.checkoutAttempt?.state!=='review_required' && !paymentVerificationPending(record);}
function hostedUrl(value,sessionId){
 try{const url=new URL(value);if(url.protocol==='https:' && url.hostname==='checkout.stripe.com' && !url.port && !url.username && !url.password && ['/c/pay/','/pay/'].some(prefix=>url.pathname===prefix+sessionId))return value;}catch(_){}
 throw error(503,'Checkout is temporarily unavailable. Please try again.');
}
function linkMessage(record,url,expiresAt,contact){
 if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(record.customer.email)||record.customer.email.length>200)throw error(409,'Reservation email unavailable. Please verify its contact information.');
 const amount=new Intl.NumberFormat('en-US',{style:'currency',currency:record.quote.currency}).format(record.quote.total),deadline=require('../public/trip-date-format').instant(expiresAt);
 const text='Please use this secure Stripe Checkout link to pay your existing ER Limousine Service reservation.\n\nTotal: '+amount+'\nComplete Payment: '+url+'\nLink expires: '+deadline+'\n\nThis link permits payment only; it does not grant account or reservation-management access. Payment is confirmed only after verification. If the link has expired, contact ER Limousine Service for a new link.\n\nContact ER Limousine Service: '+contact.email+(contact.phone?' | '+contact.phone:'');
 return {to:record.customer.email,subject:'Complete Your Reservation Payment | ER Limousine Service',text,html:'<h1>ER Limousine Service</h1><p>Please pay your existing reservation using secure Stripe Checkout.</p><p>Total: '+escape(amount)+'</p><p><a href="'+escape(url)+'">Complete Payment</a></p><p>Link expires: '+escape(deadline)+'</p><p>This link permits payment only, not account or reservation-management access. Payment is confirmed only after verification. Contact us if the link expires.</p><p>'+escape(contact.email)+(contact.phone?' | '+escape(contact.phone):'')+'</p>'};
}
function adminPaymentLinks({store,checkout,actionKey,provider,contact,siteUrl,now=Date.now,reportFailure=()=>{}}){
 const queue=require('./booking-emails').createBookingEmails({store:{claimBookingEmail:time=>store.claimAdminPaymentLinkEmail(time),prepareBookingEmail:(...args)=>store.prepareAdminPaymentLinkEmail(...args),finishBookingEmail:(...args)=>store.finishAdminPaymentLinkEmail(...args)},provider,contact,siteUrl,now,reportFailure});
 async function request(auth,id,action){
  if(!auth || !uuid.test(auth.actorId) || typeof auth.authorized!=='function' || !auth.authorized())throw error(401,'Authentication required.');
  if(!uuid.test(id) || !['copy','email'].includes(action))throw error(400,'Invalid payment-link request.');
  if(action==='email' && !provider?.enabled)throw error(503,'Booking email delivery is unavailable. You can copy the payment link instead.');
  const initial=await store.get(id);if(!initial)throw error(404,'Booking not found.');
  return store.withActionLock(actionKey(initial),async()=>{
   const record=await store.get(id);if(!auth.authorized())throw error(401,'Authentication required.');if(!eligible(record))throw error(409);
   if(action==='email')linkMessage(record,'',new Date(now()).toISOString(),contact);
   // An empty customer context cannot expose saved cards or acquire account ownership.
   const result=await checkout(record.trip,record,{},true,true),fresh=await store.get(id);
   if(!auth.authorized())throw error(401,'Authentication required.');if(!eligible(fresh))throw error(409);
   const url=hostedUrl(result.url,fresh.stripeSessionId),expiresAt=result.expiresAt;
   const saved=await store.recordAdminPaymentLink(auth,id,action,fresh.stripeSessionId,expiresAt,action==='email'?linkMessage(fresh,url,expiresAt,contact):null,now());
   if(!auth.authorized())throw error(401,'Authentication required.');
   return {...(action==='copy'?{url}:{}),expiresAt,state:saved.state};
  });
 }
 return {request,runEmails:queue.run};
}
module.exports={adminPaymentLinks,eligible,hostedUrl,linkMessage,paymentLinkError:error};
