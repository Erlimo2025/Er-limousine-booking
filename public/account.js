'use strict';
const el=id=>document.getElementById(id);
let accountGeneration=0;
function hidePasswords(){
  for(const input of document.querySelectorAll('input[type=password], input[data-password-input]'))input.type='password';
  for(const button of document.querySelectorAll('[data-password-toggle]')){
    button.textContent='Show';button.setAttribute('aria-pressed','false');button.setAttribute('aria-label','Show password');
  }
}
function show(view){
  hidePasswords();
  for(const name of ['login','register','dashboard','recovery'])if(el(name+'View'))el(name+'View').hidden=name!==view;
  el('accountNavigation').hidden=view!=='dashboard';
  el('accountShell').classList.toggle('is-dashboard',view==='dashboard');
  el('message').textContent='';el('message').classList?.remove?.('success');
}
function displayFirstName(fullName){
  const first=fullName.trim().split(/\s+/)[0];
  const characters=Array.from(first);
  return characters.length?characters[0].toLocaleUpperCase()+characters.slice(1).join(''):'';
}
function dashboard(customer){
  el('welcome').textContent='Welcome, '+displayFirstName(customer.fullName);
  el('profileName').textContent=customer.fullName;el('profileEmail').textContent=customer.email;el('profilePhone').textContent=customer.phone;
  show('dashboard');
  if(el('tripsPanel'))loadTrips(false);
}
async function api(path,data){
  const response=await fetch('/api/customer/'+path,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json'}:{},credentials:'same-origin',cache:'no-store',body:data?JSON.stringify(data):undefined});
  const result=await response.json();
  if(!response.ok)throw Object.assign(new Error(result.error || 'Service temporarily unavailable. Please try again.'),{status:response.status});
  return result;
}
function authForm(id,path,values){
  el(id).addEventListener('submit',async event=>{
    event.preventDefault();
    const generation=++accountGeneration;
    const button=el(id).querySelector('button[type=submit]');button.disabled=true;el('message').textContent='';
    try{
      const result=await api(path,values());if(generation!==accountGeneration)return;el(id).reset();dashboard(result.customer);history.replaceState(null,'','/account/dashboard');
    }catch(error){el('message').textContent=error.message;}
    finally{el(id).querySelector('[data-password-input]').value='';hidePasswords();button.disabled=false;}
  });
}
authForm('loginForm','login',()=>({email:el('loginEmail').value,password:el('loginPassword').value}));
authForm('registerForm','register',()=>({fullName:el('fullName').value,email:el('registerEmail').value,phone:el('phone').value,password:el('registerPassword').value}));
for(const button of document.querySelectorAll('[data-password-toggle]')){
  button.addEventListener('click',()=>{
    const input=el(button.dataset.passwordToggle),visible=input.type==='password';
    input.type=visible?'text':'password';button.textContent=visible?'Hide':'Show';
    button.setAttribute('aria-pressed',String(visible));button.setAttribute('aria-label',visible?'Hide password':'Show password');
  });
}
async function logout(){
  accountGeneration++;clearTrips();
  const buttons=[el('logout'),el('navLogout')];for(const button of buttons)button.disabled=true;
  try{
    await api('logout',{});clearPrivateAccount();
    el('profileName').textContent='';el('profileEmail').textContent='';el('profilePhone').textContent='';el('welcome').textContent='Welcome';
    history.replaceState(null,'','/account.html');show('login');
  }catch(error){el('message').textContent=error.message;}
  finally{for(const button of buttons)button.disabled=false;}
}
el('logout').addEventListener('click',logout);el('navLogout').addEventListener('click',logout);
async function load(){const generation=++accountGeneration;clearPrivateAccount();try{const result=await api('profile');if(generation!==accountGeneration)return;dashboard(result.customer);}catch(_){if(generation!==accountGeneration)return;show(location.hash==='#create'?'register':location.hash==='#recover'?'recovery':'login');}}
window.addEventListener('hashchange',()=>{
  // Profile navigation must not switch an authenticated dashboard to the login view.
  if(location.hash==='#profile' && !el('dashboardView').hidden)return;
  el('loginForm').reset();el('registerForm').reset();show(location.hash==='#create'?'register':location.hash==='#recover'?'recovery':'login');
});
window.addEventListener('pageshow',()=>load());

const recoveryForm=el('recoveryEmailForm');
if(recoveryForm)recoveryForm.addEventListener('submit',async event=>{
  event.preventDefault();const button=recoveryForm.querySelector('button[type=submit]');button.disabled=true;el('message').textContent='';
  try{
    const result=await api('recovery/request',{email:el('recoveryEmail').value});
    el('recoveryNotice').textContent=result.message;el('recoveryNotice').hidden=false;
    setTimeout(()=>{button.disabled=false;},60000);
  }catch(error){el('message').textContent=error.message;button.disabled=false;}
});

// Private trip data stays only in the current DOM. Generation checks discard stale responses.
let tripsView='upcoming',tripsCursor=null,tripsGeneration=0;
function clearTrips(){
 tripsGeneration++;tripsCursor=null;
 if(!el('tripsPanel'))return;
 el('tripsList').replaceChildren();el('tripsStatus').textContent='';
 el('tripsMore').hidden=true;el('tripsRetry').hidden=true;el('tripsBook').hidden=true;
}
function clearPrivateAccount(){
 clearTrips();for(const id of ['profileName','profileEmail','profilePhone','welcome'])el(id).textContent='';
 el('dashboardView').hidden=true;el('accountNavigation').hidden=true;
}
function tripCard(trip){
 const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
 const card=node('section','trip-card'),heading=node('h3','trip-route',trip.pickup+' → '+trip.dropoff);
 const labels={awaiting_payment:'Payment Pending',confirmed:'Confirmed',assigned:'Assigned',driver_en_route:'Driver en route',passenger_on_board:'Passenger on board',completed:'Completed',cancelled:'Cancelled',unpaid:'Unpaid',paid:'Paid',failed:'Failed'};
 const processing=trip.paymentVerificationPending===true;
 const refund=trip.status==='cancelled'&&trip.paymentStatus==='paid'&&['processing','review_required','confirmed','failed'].includes(trip.refundStatus)?trip.refundStatus:null;
 const badges=node('div','trip-badges');
 if(!(trip.status==='awaiting_payment' && trip.paymentStatus==='unpaid' && !processing))badges.append(node('span','trip-badge',processing&&trip.status!=='cancelled'?'Payment verification in progress':labels[trip.status]||trip.status));
 badges.append(node('span','trip-badge',refund?{processing:'Refund processing',confirmed:'Refund confirmed',review_required:'Refund review required',failed:'Refund review required'}[refund]:processing?'Payment verification in progress':labels[trip.paymentStatus]||trip.paymentStatus));
 const money=new Intl.NumberFormat('en-US',{style:'currency',currency:trip.currency}).format(trip.total);
 const dateTime=(date,time)=>date+' · '+time+' (New York time)';
 card.append(badges,heading,node('p','trip-date',dateTime(trip.date,trip.time)),node('p','trip-vehicle',trip.vehicle),node('p','trip-total',money));
 const details=node('details','trip-details'),summary=node('summary','', 'Trip details'),list=node('dl');
 const add=(label,value)=>{const row=node('div');row.append(node('dt','',label),node('dd','',String(value)));list.append(row);};
 add('Booking reference',trip.reference);add('Trip type',{oneway:'One Way',airport:'Airport',roundtrip:'Round Trip',hourly:'Hourly'}[trip.tripType]||trip.tripType);add('Passengers',trip.passengers);
 if(trip.returnDate)add('Return pickup',dateTime(trip.returnDate,trip.returnTime));
 if(trip.hours)add('Booked duration',trip.hours+' hours');
 if(trip.pickupTerminal)add('Pickup terminal',trip.pickupTerminal);
 if(trip.dropoffTerminal)add('Drop-off terminal',trip.dropoffTerminal);
 add('Booked on',new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeZone:'America/New_York'}).format(new Date(trip.createdAt)));
 details.append(summary,list);card.append(details);
 if(trip.canBookAgain===true){
  const again=node('a','text-button trip-book-again','Book Again');again.href='/?bookAgain='+encodeURIComponent(trip.reference)+'#book';card.append(again);
 }
 if(refund)card.append(node('p','trip-payment-review',refund==='confirmed'?'This trip is cancelled. Your full refund has been confirmed.':refund==='processing'?'This trip is cancelled. Your full refund is processing; it has not been confirmed yet. You do not need to pay again.':'This trip is cancelled. Your refund requires review. Please contact ER Limousine Service; no refund has been confirmed.'));
 else if(trip.status==='cancelled'&&trip.paymentStatus==='paid')card.append(node('p','trip-payment-review','Payment received for this cancelled trip. Please contact ER Limousine Service for payment review.'));
 if(processing&&trip.status!=='cancelled')card.append(node('p','trip-payment-review','We’re confirming your payment. You do not need to pay again.'));
 if(trip.paymentStatus!=='paid' && trip.status!=='cancelled' && !processing){
  const pay=node('button','primary trip-payment','Complete Payment');pay.type='button';
  pay.addEventListener('click',async()=>{
   if(pay.disabled)return;const generation=accountGeneration,tripGeneration=tripsGeneration;pay.disabled=true;
   try{const result=await api('trips/'+encodeURIComponent(trip.reference)+'/payment',{});if(generation!==accountGeneration||tripGeneration!==tripsGeneration)return;location.assign(result.url);}
   catch(error){if(generation!==accountGeneration||tripGeneration!==tripsGeneration)return;if(error.status===401){clearPrivateAccount();show('login');return;}if(error.status===409){await loadTrips(false);return;}el('tripsStatus').textContent='Unable to start payment. Please refresh your trips and try again.';}
   finally{if(generation===accountGeneration&&tripGeneration===tripsGeneration)pay.disabled=false;}
  });card.append(pay);
 }
 if(trip.management)card.append(tripManagement(trip,node));
 return card;
}
function tripManagement(trip,node){
 const management=trip.management,section=node('details','trip-management'),summary=node('summary','','Manage Trip');
 section.append(summary);
 const generation=accountGeneration,tripGeneration=tripsGeneration;
 const current=()=>generation===accountGeneration&&tripGeneration===tripsGeneration&&!el('dashboardView').hidden;
 const message=node('p','trip-management-status');message.setAttribute('role','status');message.setAttribute('aria-live','polite');
 const actions=node('div','trip-management-actions');
 const contact=()=>{
  const row=node('p','trip-management-contact','Please contact ER Limousine.');
  const phone=management.contact?.phone,email=management.contact?.email;
  if(typeof phone==='string'){
   const number=phone.replace(/[\s().-]/g,'');
   if(/^\+?\d{7,15}$/.test(number)){const link=node('a','',phone);link.href='tel:'+number;row.append(node('span','',' '),link);}
  }
  if(typeof email==='string'&&/^[A-Za-z0-9._%+-]{1,100}@[A-Za-z0-9.-]{1,100}\.[A-Za-z]{2,30}$/.test(email)){const link=node('a','',email);link.href='mailto:'+email;row.append(node('span','',' '),link);}
  return row;
 };
 let pending=false,retrySubmission=null;
 const submit=async(action,values,controls)=>{
  if(pending||!current())return;
  const signature=JSON.stringify({action,...values});
  if(!retrySubmission||retrySubmission.signature!==signature)retrySubmission={signature,requestId:crypto.randomUUID()};
  pending=true;for(const control of controls)control.disabled=true;message.textContent='Saving your trip update…';
  try{
   const result=await api('trips/'+encodeURIComponent(trip.reference)+'/'+action,{...values,expectedPickupAt:management.pickupAt,requestId:retrySubmission.requestId,confirmed:true});
   if(!current())return;
   const refreshed=await loadTrips(false);
   if(generation===accountGeneration&&refreshed===tripsGeneration&&!el('dashboardView').hidden)el('tripsStatus').textContent=action!=='cancel'?'Pickup time updated.':result.trip?.refundStatus==='confirmed'?'Your trip has been cancelled. Your full refund has been confirmed.':result.trip?.refundStatus==='processing'?'Your trip has been cancelled. Your full refund is processing; it has not been confirmed yet.':['review_required','failed'].includes(result.trip?.refundStatus)?'Your trip has been cancelled. Please contact ER Limousine for refund review.':trip.paymentStatus==='paid'?'Your cancellation request was accepted. Please review the updated trip status.':'Your trip has been cancelled.';
  }catch(error){
   if(!current())return;
   if(error.status===401){accountGeneration++;clearPrivateAccount();show('login');return;}
   if(error.status===409){const refreshed=await loadTrips(false);if(generation===accountGeneration&&refreshed===tripsGeneration&&!el('dashboardView').hidden)el('tripsStatus').textContent='Your trip has changed. Please review its current details and try again.';return;}
   message.textContent=action==='cancel'?'Unable to cancel this trip. Please try again or contact ER Limousine.':'Unable to update pickup time. Please try again or contact ER Limousine.';
  }finally{
   pending=false;if(current())for(const control of controls)control.disabled=false;
  }
 };
 if(management.canChangePickupTime===true){
  const open=node('button','trip-management-button','Change Pickup Time');open.type='button';
  const form=node('form','trip-time-form');form.hidden=true;
  const prefix='trip-time-'+trip.reference;
  const date=node('input'),time=node('input');date.type='date';date.id=prefix+'-date';date.required=true;date.value=trip.date;time.type='time';time.id=prefix+'-time';time.required=true;time.value=trip.time;
  const field=(text,input)=>{const wrapper=node('div','form-field'),label=node('label','',text);label.htmlFor=input.id;wrapper.append(label,input);return wrapper;};
  const consent=node('input');consent.type='checkbox';consent.required=true;consent.id=prefix+'-confirm';
  const consentLabel=node('label','trip-management-confirm');consentLabel.htmlFor=consent.id;consentLabel.append(consent,node('span','','I confirm this new pickup date and time (New York time).'));
  const save=node('button','primary','Save Pickup Time');save.type='submit';
  form.append(field('New pickup date',date),field('New pickup time (New York time)',time),consentLabel,save);
  open.addEventListener('click',()=>{if(!current()||pending)return;form.hidden=!form.hidden;open.setAttribute('aria-expanded',String(!form.hidden));if(!form.hidden)date.focus();});open.setAttribute('aria-expanded','false');open.setAttribute('aria-controls',prefix+'-form');form.id=prefix+'-form';
  form.addEventListener('submit',event=>{event.preventDefault();if(!current()||pending)return;if(!consent.checked||!date.value||!time.value){message.textContent='Choose a pickup date and time and confirm the change before saving.';return;}submit('pickup-time',{date:date.value,time:time.value},[open,date,time,consent,save]);});
  actions.append(open);section.append(form);
 }
 if(management.canCancel===true){
  const cancel=node('button','trip-management-button','Cancel Trip');cancel.type='button';
  const confirmation=node('div','trip-cancel-confirmation');confirmation.hidden=true;
  const explanation=node('p','',trip.paymentStatus==='paid'?'Cancel this trip and request a full refund? Your reservation will be cancelled. Refund completion will be confirmed separately. This cannot be undone.':'Cancel this trip? Your reservation will be cancelled. This cannot be undone.'),yes=node('button','trip-management-button','Confirm Cancellation'),no=node('button','trip-management-button','Keep Trip');yes.type=no.type='button';
  confirmation.append(explanation,yes,no);
  cancel.addEventListener('click',()=>{if(!current()||pending)return;confirmation.hidden=false;cancel.setAttribute('aria-expanded','true');yes.focus();});cancel.setAttribute('aria-expanded','false');
  no.addEventListener('click',()=>{if(!current()||pending)return;confirmation.hidden=true;cancel.setAttribute('aria-expanded','false');cancel.focus();});
  yes.addEventListener('click',()=>submit('cancel',{},[cancel,yes,no]));actions.append(cancel);section.append(confirmation);
 }
 if(management.cancelReason==='within_24_hours'){section.append(node('p','trip-management-guidance','Online cancellation is unavailable within 24 hours of pickup. Please contact ER Limousine.'),contact());}
 else if(management.cancelReason==='payment_processing'){section.append(node('p','trip-management-guidance','Your payment is being verified. Please contact ER Limousine for cancellation assistance.'),contact());}
 section.append(actions,message);
 if(!actions.children.length&&!['within_24_hours','payment_processing'].includes(management.cancelReason))section.hidden=true;
 return section;
}
async function loadTrips(more){
 if(!el('tripsPanel'))return;
 if(!more)clearTrips();
 const generation=++tripsGeneration,account=accountGeneration,cursor=more?tripsCursor:null;
 el('tripsStatus').textContent='Loading trips…';el('tripsMore').disabled=true;el('tripsRetry').hidden=true;el('tripsBook').hidden=true;
 try{
  const result=await api('trips?view='+tripsView+'&limit=20'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
  if(account!==accountGeneration||generation!==tripsGeneration || el('dashboardView').hidden)return;
  for(const trip of result.trips)el('tripsList').append(tripCard(trip));
  tripsCursor=result.nextCursor;el('tripsMore').hidden=!tripsCursor;
  const empty=el('tripsList').childElementCount===0;
  el('tripsStatus').textContent=empty?'No '+tripsView+' trips. Only rides booked while signed into this account appear here.':'';
  el('tripsBook').hidden=!empty;
  return generation;
 }catch(error){
  if(account!==accountGeneration||generation!==tripsGeneration)return;
  if(error.status===401){clearPrivateAccount();show('login');return;}
  el('tripsStatus').textContent=error.message;el('tripsRetry').hidden=false;
 }finally{if(account===accountGeneration&&generation===tripsGeneration)el('tripsMore').disabled=false;}
}
if(el('tripsPanel')){
 for(const [id,view] of [['upcomingTrips','upcoming'],['pastTrips','past']])el(id).addEventListener('click',()=>{
  tripsView=view;el('upcomingTrips').setAttribute('aria-pressed',String(view==='upcoming'));el('pastTrips').setAttribute('aria-pressed',String(view==='past'));loadTrips(false);
 });
 el('tripsMore').addEventListener('click',()=>loadTrips(true));
 el('tripsRetry').addEventListener('click',()=>loadTrips(false));
 window.addEventListener('pagehide',()=>{accountGeneration++;clearPrivateAccount();});
}
