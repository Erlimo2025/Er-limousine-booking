'use strict';
const el=id=>document.getElementById(id);
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
}
async function api(path,data){
  const response=await fetch('/api/customer/'+path,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json'}:{},credentials:'same-origin',cache:'no-store',body:data?JSON.stringify(data):undefined});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error || 'Service temporarily unavailable. Please try again.');
  return result;
}
function authForm(id,path,values){
  el(id).addEventListener('submit',async event=>{
    event.preventDefault();
    const button=el(id).querySelector('button[type=submit]');button.disabled=true;el('message').textContent='';
    try{
      const result=await api(path,values());el(id).reset();dashboard(result.customer);history.replaceState(null,'','/account/dashboard');
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
  const buttons=[el('logout'),el('navLogout')];for(const button of buttons)button.disabled=true;
  try{
    await api('logout',{});
    el('profileName').textContent='';el('profileEmail').textContent='';el('profilePhone').textContent='';el('welcome').textContent='Welcome';
    history.replaceState(null,'','/account.html');show('login');
  }catch(error){el('message').textContent=error.message;}
  finally{for(const button of buttons)button.disabled=false;}
}
el('logout').addEventListener('click',logout);el('navLogout').addEventListener('click',logout);
async function load(){try{const result=await api('profile');dashboard(result.customer);}catch(_){show(location.hash==='#create'?'register':location.hash==='#recover'?'recovery':'login');}}
window.addEventListener('hashchange',()=>{
  // Profile navigation must not switch an authenticated dashboard to the login view.
  if(location.hash==='#profile' && !el('dashboardView').hidden)return;
  el('loginForm').reset();el('registerForm').reset();show(location.hash==='#create'?'register':location.hash==='#recover'?'recovery':'login');
});
window.addEventListener('pageshow',()=>load());

function recoveryStep(step){
  for(const name of ['Phone','Code','Password'])el('recovery'+name+'Step').hidden=name!==step;
  el('message').textContent='';
}
let recoveryResendAt=0;
function recoveryForm(id,action){
  const form=el(id);if(!form)return;
  form.addEventListener('submit',async event=>{
    event.preventDefault();const button=form.querySelector('button[type=submit]');button.disabled=true;el('message').textContent='';
    try{await action();}catch(error){el('message').textContent=error.message;}
    finally{button.disabled=false;}
  });
}
async function sendRecoveryCode(){
  const result=await api('recovery/request',{phone:el('recoveryPhone').value});
  el('recoveryNotice').textContent=result.message;el('recoveryCode').value='';
  recoveryResendAt=Date.now()+60000;el('resendRecoveryCode').disabled=true;recoveryStep('Code');
  setTimeout(()=>{if(Date.now()>=recoveryResendAt)el('resendRecoveryCode').disabled=false;},60000);
}
recoveryForm('recoveryPhoneForm',sendRecoveryCode);
recoveryForm('recoveryCodeForm',async()=>{
  try{await api('recovery/verify',{code:el('recoveryCode').value});recoveryStep('Password');}
  finally{el('recoveryCode').value='';}
});
recoveryForm('recoveryResetForm',async()=>{
  const password=el('newPassword').value,confirmation=el('confirmPassword').value;
  try{
    if(password!==confirmation)throw new Error('Passwords must match.');
    const result=await api('recovery/reset',{password,confirmPassword:confirmation});
    el('recoveryPhoneForm').reset();el('recoveryCodeForm').reset();recoveryStep('Phone');
    history.replaceState(null,'','/account.html');show('login');
    el('message').textContent=result.message;el('message').classList.add('success');
  }finally{el('newPassword').value='';el('confirmPassword').value='';hidePasswords();}
});
if(el('resendRecoveryCode'))el('resendRecoveryCode').addEventListener('click',async()=>{
  if(Date.now()<recoveryResendAt)return;
  el('resendRecoveryCode').disabled=true;
  try{await sendRecoveryCode();}catch(error){el('message').textContent=error.message;el('resendRecoveryCode').disabled=false;}
});
