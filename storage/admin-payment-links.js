const crypto=require('node:crypto');
const {eligible}=require('../services/admin-payment-links');
const {RETRY_WINDOW,LEASE}=require('./booking-emails');
const unavailable=status=>Object.assign(new Error(status===401?'Authentication required.':'Payment link unavailable. Refresh and try again.'),{status});
function adminPaymentLinkStorage(pool,transaction,safe,validate,assertActionLock){
 const active=(row,record,now)=>eligible(record) && record.stripeSessionId===row.stripe_session_id && record.checkoutAttempt?.state!=='confirmed_unpaid' && new Date(row.expires_at).getTime()>now;
 const clear="payload=NULL,claim_token=NULL,lease_until=NULL";
 return {
  recordAdminPaymentLink:(auth,id,action,sessionId,expiresAt,message,now)=>transaction(async client=>{
   if(!auth.authorized())throw unavailable(401);
   const booking=(await client.query('SELECT record FROM er_reservations WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!booking)throw unavailable(404);
   const record=validate(booking.record);assertActionLock(record.checkoutFingerprint || 'reservation:'+id);
   if(!active({stripe_session_id:sessionId,expires_at:expiresAt},record,now))throw unavailable(409);
   const at=new Date(now);
   const row=(await client.query("INSERT INTO er_admin_payment_links(id,booking_id,stripe_session_id,expires_at,created_by,created_at,next_attempt_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6,$6) ON CONFLICT (booking_id,stripe_session_id) DO UPDATE SET updated_at=er_admin_payment_links.updated_at RETURNING *",[crypto.randomUUID(),id,sessionId,new Date(expiresAt),auth.actorId,at])).rows[0];
   if(action==='copy')await client.query('UPDATE er_admin_payment_links SET copied_at=$2,copied_by=$3,updated_at=$2 WHERE id=$1',[row.id,at,auth.actorId]);
   else if(row.state==='not_requested'){
    if(!message)throw unavailable(409);
    await client.query("UPDATE er_admin_payment_links SET state='pending',payload=$2::jsonb,email_requested_at=$3,email_requested_by=$4,next_attempt_at=$3,updated_at=$3 WHERE id=$1",[row.id,JSON.stringify(message),at,auth.actorId]);row.state='pending';
   }
   if(!auth.authorized())throw unavailable(401);return {state:row.state};
  }),
  claimAdminPaymentLinkEmail:now=>transaction(async client=>{
   const at=new Date(now),row=(await client.query("SELECT l.*,r.record FROM er_admin_payment_links l JOIN er_reservations r ON r.id=l.booking_id WHERE (l.state='pending' AND l.next_attempt_at<=$1) OR (l.state='sending' AND l.lease_until<=$1) ORDER BY l.next_attempt_at,l.id LIMIT 1 FOR UPDATE OF l SKIP LOCKED",[at])).rows[0];if(!row)return null;
   const review=row.first_submitted_at && now-new Date(row.first_submitted_at).getTime()>=RETRY_WINDOW;
   if(review || !active(row,validate(row.record),now)){
    await client.query("UPDATE er_admin_payment_links SET state=$2,"+clear+',updated_at=$3 WHERE id=$1',[row.id,review?'review_required':'inactive',at]);return review?{reviewRequired:true}:null;
   }
   return (await client.query("UPDATE er_admin_payment_links SET state='sending',claim_token=$2,lease_until=$3,attempts=attempts+1,updated_at=$4 WHERE id=$1 RETURNING *, 'admin_payment_link' AS kind",[row.id,crypto.randomUUID(),new Date(now+LEASE),at])).rows[0];
  }),
  prepareAdminPaymentLinkEmail:(id,token,payload,now)=>transaction(async client=>{
   const row=(await client.query('SELECT l.*,r.record FROM er_admin_payment_links l JOIN er_reservations r ON r.id=l.booking_id WHERE l.id=$1 FOR UPDATE OF l',[id])).rows[0];
   if(!row || row.claim_token!==token || row.state!=='sending' || new Date(row.lease_until).getTime()<=now)return null;
   if(!active(row,validate(row.record),now)){await client.query("UPDATE er_admin_payment_links SET state='inactive',"+clear+',updated_at=$2 WHERE id=$1',[id,new Date(now)]);return null;}
   return (await client.query("UPDATE er_admin_payment_links SET first_submitted_at=COALESCE(first_submitted_at,$3),updated_at=$3 WHERE id=$1 AND claim_token=$2 AND (first_submitted_at IS NULL OR first_submitted_at>$4) RETURNING *",[id,token,new Date(now),new Date(now-RETRY_WINDOW)])).rows[0] || null;
  }),
  finishAdminPaymentLinkEmail:(id,token,success,now)=>safe(async()=>{
   await pool.query("UPDATE er_admin_payment_links SET state=CASE WHEN $3 THEN 'sent' ELSE 'pending' END,payload=CASE WHEN $3 THEN NULL ELSE payload END,sent_at=CASE WHEN $3 THEN $4 ELSE sent_at END,next_attempt_at=$4+make_interval(secs=>LEAST(3600,30*power(2,LEAST(attempts-1,7)))::int),claim_token=NULL,lease_until=NULL,updated_at=$4 WHERE id=$1 AND claim_token=$2 AND state='sending'",[id,token,success,new Date(now)]);
  })
 };
}
module.exports={adminPaymentLinkStorage};
