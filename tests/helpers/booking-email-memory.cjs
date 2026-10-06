const crypto=require('node:crypto');
const clone=x=>JSON.parse(JSON.stringify(x));
function bookingEmailMemory(shared,fail){
 shared.bookingEmails ||=new Map();
 const enqueue=(r,kind)=>{
  const key=r.id+'|'+kind;if(shared.bookingEmails.has(key))return;
  const at=['payment_confirmed','admin_payment_confirmed'].includes(kind)?r.paidAt:r.createdAt;
  shared.bookingEmails.set(key,{id:crypto.randomUUID(),booking_id:r.id,kind,state:'pending',payload:null,attempts:0,claim_token:null,lease_until:null,first_submitted_at:null,next_attempt_at:at,created_at:at,updated_at:at,sent_at:null});
 };
 const find=id=>[...shared.bookingEmails.values()].find(x=>x.id===id);
 return {enqueue,methods:{
  claimBookingEmail:async now=>{
   fail('emailClaim');const r=[...shared.bookingEmails.values()].filter(x=>x.state==='pending'&&Date.parse(x.next_attempt_at)<=now || x.state==='sending'&&Date.parse(x.lease_until)<=now).sort((a,b)=>Date.parse(a.next_attempt_at)-Date.parse(b.next_attempt_at)||a.id.localeCompare(b.id))[0];
   if(!r)return null;
   if(r.first_submitted_at && now-Date.parse(r.first_submitted_at)>=23*3600000){Object.assign(r,{state:'review_required',payload:null,claim_token:null,lease_until:null});return {reviewRequired:true};}
   Object.assign(r,{state:'sending',claim_token:crypto.randomUUID(),lease_until:new Date(now+60000).toISOString(),attempts:r.attempts+1});return clone(r);
  },
  prepareBookingEmail:async(id,token,payload,now)=>{
   fail('emailPrepare');const r=find(id);if(!r||r.claim_token!==token||r.state!=='sending'||Date.parse(r.lease_until)<=now||r.first_submitted_at&&now-Date.parse(r.first_submitted_at)>=23*3600000)return null;
   r.payload ||=clone(payload);r.first_submitted_at ||=new Date(now).toISOString();return clone(r);
  },
  finishBookingEmail:async(id,token,success,now)=>{
   fail('emailFinish');const r=find(id);if(!r||r.claim_token!==token||r.state!=='sending')return;
   Object.assign(r,{state:success?'sent':'pending',payload:success?null:r.payload,sent_at:success?new Date(now).toISOString():r.sent_at,next_attempt_at:new Date(now+Math.min(3600000,30000*2**Math.min(r.attempts-1,7))).toISOString(),claim_token:null,lease_until:null});
  }
 }};
}
module.exports={bookingEmailMemory};
