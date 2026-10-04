// Server-only adapter. Tests inject their own provider; no console/debug delivery exists.
function createEmailProvider({enabled=false,apiKey,from,siteUrl,production=false,fetchImpl=globalThis.fetch}={}) {
 if(!enabled)return {enabled:false};
 let origin;
 try {
  const url=new URL(siteUrl);
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||
    (production?url.protocol!=='https:':url.protocol!=='https:'&&!(local&&url.protocol==='http:')))throw new Error();
  origin=url.origin;
 }catch(_){throw new Error('Email recovery configuration unavailable.');}
 if(typeof apiKey!=='string'||!apiKey.trim()||typeof from!=='string'||
   !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@erlimousineservice\.com$/.test(from))throw new Error('Email recovery configuration unavailable.');
 return {enabled:true,sendResetLink:async({email,token,attemptId})=>{
  const url=new URL('/reset-password.html',origin);url.hash='token='+token;
  const link=url.toString();
  // Link has a fixed origin/path and a base64url token, not user-controlled HTML.
  try {
   const response=await fetchImpl('https://api.resend.com/emails',{
    method:'POST',signal:AbortSignal.timeout(8000),
    headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json','Idempotency-Key':'customer-recovery/'+attemptId},
    body:JSON.stringify({from:'ER Limousine Service <'+from+'>',to:[email],subject:'Reset your ER Limousine Service password',
     text:'A password reset was requested for your account. This link expires in 10 minutes and can be used once.\n\n'+link+'\n\nIf you did not request this, you can ignore this email.',
     html:'<p>A password reset was requested for your ER Limousine Service account.</p><p><a href="'+link+'">Reset Password</a></p><p>This link expires in 10 minutes and can be used once. If you did not request this, you can ignore this email.</p>'})
   });
   if(!response.ok)throw new Error();
   // Never read/log provider response bodies: no operational payload is needed here.
  }catch(_){throw new Error('Email delivery unavailable.');}
 }};
}
module.exports={createEmailProvider};
