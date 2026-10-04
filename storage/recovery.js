const crypto=require('node:crypto');
const equal=(a,b)=>typeof a==='string' && typeof b==='string' && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
function recoveryStorage(pool,transaction,safe) {
 async function limiter(client,scope,hash,now,limit) {
  await client.query('INSERT INTO er_customer_recovery_limits(scope,identity_hash,requests,reset_at) VALUES($1,$2,1,$4) ON CONFLICT(scope,identity_hash) DO UPDATE SET requests=CASE WHEN er_customer_recovery_limits.reset_at<=$3 THEN 1 ELSE er_customer_recovery_limits.requests+1 END, reset_at=CASE WHEN er_customer_recovery_limits.reset_at<=$3 THEN $4 ELSE er_customer_recovery_limits.reset_at END',[scope,hash,new Date(now),new Date(now+3600000)]);
  const r=(await client.query('SELECT requests,last_sent_at FROM er_customer_recovery_limits WHERE scope=$1 AND identity_hash=$2 FOR UPDATE',[scope,hash])).rows[0];
  return r.requests<=limit && (scope!=='phone' || !r.last_sent_at || new Date(r.last_sent_at).getTime()+60000<=now);
 }
 return {
  prepareRecovery:(record,normalizedPhone,clientHash,oldHash,now)=>transaction(async client=>{
   // All sends take client then phone locks; this order is identical across workers.
   const ipAllowed=await limiter(client,'client',clientHash,now,20);
   const allowed=await limiter(client,'phone',record.identity_hash,now,3);
   if(!ipAllowed || !allowed) {
    const old=oldHash && (await client.query('SELECT challenge_hash,expires_at FROM er_customer_recovery WHERE challenge_hash=$1 AND identity_hash=$2 AND expires_at>$3 AND consumed_at IS NULL',[oldHash,record.identity_hash,new Date(now)])).rows[0];
    return {retained:old || null};
   }
   await client.query("UPDATE er_customer_recovery_limits SET last_sent_at=$3 WHERE scope=$1 AND identity_hash=$2",['phone',record.identity_hash,new Date(now)]);
   const customer=(await client.query("SELECT id,normalized_phone FROM er_customers WHERE normalized_phone=$1 AND account_status='active' FOR UPDATE",[normalizedPhone])).rows[0];
   await client.query('INSERT INTO er_customer_recovery(challenge_hash,customer_id,identity_hash,code_verifier,created_at,expires_at,delivery_state) VALUES($1,$2,$3,$4,$5,$6,$7)',[record.challenge_hash,customer?.id || null,record.identity_hash,record.code_verifier,new Date(now),new Date(now+600000),customer?'pending':'sent']);
   return {prepared:true,phone:customer?.normalized_phone || null};
  }),
  finishRecoveryDelivery:(hash,success)=>safe(async()=>{await pool.query("UPDATE er_customer_recovery SET delivery_state=$2 WHERE challenge_hash=$1 AND delivery_state='pending'",[hash,success?'sent':'failed']);}),
  verifyRecovery:(hash,verifier,resetHash,now)=>transaction(async client=>{
   const r=(await client.query('SELECT * FROM er_customer_recovery WHERE challenge_hash=$1 FOR UPDATE',[hash])).rows[0];
   if(!r || r.consumed_at || r.verified_at || new Date(r.expires_at).getTime()<=now || r.failed_attempts>=5)return false;
   if(!equal(r.code_verifier,verifier) || !r.customer_id || r.delivery_state!=='sent') {
    await client.query('UPDATE er_customer_recovery SET failed_attempts=failed_attempts+1 WHERE challenge_hash=$1',[hash]);return false;
   }
   await client.query('UPDATE er_customer_recovery SET verified_at=$2,reset_hash=$3 WHERE challenge_hash=$1',[hash,new Date(now),resetHash]);return {expiresAt:r.expires_at};
  }),
  recoveryGrant: (hash,now)=>safe(async()=> (await pool.query('SELECT 1 FROM er_customer_recovery WHERE reset_hash=$1 AND verified_at IS NOT NULL AND consumed_at IS NULL AND expires_at>$2',[hash,new Date(now)])).rowCount===1),
  resetCustomerPassword:(resetHash,passwordHash,now)=>transaction(async client=>{
   // Locate identity without locking, then lock the customer before challenges.
   // Login session creation takes the same customer lock, preventing stale-password login races.
   const found=(await client.query('SELECT customer_id FROM er_customer_recovery WHERE reset_hash=$1',[resetHash])).rows[0];
   if(!found?.customer_id)return false;
   const customer=(await client.query("SELECT id FROM er_customers WHERE id=$1 AND account_status='active' FOR UPDATE",[found.customer_id])).rows[0];if(!customer)return false;
   const r=(await client.query('SELECT * FROM er_customer_recovery WHERE reset_hash=$1 FOR UPDATE',[resetHash])).rows[0];
   if(!r || r.customer_id!==customer.id || !r.verified_at || r.consumed_at || new Date(r.expires_at).getTime()<=now)return false;
   await client.query('UPDATE er_customers SET password_hash=$2,updated_at=$3 WHERE id=$1',[customer.id,passwordHash,new Date(now)]);
   await client.query('DELETE FROM er_customer_sessions WHERE customer_id=$1',[customer.id]);
   await client.query('UPDATE er_customer_recovery SET consumed_at=$2,reset_hash=NULL WHERE customer_id=$1 AND consumed_at IS NULL',[customer.id,new Date(now)]);
   return true;
  })
 };
}
module.exports={recoveryStorage};
