'use strict';

(()=>{
  let token=/^#(?:token|verify-profile)=([A-Za-z0-9_-]{43})$/.exec(location.hash)?.[1]||null;
  const profileLink=location.hash.startsWith('#verify-profile=');

  // Keep the link token out of the request URL and remove it before rendering.
  if(location.hash)history.replaceState(null,'',location.pathname);

  document.addEventListener('DOMContentLoaded',()=>{
    const el=id=>document.getElementById(id);
    const form=el('emailVerificationForm');
    const status=el('emailVerificationStatus');
    const intro=el('emailVerificationIntro');
    const button=el('emailVerificationSubmit');
    const password=el('emailVerificationPassword');
    const passwordRow=el('emailVerificationPasswordRow');
    const restart=el('emailVerificationRestart');
    const path=profileLink?'email-verification/confirm':'enrollment/confirm';
    function showInvalid(){
      token=null;
      password.value='';
      form.hidden=true;
      if(profileLink){
        status.textContent='This verification link is unavailable. Sign in to the account that requested it and request a fresh link.';
        restart.href='/account.html';
        restart.textContent='Sign In';
      }else{
        status.textContent='This verification link is invalid, expired, or has already been used.';
      }
      intro.hidden=true;
      restart.hidden=false;
    }

    if(token)form.hidden=false;
    else showInvalid();

    window.addEventListener('pagehide',()=>{token=null;password.value='';});
    window.addEventListener('pageshow',event=>{if(event.persisted&&!token)showInvalid();});
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      if(button.disabled||!token)return;
      button.disabled=true;
      status.textContent='Verifying…';
      try{
        const payload=JSON.stringify({token,...(!password.disabled?{password:password.value}:{})});
        password.value='';
        const response=await fetch('/api/customer/'+path,{
          method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',
          cache:'no-store',body:payload
        });
        if(!token)return;
        if(response.ok){
          token=null;
          form.hidden=true;
          status.textContent='Email verified. Opening your account…';
          location.replace('/account/dashboard');
          return;
        }
        if(!profileLink&&response.status===400){
          const result=await response.json().catch(()=>null);
          if(!token)return;
          if(result?.code==='ENROLLMENT_PASSWORD_REQUIRED'){
            const passwordWasSubmitted=!password.disabled;
            intro.textContent='Enter the password you chose when creating your account to confirm this link in a different browser.';
            passwordRow.hidden=false;
            password.disabled=false;
            password.required=true;
            status.textContent=passwordWasSubmitted?'The password could not be verified. Please try again.':'';
            password.focus();
            return;
          }
        }
        if(response.status>=500||response.status===429){
          status.textContent='Email verification is temporarily unavailable. Please try again.';
          return;
        }
        showInvalid();
      }catch(_){
        if(token)status.textContent='Email verification is temporarily unavailable. Please try again.';
      }finally{button.disabled=false;}
    });
  });
})();
