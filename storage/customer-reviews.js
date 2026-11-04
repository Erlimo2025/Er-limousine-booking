'use strict';
const crypto=require('node:crypto');
const {LEASE,RETRY_WINDOW}=require('./booking-emails');
const {fail,invalidLink,displayName,reviewPage,publicReviewPage,PUBLIC_REVIEW_SCAN_LIMIT,uuid,requirePublicationPrivacy}=require('../services/customer-reviews');
const authorized=auth=>{if(!auth || !uuid.test(auth.actorId) || typeof auth.authorized!=='function' || !auth.authorized())throw fail(401,'Authentication required.');};
async function enqueueReviewInvitation(client,record,auth,now){
 authorized(auth);
 if(record.status!=='completed' || typeof record.customer.email!=='string' || record.customer.email.length>200 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(record.customer.email))return;
 const at=new Date(now);
 await client.query('INSERT INTO er_review_invitations(id,booking_id,completed_by,completed_at,recipient,next_attempt_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$4,$4,$4) ON CONFLICT(booking_id) DO NOTHING',[crypto.randomUUID(),record.id,auth.actorId,at,record.customer.email]);
 authorized(auth);
}
function customerReviewStorage(pool,transaction,safe){
 const clear='claim_token=NULL,lease_until=NULL';
 return {
  claimReviewInvitation:now=>transaction(async client=>{
   const at=new Date(now),row=(await client.query("SELECT i.*,r.record->>'status' AS booking_status FROM er_review_invitations i JOIN er_reservations r ON r.id=i.booking_id WHERE (i.state='pending' AND i.next_attempt_at<=$1) OR (i.state='sending' AND i.lease_until<=$1) ORDER BY i.next_attempt_at,i.id LIMIT 1 FOR UPDATE OF i SKIP LOCKED",[at])).rows[0];if(!row)return null;
   const review=row.first_submitted_at && now-new Date(row.first_submitted_at).getTime()>=RETRY_WINDOW;
   if(review || row.booking_status!=='completed' || row.used_at || row.expires_at && new Date(row.expires_at).getTime()<=now){
    await client.query('UPDATE er_review_invitations SET state=$2,'+clear+',updated_at=$3 WHERE id=$1',[row.id,review?'review_required':'inactive',at]);return {reviewRequired:!!review,skip:true};
   }
   return (await client.query("UPDATE er_review_invitations SET state='sending',claim_token=$2,lease_until=$3,attempts=attempts+1,updated_at=$4 WHERE id=$1 RETURNING *",[row.id,crypto.randomUUID(),new Date(now+LEASE),at])).rows[0];
  }),
  retireReviewInvitation:(id,claim,now)=>safe(()=>pool.query("UPDATE er_review_invitations SET state='review_required',"+clear+',updated_at=$3 WHERE id=$1 AND claim_token=$2',[id,claim,new Date(now)])),
  prepareReviewInvitation:(id,claim,digest,now,ttl)=>transaction(async client=>{
   const row=(await client.query("SELECT i.*,r.record->>'status' AS booking_status FROM er_review_invitations i JOIN er_reservations r ON r.id=i.booking_id WHERE i.id=$1 FOR UPDATE OF i",[id])).rows[0];
   if(!row || row.state!=='sending' || row.claim_token!==claim || new Date(row.lease_until).getTime()<=now || row.first_submitted_at && now-new Date(row.first_submitted_at).getTime()>=RETRY_WINDOW)return null;
   if(row.booking_status!=='completed' || row.used_at || row.token_hash && row.token_hash!==digest){await client.query("UPDATE er_review_invitations SET state='inactive',"+clear+',updated_at=$2 WHERE id=$1',[id,new Date(now)]);return null;}
   return (await client.query('UPDATE er_review_invitations SET token_hash=COALESCE(token_hash,$3),expires_at=COALESCE(expires_at,$4),first_submitted_at=COALESCE(first_submitted_at,$5),updated_at=$5 WHERE id=$1 AND claim_token=$2 RETURNING *',[id,claim,digest,new Date(now+ttl),new Date(now)])).rows[0];
  }),
  finishReviewInvitation:(id,claim,success,now)=>safe(()=>pool.query("UPDATE er_review_invitations SET state=CASE WHEN $3 THEN 'sent' ELSE 'pending' END,sent_at=CASE WHEN $3 THEN $4 ELSE sent_at END,next_attempt_at=$4+make_interval(secs=>LEAST(3600,30*power(2,LEAST(attempts-1,7)))::int),"+clear+',updated_at=$4 WHERE id=$1 AND claim_token=$2 AND state=\'sending\'',[id,claim,success,new Date(now)])),
  reviewInvitation:async(digest,now)=>safe(async()=>!!(await pool.query("SELECT 1 FROM er_review_invitations i JOIN er_reservations r ON r.id=i.booking_id WHERE i.token_hash=$1 AND i.expires_at>$2 AND r.record->>'status'='completed'",[digest,new Date(now)])).rowCount),
  submitCustomerReview:input=>transaction(async client=>{
   const initial=(await client.query('SELECT booking_id FROM er_review_invitations WHERE token_hash=$1',[input.tokenHash])).rows[0];if(!initial)throw invalidLink();
   // Reservation before invitation: the same order as authoritative completion.
   const booking=(await client.query('SELECT record FROM er_reservations WHERE id=$1 FOR UPDATE',[initial.booking_id])).rows[0]?.record;
   const row=(await client.query('SELECT * FROM er_review_invitations WHERE token_hash=$1 FOR UPDATE',[input.tokenHash])).rows[0];
   if(!row || new Date(row.expires_at).getTime()<=input.now || booking?.status!=='completed')throw invalidLink();
   if(row.used_at)return {accepted:true};
   const at=new Date(input.now),name=(String(booking.customer.firstName || '')+' '+String(booking.customer.lastName || '')).trim().slice(0,161);
   await client.query("INSERT INTO er_customer_reviews(id,invitation_id,booking_id,customer_name,display_name,rating,comment,status,submitted_at) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8)",[crypto.randomUUID(),row.id,row.booking_id,name,displayName(booking.customer),input.rating,input.comment,at]);
   await client.query('UPDATE er_review_invitations SET used_at=$2,updated_at=$2 WHERE id=$1',[row.id,at]);return {accepted:true};
  }),
  listCustomerReviews:(q,auth)=>safe(async()=>{
   if(!q.publicView)authorized(auth);
   const field=q.publicView?'v.published_at':'v.submitted_at',values=[q.status,new Date(q.at),q.publicView?PUBLIC_REVIEW_SCAN_LIMIT+1:q.limit+1];
   let cursor='';if(q.cursor){values.push(new Date(q.cursor.time),q.cursor.id);cursor=' AND ('+field+',v.id)<($4,$5::uuid)';}
   const fields=q.publicView?'v.id,v.rating,v.comment,v.display_name,v.published_at':'v.id,v.customer_name,v.rating,v.comment,v.booking_id,v.submitted_at,v.status,v.version';
   const query='SELECT '+fields+' FROM er_customer_reviews v JOIN er_review_invitations i ON i.id=v.invitation_id JOIN er_reservations r ON r.id=v.booking_id WHERE v.status=$1 AND '+field+'<=$2'+(q.publicView?" AND r.record->>'status'='completed'":'')+cursor+' ORDER BY '+field+' DESC,v.id DESC LIMIT $3';
   const rows=(await pool.query(query,values)).rows;
   if(!q.publicView)authorized(auth);return q.publicView?publicReviewPage(rows,q):reviewPage(rows,q);
  }),
  moderateCustomerReview:(auth,id,input,now)=>transaction(async client=>{
   authorized(auth);
   const row=(await client.query("SELECT v.*,r.record->>'status' AS booking_status FROM er_customer_reviews v JOIN er_reservations r ON r.id=v.booking_id WHERE v.id=$1 FOR UPDATE OF v",[id])).rows[0];if(!row)throw fail(404,'Review not found.');
   if(input.action==='publish')requirePublicationPrivacy(row.comment);
   const prior=(await client.query('SELECT * FROM er_review_moderation_events WHERE review_id=$1 AND request_id=$2',[id,input.requestId])).rows[0];
   if(prior){if(prior.actor_id!==auth.actorId || prior.action!==input.action || prior.reason!==input.reason || prior.expected_version!==input.version)throw fail(409,'Moderation request conflicts with an earlier action.');authorized(auth);return {status:row.status,version:row.version};}
   if(row.version!==input.version || row.status==='published' && !input.confirmed)throw fail(409,'This review changed. Refresh before moderating it.');
   if(input.action==='publish' && row.booking_status!=='completed')throw fail(409,'Only feedback for an eligible completed trip can be published.');
   if(input.action==='remove' && row.status==='pending')throw fail(409,'This review is not public.');
   const status=input.action==='publish'?'published':'held',at=new Date(now);
   await client.query('INSERT INTO er_review_moderation_events(id,review_id,request_id,actor_id,action,reason,from_status,to_status,expected_version,version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[crypto.randomUUID(),id,input.requestId,auth.actorId,input.action,input.reason,row.status,status,row.version,row.version+1,at]);
   await client.query("UPDATE er_customer_reviews SET status=$2,version=version+1,published_at=CASE WHEN $2='published' THEN $3::timestamptz ELSE NULL END,first_published_at=CASE WHEN $2='published' THEN COALESCE(first_published_at,$3::timestamptz) ELSE first_published_at END WHERE id=$1",[id,status,at]);
   authorized(auth);return {status,version:row.version+1};
  }),
  customerReviewHistory:(auth,id)=>safe(async()=>{authorized(auth);const rows=(await pool.query('SELECT id,request_id,actor_id,action,reason,from_status,to_status,version,created_at FROM er_review_moderation_events WHERE review_id=$1 ORDER BY version LIMIT 100',[id])).rows;authorized(auth);return rows;})
 };
}
module.exports={customerReviewStorage,enqueueReviewInvitation};
