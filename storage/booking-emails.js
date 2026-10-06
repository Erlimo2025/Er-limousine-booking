const crypto=require('node:crypto');
const RETRY_WINDOW=23*3600000,LEASE=60000;
async function enqueueBookingEmail(client,record,kind){
 const at=new Date(['payment_confirmed','admin_payment_confirmed'].includes(kind)?record.paidAt:record.createdAt);
 await client.query('INSERT INTO er_booking_email_outbox(id,booking_id,kind,next_attempt_at,created_at,updated_at) VALUES($1,$2,$3,$4,$4,$4) ON CONFLICT(booking_id,kind) DO NOTHING',[crypto.randomUUID(),record.id,kind,at]);
}
function bookingEmailStorage(pool,transaction,safe){
 return {
  claimBookingEmail:now=>transaction(async client=>{
   const at=new Date(now),r=(await client.query("SELECT * FROM er_booking_email_outbox WHERE (state='pending' AND next_attempt_at<=$1) OR (state='sending' AND lease_until<=$1) ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",[at])).rows[0];
   if(!r)return null;
   if(r.first_submitted_at && now-new Date(r.first_submitted_at).getTime()>=RETRY_WINDOW){
    await client.query("UPDATE er_booking_email_outbox SET state='review_required',payload=NULL,claim_token=NULL,lease_until=NULL,updated_at=$2 WHERE id=$1",[r.id,at]);return {reviewRequired:true};
   }
   return (await client.query("UPDATE er_booking_email_outbox SET state='sending',claim_token=$2,lease_until=$3,attempts=attempts+1,updated_at=$4 WHERE id=$1 RETURNING *",[r.id,crypto.randomUUID(),new Date(now+LEASE),at])).rows[0];
  }),
  prepareBookingEmail:(id,token,payload,now)=>safe(async()=>{
   // Freeze the exact safe message before network submission; retries cannot change it.
   return (await pool.query("UPDATE er_booking_email_outbox SET payload=COALESCE(payload,$3::jsonb),first_submitted_at=COALESCE(first_submitted_at,$4),updated_at=$4 WHERE id=$1 AND claim_token=$2 AND state='sending' AND lease_until>$4 AND (first_submitted_at IS NULL OR first_submitted_at>$5) RETURNING *",[id,token,JSON.stringify(payload),new Date(now),new Date(now-RETRY_WINDOW)])).rows[0] || null;
  }),
  finishBookingEmail:(id,token,success,now)=>safe(async()=>{
   await pool.query("UPDATE er_booking_email_outbox SET state=CASE WHEN $3 THEN 'sent' ELSE 'pending' END,payload=CASE WHEN $3 THEN NULL ELSE payload END,sent_at=CASE WHEN $3 THEN $4 ELSE sent_at END,next_attempt_at=$4+make_interval(secs=>LEAST(3600,30*power(2,LEAST(attempts-1,7)))::int),claim_token=NULL,lease_until=NULL,updated_at=$4 WHERE id=$1 AND claim_token=$2 AND state='sending'",[id,token,success,new Date(now)]);
  })
 };
}
module.exports={enqueueBookingEmail,bookingEmailStorage,RETRY_WINDOW,LEASE};
