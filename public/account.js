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
  const signedIn=view==='dashboard';
  closeAccountMenu();
  el('accountNavigation').hidden=!signedIn;
  if(el('headerBook'))el('headerBook').hidden=signedIn;
  el('accountHeader')?.classList.toggle('is-dashboard',signedIn);
  el('accountShell').classList.toggle('is-dashboard',signedIn);
  el('message').textContent='';el('message').classList?.remove?.('success');
}
function displayFirstName(fullName){
  const first=fullName.trim().split(/\s+/)[0];
  const characters=Array.from(first);
  return characters.length?characters[0].toLocaleUpperCase()+characters.slice(1).join(''):'';
}
function dashboard(customer){
  displayProfile(customer);
  show('dashboard');
  if(el('tripsPanel'))selectTripsView('upcoming');
}
function displayProfile(customer){
  el('welcome').textContent='Welcome, '+displayFirstName(customer.fullName);
  el('profileName').textContent=customer.fullName;el('profileEmail').textContent=customer.email;el('profilePhone').textContent=customer.phone;
}
function closeProfileEditor(){
 if(!el('profileForm'))return;
 el('profileForm').hidden=true;el('editProfile').setAttribute('aria-expanded','false');
 for(const id of ['editFullName','editEmail','editPhone'])el(id).value='';
 el('saveProfile').disabled=false;el('cancelProfile').disabled=false;el('editProfile').disabled=false;
 el('profileStatus').textContent='';
}
if(el('profileForm')){
 el('editProfile').addEventListener('click',()=>{
  el('editFullName').value=el('profileName').textContent;el('editEmail').value=el('profileEmail').textContent;el('editPhone').value=el('profilePhone').textContent;
  el('profileForm').hidden=false;el('editProfile').setAttribute('aria-expanded','true');el('profileStatus').textContent='';el('editFullName').focus();
 });
 el('cancelProfile').addEventListener('click',closeProfileEditor);
 el('profileForm').addEventListener('submit',async event=>{
  event.preventDefault();if(el('saveProfile').disabled)return;
  const generation=accountGeneration;
  for(const id of ['saveProfile','cancelProfile','editProfile'])el(id).disabled=true;
  el('profileStatus').textContent='Saving profile…';
  try{
   const result=await api('profile',{fullName:el('editFullName').value,phone:el('editPhone').value});
   if(generation!==accountGeneration)return;
   displayProfile(result.customer);closeProfileEditor();el('profileStatus').textContent='Profile updated successfully.';el('editProfile').focus();
  }catch(error){
   if(generation!==accountGeneration)return;
   if(error.status===401){accountGeneration++;clearPrivateAccount();show('login');history.replaceState(null,'','/account.html');el('message').textContent='Please log in to continue.';}
   else el('profileStatus').textContent=error.message;
  }finally{if(generation===accountGeneration)for(const id of ['saveProfile','cancelProfile','editProfile'])el(id).disabled=false;}
 });
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
  accountGeneration++;clearTrips();closeProfileEditor();
  closeAccountMenu();
  const button=el('navLogout');
  button.disabled=true;
  try{
    await api('logout',{});clearPrivateAccount();
    el('profileName').textContent='';el('profileEmail').textContent='';el('profilePhone').textContent='';el('welcome').textContent='Welcome';
    history.replaceState(null,'','/account.html');show('login');
  }catch(error){el('message').textContent=error.message;}
  finally{button.disabled=false;}
}
el('navLogout').addEventListener('click',logout);
async function load(){const generation=++accountGeneration;clearPrivateAccount();try{const result=await api('profile');if(generation!==accountGeneration)return;dashboard(result.customer);}catch(_){if(generation!==accountGeneration)return;show(location.hash==='#create'?'register':location.hash==='#recover'?'recovery':'login');}}
window.addEventListener('hashchange',()=>{
  // Profile navigation must not switch an authenticated dashboard to the login view.
  if(location.hash==='#profile' && !el('dashboardView').hidden)return;
  el('loginForm').reset();el('registerForm').reset();show(location.hash==='#create'?'register':location.hash==='#recover'?'recovery':'login');
});
window.addEventListener('pageshow',()=>load());

function closeAccountMenu(restoreFocus=false){
 const toggle=el('accountMenuToggle'),menu=el('accountMenu');
 if(!menu||!toggle)return;
 menu.hidden=true;
 toggle.setAttribute('aria-expanded','false');
 if(restoreFocus)toggle.focus();
}
if(el('accountMenuToggle')){
 const toggle=el('accountMenuToggle'),menu=el('accountMenu');
 toggle.addEventListener('click',()=>{
  if(!menu.hidden){closeAccountMenu();return;}
  menu.hidden=false;
  toggle.setAttribute('aria-expanded','true');
 });
 window.addEventListener('click',event=>{
  if(!menu.hidden&&!el('accountNavigation').contains(event.target))closeAccountMenu();
 });
 window.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!menu.hidden){
   event.preventDefault();
   closeAccountMenu(true);
  }
 });
 el('menuProfile').addEventListener('click',()=>{
  closeAccountMenu();
  el('profileHeading').focus();
 });
 el('menuBook').addEventListener('click',()=>closeAccountMenu());
}

const recoveryForm=el('recoveryEmailForm');
if(recoveryForm)recoveryForm.addEventListener('submit',async event=>{
  event.preventDefault();const button=recoveryForm.querySelector('button[type=submit]');button.disabled=true;el('message').textContent='';
  try{
    const result=await api('recovery/request',{email:el('recoveryEmail').value});
    el('recoveryNotice').textContent=result.message;el('recoveryNotice').hidden=false;
    setTimeout(()=>{button.disabled=false;},60000);
  }catch(error){el('message').textContent=error.message;button.disabled=false;}
});

// Trip records stay in the current DOM. Page cursors and reference keys are discarded on view or session changes.
const tripTabs={upcoming:'upcomingTrips',past:'pastTrips',cancelled:'cancelledTrips'};
const tripViews={
 upcoming:{empty:'No upcoming trips.'},
 past:{empty:'No past trips.'},
 cancelled:{empty:'No cancelled trips.'},
 requests:{title:'Reservation Requests',description:'Choose a trip to view its requests or send a new one where available.',empty:'No trips available to review.'},
 payment:{title:'Complete Payment',description:'Choose an eligible unpaid trip to continue to secure checkout.',empty:'No trips need payment.'}
};
let tripsView='upcoming',tripsPages=[],tripsGeneration=0,tripsLoading=false,retryMore=false;
const tripReferences=new Set();
function clearTrips(){
 tripsGeneration++;
 tripsPages=[];tripReferences.clear();tripsLoading=false;retryMore=false;
 if(!el('tripsPanel'))return;
 el('tripsList').replaceChildren();el('tripsList').setAttribute('aria-busy','false');el('tripsStatus').textContent='';
 el('tripsMore').hidden=true;el('tripsMore').disabled=false;el('tripsRetry').hidden=true;el('tripsBook').hidden=true;
}
function clearPrivateAccount(){
 closeProfileEditor();
 closeAccountMenu();
 clearTrips();for(const id of ['profileName','profileEmail','profilePhone','welcome'])el(id).textContent='';
 el('dashboardView').hidden=true;el('accountNavigation').hidden=true;
}
function tripCard(trip,view='upcoming'){
 const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
 // Render adjacent repeated terminal labels once; never mutate booking data.
 const locationLabel=value=>String(value).replace(/\b(Terminal\s+([ABC]))(?:\s*,\s*Terminal\s+\2(?=\s*(?:,|$)))+/gi,'$1');
 const card=node('article','trip-card');
 const labels={awaiting_payment:'Payment Pending',confirmed:'Confirmed',assigned:'Assigned',driver_en_route:'Driver en route',passenger_on_board:'Passenger on board',completed:'Completed',cancelled:'Cancelled',unpaid:'Unpaid',paid:'Paid',failed:'Failed'};
 const processing=trip.paymentVerificationPending===true;
 const refund=trip.status==='cancelled'&&trip.paymentStatus==='paid'&&['processing','review_required','confirmed','failed'].includes(trip.refundStatus)?trip.refundStatus:null;
 const badges=node('div','trip-badges');
 const reservationBadge=node('span','trip-badge',labels[trip.status]||trip.status);
 const paymentBadge=node('span','trip-badge',refund?{processing:'Refund processing',confirmed:'Refund confirmed',review_required:'Refund review required',failed:'Refund review required'}[refund]:processing?'Payment verification in progress':labels[trip.paymentStatus]||trip.paymentStatus);
 reservationBadge.setAttribute('data-state',trip.status);
 paymentBadge.setAttribute('data-state',refund?'refund-'+refund:processing?'verifying':trip.paymentStatus);
 badges.append(reservationBadge,paymentBadge);
 const money=new Intl.NumberFormat('en-US',{style:'currency',currency:trip.currency}).format(trip.total);
 const dateTime=(date,time)=>TripDateFormat.trip(date,time);
 const head=node('div','trip-card-head'),schedule=node('div','trip-schedule');
 const pickupTime=TripDateFormat.date(trip.date)+' · '+TripDateFormat.time(trip.time);
 schedule.append(node('p','trip-label','Pickup date & time · New York'),node('h3','trip-date',pickupTime));
 head.append(schedule,badges);
 const route=node('dl','trip-route'),fareRow=node('dl','trip-fare-row');
 const field=(label,text,className)=>{
  const row=node('div');
  row.append(node('dt','trip-label',label),node('dd',className,text));
  return row;
 };
 const waiting=trip.stopSummary;
 route.append(field('Pickup',locationLabel(trip.pickup),'trip-address'));
 if(waiting){
  route.classList.add('trip-route-stops');
  for(const stop of waiting.stops)route.append(field('Stop '+stop.sequence,BookingStops.stopText(stop),'trip-address'));
 }
 route.append(field(waiting?'Final destination':'Destination',locationLabel(trip.dropoff),'trip-address'));
 fareRow.append(field('Vehicle',trip.vehicle,'trip-vehicle'),field('Accepted fare',money,'trip-total'));
 const referenceRow=node('div','trip-reference-row');
 const reference=trip.bookingReference || trip.reference;
 const referenceValue=()=>globalThis.BookingReference?.control(reference) || node('span','booking-reference-value',reference);
 referenceRow.append(node('span','trip-label','Booking reference'),referenceValue());
 card.append(head,route,fareRow,referenceRow);
 const details=node('details','trip-details'),summary=node('summary','', 'View Trip Details'),list=node('dl');
 const detailsReference=node('div'),detailsValue=node('dd');
 detailsValue.append(referenceValue());
 detailsReference.append(node('dt','','Booking reference'),detailsValue);
 list.append(detailsReference);
 details.addEventListener('toggle',()=>{referenceRow.hidden=details.open;});
 const add=(label,value)=>{const row=node('div');row.append(node('dt','',label),node('dd','',String(value)));list.append(row);};
 add('Trip type',{oneway:'One Way',airport:'Airport',roundtrip:'Round Trip',hourly:'Hourly'}[trip.tripType]||trip.tripType);add('Passengers',trip.passengers);
 if(trip.returnDate)add('Return pickup',dateTime(trip.returnDate,trip.returnTime));
 if(trip.hours)add('Booked duration',trip.hours+' hours');
 if(trip.pickupTerminal)add('Pickup terminal',trip.pickupTerminal);
 if(trip.dropoffTerminal)add('Drop-off terminal',trip.dropoffTerminal);
 const p=trip.pricingBreakdown,price=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:trip.currency}).format(value/100);
 const waitingCents=waiting?.chargeCents || 0;
 if(waiting){
  add('Pickup',locationLabel(trip.pickup));
  for(const stop of waiting.stops)add('Stop '+stop.sequence,BookingStops.stopText(stop));
  add('Final destination',locationLabel(trip.dropoff));
 }
 if(p?.version===1 || waiting){
  const total=p?.totalCents ?? Math.round(trip.total*100);
  add('Trip Fare',price(total-(p?.tollsCents||0)-waitingCents));
  add('Tolls',!p||p.tollsIncluded||p.tollStatus==='absorbed'?'Included':price(p.tollsCents||0));
  if(waiting)add('Additional Stop Waiting',price(waitingCents));
  add('Total',price(total));
 }
 const cancellation=trip.cancellationPolicy;
 if(cancellation){
  add(cancellation.acceptedAt?'Accepted cancellation policy':'Cancellation policy at booking',cancellation.policy.version);
  if(cancellation.acceptedAt)add('Policy accepted',TripDateFormat.instant(cancellation.acceptedAt));
  add('Refund terms',cancellation.policy.summary);
  for(const tier of cancellation.policy.tiers)add('Cancellation window',tier.text);
 }
 add('Booked on',TripDateFormat.instant(trip.createdAt,false));
 details.append(summary,list);
 const primaryActions=node('div','trip-primary-actions');
 primaryActions.append(details);
 const reservationLink=node('a','trip-action-link','Manage Trip');
 reservationLink.href='/manage-reservation.html?reservation='+encodeURIComponent(trip.reference)+(view==='requests'?'#manageRequestsHeading':'');
 const management=trip.management;
 if(view==='requests'){
  reservationLink.textContent='View Requests';
  primaryActions.append(reservationLink);
 }else if(management&&(management.canChangePickupTime===true||management.canCancel===true||
   ['within_24_hours','payment_processing'].includes(management.cancelReason))){
  reservationLink.textContent='Manage My Reservation';
  reservationLink.className='trip-management-button';
  primaryActions.append(tripManagement(trip,node,reservationLink));
 }else primaryActions.append(reservationLink);
 if(trip.canBookAgain===true){
  const again=node('a','trip-action-link trip-book-again','Book Again');again.href='/?bookAgain='+encodeURIComponent(trip.reference)+'#book';primaryActions.append(again);
 }
 if(refund)card.append(node('p','trip-payment-review',refund==='confirmed'?'This trip is cancelled. Your full refund has been confirmed.':refund==='processing'?'This trip is cancelled. Your full refund is processing; it has not been confirmed yet. You do not need to pay again.':'This trip is cancelled. Your refund requires review. Please contact ER Limousine Service; no refund has been confirmed.'));
 else if(trip.status==='cancelled'&&trip.paymentStatus==='paid')card.append(node('p','trip-payment-review','Payment received for this cancelled trip. Please contact ER Limousine Service for payment review.'));
 if(processing&&trip.status!=='cancelled')card.append(node('p','trip-payment-review','We’re confirming your payment. You do not need to pay again.'));
 if(canCompletePayment(trip)){
  const pay=node('button','primary trip-payment','Complete Payment');pay.type='button';
  pay.addEventListener('click',async()=>{
   if(pay.disabled)return;const generation=accountGeneration,tripGeneration=tripsGeneration;pay.disabled=true;
   try{const result=await api('trips/'+encodeURIComponent(trip.reference)+'/payment',{});if(generation!==accountGeneration||tripGeneration!==tripsGeneration)return;location.assign(result.url);}
   catch(error){if(generation!==accountGeneration||tripGeneration!==tripsGeneration)return;if(error.status===401){accountGeneration++;clearPrivateAccount();show('login');return;}if(error.status===409){await loadTrips(false);return;}el('tripsStatus').textContent='Unable to start payment. Please refresh your trips and try again.';}
   finally{if(generation===accountGeneration&&tripGeneration===tripsGeneration)pay.disabled=false;}
  });primaryActions.append(pay);
 }
 card.append(primaryActions);
 return card;
}
function canCompletePayment(trip){
 return trip.paymentStatus!=='paid' && trip.status!=='cancelled' && trip.paymentVerificationPending!==true;
}
function tripManagement(trip,node,reservationLink){
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
  if(typeof BookingDateControls!=='undefined')BookingDateControls.mount(form);
  open.addEventListener('click',()=>{if(!current()||pending)return;form.hidden=!form.hidden;open.setAttribute('aria-expanded',String(!form.hidden));if(!form.hidden){if(typeof BookingDateControls!=='undefined')BookingDateControls.focus(date);else date.focus();}});open.setAttribute('aria-expanded','false');open.setAttribute('aria-controls',prefix+'-form');form.id=prefix+'-form';
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
 actions.append(reservationLink);
 section.append(actions,message);
 return section;
}
function selectTripsView(view){
 tripsView=view;
 for(const [key,id] of Object.entries(tripTabs))el(id).setAttribute('aria-pressed',String(view===key));
 const filter=tripViews[view];
 el('tripsFilter').hidden=!filter.title;
 el('tripsFilterTitle').textContent=filter.title||'';
 el('tripsFilterDescription').textContent=filter.description||'';
 return loadTrips(false);
}
async function loadTrips(more){
 if(!el('tripsPanel')||el('dashboardView').hidden||more&&tripsLoading)return;
 const view=tripsView;
 if(!more){
  clearTrips();
  // Reuse the server's two schedule feeds, including their independent cursors.
  const sources=view==='upcoming'||view==='past'?[view]:['upcoming','past'];
  tripsPages=sources.map(source=>({source,cursor:null,done:false}));
 }
 const pages=tripsPages.filter(page=>!page.done);
 if(!pages.length)return;
 const generation=tripsGeneration,account=accountGeneration;
 const current=()=>account===accountGeneration&&generation===tripsGeneration&&!el('dashboardView').hidden;
 const list=el('tripsList');
 tripsLoading=true;
 list.setAttribute('data-view',view);
 list.setAttribute('aria-busy','true');
 el('tripsStatus').textContent='Loading trips…';el('tripsMore').disabled=true;el('tripsRetry').hidden=true;el('tripsBook').hidden=true;
 try{
  const results=await Promise.all(pages.map(page=>api('trips?view='+page.source+'&limit=20'+
   (page.cursor?'&cursor='+encodeURIComponent(page.cursor):''))));
  if(!current())return;
  results.forEach((result,index)=>{
   const page=pages[index];
   page.cursor=result.nextCursor;
   page.done=!page.cursor;
   for(const trip of result.trips){
    const matches=view==='cancelled'?trip.status==='cancelled':
     view==='payment'?canCompletePayment(trip):view==='requests'||trip.status!=='cancelled';
    if(!matches||tripReferences.has(trip.reference))continue;
    list.append(tripCard(trip,view));
    tripReferences.add(trip.reference);
   }
  });
  const hasMore=tripsPages.some(page=>!page.done),empty=list.childElementCount===0;
  el('tripsMore').hidden=!hasMore;
  el('tripsStatus').textContent=empty?(hasMore?'No matching trips on these pages. Load more to continue.':
   tripViews[view].empty+' Only rides booked while signed into this account appear here.'):'';
  el('tripsBook').hidden=!empty||hasMore||view!=='upcoming';
  return generation;
 }catch(error){
  if(!current())return;
  if(error.status===401){accountGeneration++;clearPrivateAccount();show('login');return;}
  retryMore=more;
  el('tripsMore').hidden=true;el('tripsStatus').textContent=error.message;el('tripsRetry').hidden=false;
 }finally{
  if(current()){
   tripsLoading=false;
   list.setAttribute('aria-busy','false');
   el('tripsMore').disabled=false;
  }
 }
}
if(el('tripsPanel')){
 for(const [view,id] of Object.entries(tripTabs))el(id).addEventListener('click',()=>selectTripsView(view));
 for(const [id,view] of Object.entries({menuDashboard:'upcoming',menuUpcoming:'upcoming',menuPast:'past',menuCancelled:'cancelled',menuRequests:'requests',menuPayment:'payment'})){
  el(id).addEventListener('click',()=>{
   closeAccountMenu();
   selectTripsView(view);
   el(id==='menuDashboard'?'dashboardHeading':'tripsHeading').focus();
  });
 }
 el('tripsMore').addEventListener('click',()=>loadTrips(true));
 el('tripsRetry').addEventListener('click',()=>loadTrips(retryMore));
 window.addEventListener('pagehide',()=>{accountGeneration++;clearPrivateAccount();});
}
