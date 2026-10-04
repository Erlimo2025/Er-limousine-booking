'use strict';
(()=>{
 // Fragment never enters the initial HTTP request. Remove it before rendering or other work.
 let token=/^#token=([A-Za-z0-9_-]{43})$/.exec(location.hash)?.[1] || null;
 history.replaceState(null,'',location.pathname);
 window.addEventListener('pagehide',()=>{token=null;});
 document.addEventListener('DOMContentLoaded',()=>{
  const el=id=>document.getElementById(id),form=el('emailResetForm'),button=el('exchangeLink');
  const invalid=()=>{button.hidden=true;form.hidden=true;el('resetIntro').textContent='This reset link is invalid, expired, or has already been used.';el('requestAnother').hidden=false;};
  if(!token)invalid();
  async function api(action,data){
   const response=await fetch('/api/customer/recovery/'+action,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify(data)});
   const result=await response.json();
   if(!response.ok)throw new Error(result.error || 'Service temporarily unavailable. Please request a new reset link.');
   return result;
  }
  button.addEventListener('click',async()=>{
   button.disabled=true;
   try{await api('exchange',{token});button.hidden=true;form.hidden=false;el('resetIntro').textContent='Choose a new password for your account.';}
   catch(_){invalid();}
   finally{token=null;}
  });
  form.addEventListener('submit',async event=>{
   event.preventDefault();const submit=form.querySelector('button[type=submit]');submit.disabled=true;el('resetMessage').textContent='';
   try{
    if(el('newPassword').value!==el('confirmPassword').value)throw new Error('Passwords must match.');
    const result=await api('reset',{password:el('newPassword').value,confirmPassword:el('confirmPassword').value});
    form.hidden=true;el('resetIntro').textContent=result.message;el('resetMessage').textContent='You can now log in with your new password.';
   }catch(error){el('resetMessage').textContent=error.message;el('requestAnother').hidden=false;}
   finally{el('newPassword').value='';el('confirmPassword').value='';submit.disabled=false;}
  });
 });
})();
