const crypto=require('node:crypto'),clone=x=>JSON.parse(JSON.stringify(x));
const {eligible}=require('../../services/admin-payment-links');
function adminPaymentLinkMemory(shared,fail,atomic,actionScope){
 shared.adminPaymentLinks ||=new Map();
 const record=row=>shared.records.find(r=>r.id===row.booking_id),active=(row,now)=>eligible(record(row)) && record(row).stripeSessionId===row.stripe_session_id && record(row).checkoutAttempt?.state!=='confirmed_unpaid' && Date.parse(row.expires_at)>now;
 const clear=row=>Object.assign(row,{payload:null,claim_token:null,lease_until:null});
 return {
  recordAdminPaymentLink:(auth,id,action,sessionId,expiresAt,message,now)=>atomic(async()=>{
   fail('adminPaymentLinkWrite');if(!auth.authorized())throw Object.assign(Error('Authentication required.'),{status:401});
   const r=shared.records.find(r=>r.id===id);if(actionScope.getStore()!==(r.checkoutFingerprint || 'reservation:'+id))throw Object.assign(Error('Action unavailable.'),{status:409});
   const old=[...shared.adminPaymentLinks.values()].find(x=>x.booking_id===id&&x.stripe_session_id===sessionId),at=new Date(now).toISOString(),row=clone(old || {id:crypto.randomUUID(),booking_id:id,stripe_session_id:sessionId,expires_at:expiresAt,created_by:auth.actorId,created_at:at,updated_at:at,copied_at:null,copied_by:null,email_requested_at:null,email_requested_by:null,state:'not_requested',payload:null,attempts:0,claim_token:null,lease_until:null,first_submitted_at:null,next_attempt_at:at,sent_at:null});
   if(!active(row,now))throw Object.assign(Error('Payment link unavailable.'),{status:409});
   if(action==='copy')Object.assign(row,{copied_at:at,copied_by:auth.actorId,updated_at:at});
   else if(row.state==='not_requested')Object.assign(row,{state:'pending',payload:clone(message),email_requested_at:at,email_requested_by:auth.actorId,updated_at:at});
   if(!auth.authorized())throw Object.assign(Error('Authentication required.'),{status:401});shared.adminPaymentLinks.set(row.id,row);return {state:row.state};
  }),
  claimAdminPaymentLinkEmail:async now=>{
   fail('adminPaymentLinkClaim');const row=[...shared.adminPaymentLinks.values()].filter(x=>x.state==='pending'&&Date.parse(x.next_attempt_at)<=now || x.state==='sending'&&Date.parse(x.lease_until)<=now).sort((a,b)=>a.next_attempt_at.localeCompare(b.next_attempt_at)||a.id.localeCompare(b.id))[0];if(!row)return null;
   if(row.first_submitted_at&&now-Date.parse(row.first_submitted_at)>=23*3600000){clear(row);row.state='review_required';return {reviewRequired:true};}
   if(!active(row,now)){clear(row);row.state='inactive';return null;}
   Object.assign(row,{state:'sending',claim_token:crypto.randomUUID(),lease_until:new Date(now+60000).toISOString(),attempts:row.attempts+1});return {...clone(row),kind:'admin_payment_link'};
  },
  prepareAdminPaymentLinkEmail:async(id,token,payload,now)=>{
   fail('adminPaymentLinkPrepare');const row=shared.adminPaymentLinks.get(id);if(!row||row.claim_token!==token||row.state!=='sending'||Date.parse(row.lease_until)<=now)return null;
   if(!active(row,now)){clear(row);row.state='inactive';return null;}
   if(row.first_submitted_at&&now-Date.parse(row.first_submitted_at)>=23*3600000)return null;
   row.first_submitted_at ||=new Date(now).toISOString();return clone(row);
  },
  finishAdminPaymentLinkEmail:async(id,token,success,now)=>{
   fail('adminPaymentLinkFinish');const row=shared.adminPaymentLinks.get(id);if(!row||row.claim_token!==token||row.state!=='sending')return;
   Object.assign(row,{state:success?'sent':'pending',payload:success?null:row.payload,sent_at:success?new Date(now).toISOString():row.sent_at,claim_token:null,lease_until:null,next_attempt_at:new Date(now+Math.min(3600000,30000*2**Math.min(row.attempts-1,7))).toISOString()});
  }
 };
}
module.exports={adminPaymentLinkMemory};
