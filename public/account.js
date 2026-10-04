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
 const labels={awaiting_payment:'Awaiting payment',confirmed:'Confirmed',assigned:'Assigned',driver_en_route:'Driver en route',passenger_on_board:'Passenger on board',completed:'Completed',cancelled:'Cancelled',unpaid:'Unpaid',paid:'Paid',failed:'Failed'};
 const badges=node('div','trip-badges');badges.append(node('span','trip-badge',labels[trip.status]||trip.status),node('span','trip-badge',labels[trip.paymentStatus]||trip.paymentStatus));
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
 details.append(summary,list);card.append(details);return card;
}
async function loadTrips(more){
 if(!el('tripsPanel'))return;
 if(!more)clearTrips();
 const generation=++tripsGeneration,cursor=more?tripsCursor:null;
 el('tripsStatus').textContent='Loading trips…';el('tripsMore').disabled=true;el('tripsRetry').hidden=true;el('tripsBook').hidden=true;
 try{
  const result=await api('trips?view='+tripsView+'&limit=20'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
  if(generation!==tripsGeneration || el('dashboardView').hidden)return;
  for(const trip of result.trips)el('tripsList').append(tripCard(trip));
  tripsCursor=result.nextCursor;el('tripsMore').hidden=!tripsCursor;
  const empty=el('tripsList').childElementCount===0;
  el('tripsStatus').textContent=empty?'No '+tripsView+' trips. Only rides booked while signed into this account appear here.':'';
  el('tripsBook').hidden=!empty;
 }catch(error){
  if(generation!==tripsGeneration)return;
  if(error.status===401){clearPrivateAccount();show('login');return;}
  el('tripsStatus').textContent=error.message;el('tripsRetry').hidden=false;
 }finally{if(generation===tripsGeneration)el('tripsMore').disabled=false;}
}
if(el('tripsPanel')){
 for(const [id,view] of [['upcomingTrips','upcoming'],['pastTrips','past']])el(id).addEventListener('click',()=>{
  tripsView=view;el('upcomingTrips').setAttribute('aria-pressed',String(view==='upcoming'));el('pastTrips').setAttribute('aria-pressed',String(view==='past'));loadTrips(false);
 });
 el('tripsMore').addEventListener('click',()=>loadTrips(true));
 el('tripsRetry').addEventListener('click',()=>loadTrips(false));
 window.addEventListener('pagehide',()=>{accountGeneration++;clearPrivateAccount();});
}
