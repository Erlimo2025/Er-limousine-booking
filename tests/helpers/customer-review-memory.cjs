// Test-only durable-state model. Production always uses PostgreSQL.
const crypto=require('node:crypto');
const {fail,invalidLink,displayName,reviewPage,publicReviewPage,PUBLIC_REVIEW_SCAN_LIMIT,requirePublicationPrivacy}=require('../../services/customer-reviews');
const clone=x=>JSON.parse(JSON.stringify(x));
function customerReviewMemory(shared,storageFail,atomic){
 shared.reviewInvitations ||=new Map();shared.customerReviews ||=new Map();shared.reviewModeration ||=new Map();
 const invitations=shared.reviewInvitations,reviews=shared.customerReviews,events=shared.reviewModeration;
 const auth=a=>{if(!a?.authorized?.())throw fail(401,'Authentication required.');};
 const eligible=row=>shared.records.find(r=>r.id===row.booking_id)?.status==='completed';
 const clear=row=>Object.assign(row,{claim_token:null,lease_until:null});
 const enqueue=(record,a,now)=>{
  auth(a);if(record.status!=='completed' || [...invitations.values()].some(i=>i.booking_id===record.id))return;
  const at=new Date(now).toISOString(),row={id:crypto.randomUUID(),booking_id:record.id,completed_by:a.actorId,completed_at:at,recipient:record.customer.email,token_hash:null,expires_at:null,used_at:null,state:'pending',attempts:0,claim_token:null,lease_until:null,first_submitted_at:null,next_attempt_at:at,created_at:at,updated_at:at,sent_at:null};auth(a);invitations.set(row.id,row);
 };
 return {enqueue,methods:{
  claimReviewInvitation:now=>atomic(async()=>{
   storageFail('reviewClaim');const row=[...invitations.values()].filter(i=>i.state==='pending'&&Date.parse(i.next_attempt_at)<=now || i.state==='sending'&&Date.parse(i.lease_until)<=now).sort((a,b)=>a.next_attempt_at.localeCompare(b.next_attempt_at)||a.id.localeCompare(b.id))[0];if(!row)return null;
   const review=!!row.first_submitted_at && now-Date.parse(row.first_submitted_at)>=23*3600000;
   if(review || !eligible(row) || row.used_at || row.expires_at && Date.parse(row.expires_at)<=now){clear(row);row.state=review?'review_required':'inactive';return {reviewRequired:review,skip:true};}
   Object.assign(row,{state:'sending',claim_token:crypto.randomUUID(),lease_until:new Date(now+60000).toISOString(),attempts:row.attempts+1});return clone(row);
  }),
  retireReviewInvitation:(id,claim)=>atomic(async()=>{const row=invitations.get(id);if(row?.claim_token===claim){clear(row);row.state='review_required';}}),
  prepareReviewInvitation:(id,claim,digest,now,ttl)=>atomic(async()=>{
   storageFail('reviewPrepare');const row=invitations.get(id);if(!row || row.state!=='sending' || row.claim_token!==claim || Date.parse(row.lease_until)<=now || row.first_submitted_at && now-Date.parse(row.first_submitted_at)>=23*3600000)return null;
   if(!eligible(row) || row.used_at || row.token_hash && row.token_hash!==digest){clear(row);row.state='inactive';return null;}
   row.token_hash ||=digest;row.expires_at ||=new Date(now+ttl).toISOString();row.first_submitted_at ||=new Date(now).toISOString();return clone(row);
  }),
  finishReviewInvitation:(id,claim,success,now)=>atomic(async()=>{
   storageFail('reviewFinish');const row=invitations.get(id);if(!row || row.state!=='sending' || row.claim_token!==claim)return;
   clear(row);Object.assign(row,{state:success?'sent':'pending',sent_at:success?new Date(now).toISOString():row.sent_at,next_attempt_at:new Date(now+Math.min(3600000,30000*2**Math.min(row.attempts-1,7))).toISOString()});
  }),
  reviewInvitation:async(digest,now)=>[...invitations.values()].some(i=>i.token_hash===digest && Date.parse(i.expires_at)>now && eligible(i)),
  submitCustomerReview:input=>atomic(async()=>{
   storageFail('write');const row=[...invitations.values()].find(i=>i.token_hash===input.tokenHash);if(!row || Date.parse(row.expires_at)<=input.now || !eligible(row))throw invalidLink();if(row.used_at)return {accepted:true};
   const record=shared.records.find(r=>r.id===row.booking_id),review={id:crypto.randomUUID(),invitation_id:row.id,booking_id:row.booking_id,customer_name:(record.customer.firstName+' '+record.customer.lastName).slice(0,161),display_name:displayName(record.customer),rating:input.rating,comment:input.comment,status:'pending',version:0,submitted_at:new Date(input.now).toISOString(),published_at:null,first_published_at:null};reviews.set(review.id,review);row.used_at=review.submitted_at;return {accepted:true};
  }),
  listCustomerReviews:async(q,a)=>{
   if(!q.publicView)auth(a);const field=q.publicView?'published_at':'submitted_at';
   const rows=[...reviews.values()].filter(r=>r.status===q.status && r[field]<=q.at && (!q.publicView || eligible(invitations.get(r.invitation_id))) && (!q.cursor || r[field]<q.cursor.time || r[field]===q.cursor.time && r.id<q.cursor.id)).sort((a,b)=>b[field].localeCompare(a[field])||b.id.localeCompare(a.id));
   if(!q.publicView)auth(a);return q.publicView?publicReviewPage(rows.slice(0,PUBLIC_REVIEW_SCAN_LIMIT+1),q):reviewPage(rows,q);
  },
  moderateCustomerReview:(a,id,input,now)=>atomic(async()=>{
   auth(a);const row=reviews.get(id);if(!row)throw fail(404,'Review not found.');if(input.action==='publish')requirePublicationPrivacy(row.comment);const prior=[...events.values()].find(e=>e.review_id===id && e.request_id===input.requestId);
   if(prior){if(prior.actor_id!==a.actorId || prior.action!==input.action || prior.reason!==input.reason || prior.expected_version!==input.version)throw fail(409);auth(a);return {status:row.status,version:row.version};}
   if(row.version!==input.version || row.status==='published'&&!input.confirmed)throw fail(409,'This review changed. Refresh before moderating it.');
   if(input.action==='publish' && !eligible(invitations.get(row.invitation_id)))throw fail(409);
   if(input.action==='remove' && row.status==='pending')throw fail(409);
   const at=new Date(now).toISOString(),next=input.action==='publish'?'published':'held',event={id:crypto.randomUUID(),review_id:id,request_id:input.requestId,actor_id:a.actorId,action:input.action,reason:input.reason,from_status:row.status,to_status:next,expected_version:row.version,version:row.version+1,created_at:at};
   auth(a);storageFail('write');events.set(event.id,event);Object.assign(row,{status:next,version:row.version+1,published_at:next==='published'?at:null,first_published_at:row.first_published_at || (next==='published'?at:null)});return {status:row.status,version:row.version};
  }),
  customerReviewHistory:async(a,id)=>{auth(a);return clone([...events.values()].filter(e=>e.review_id===id).sort((a,b)=>a.version-b.version).slice(0,100));}
 }};
}
module.exports={customerReviewMemory};
