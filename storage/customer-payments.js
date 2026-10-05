const crypto=require('node:crypto');
const {paymentError}=require('../services/customer-payments');
const policies=Object.freeze({setup:[20,40,15*60000],verify:[30,60,15*60000],list:[60,120,60000],remove:[20,40,15*60000]});
function customerPaymentStorage(pool,transaction,safe) {
 let nextCleanupAt=0;
 async function cleanup(now){
  if(now<nextCleanupAt)return;
  nextCleanupAt=now+30000;
  // Separate short transaction avoids taking arbitrary expired locks while updating live scopes.
  await transaction(client=>client.query('WITH expired AS (SELECT identity_hash FROM er_customer_payment_limits WHERE reset_at<=$1 ORDER BY reset_at,identity_hash LIMIT 100 FOR UPDATE SKIP LOCKED) DELETE FROM er_customer_payment_limits l USING expired e WHERE l.identity_hash=e.identity_hash AND l.reset_at<=$1',[new Date(now)]));
 }
 const mappingColumns='customer_id,stripe_customer_id,provisioning_id,state,livemode,first_submitted_at,created_at,updated_at,last_setup_at';
 async function authority(client,owner,sessionHash,now) {
  const row=(await client.query("SELECT id FROM er_customers WHERE id=$1 AND account_status='active' FOR UPDATE",[owner])).rows[0];
  if(!row || !(await client.query('SELECT 1 FROM er_customer_sessions WHERE customer_id=$1 AND token_hash=$2 AND expires_at>$3',[owner,sessionHash,new Date(now)])).rows.length)throw paymentError(401);
 }
 return {
  paymentAuthority:(owner,sessionHash,now)=>transaction(client=>authority(client,owner,sessionHash,now)),
  paymentLimit:async(owner,ip,operation,now)=>{
   // Optional maintenance must not prevent enforcement. Keep the finite retry gate;
   // the separate cleanup transaction has already rolled back on failure.
   try{await cleanup(now);}catch(_){}
   return transaction(async client=>{
   const policy=policies[operation];if(!policy)throw paymentError();
   const scopes=[['customer',owner,policy[0]],['client',ip,policy[1]]].map(([kind,value,limit])=>({hash:crypto.createHash('sha256').update('customer-payments|'+operation+'|'+kind+'|'+value).digest('hex'),limit})).sort((a,b)=>a.hash.localeCompare(b.hash));
   let allowed=true;
   for(const scope of scopes){const row=(await client.query('INSERT INTO er_customer_payment_limits(identity_hash,attempts,reset_at) VALUES($1,1,$3) ON CONFLICT(identity_hash) DO UPDATE SET attempts=CASE WHEN er_customer_payment_limits.reset_at<=$2 THEN 1 ELSE er_customer_payment_limits.attempts+1 END,reset_at=CASE WHEN er_customer_payment_limits.reset_at<=$2 THEN $3 ELSE er_customer_payment_limits.reset_at END RETURNING attempts',[scope.hash,new Date(now),new Date(now+policy[2])])).rows[0];allowed=allowed && row.attempts<=scope.limit;}
   return allowed;
  });},
  paymentMapping:owner=>safe(async()=> (await pool.query('SELECT '+mappingColumns+' FROM er_customer_payment_mappings WHERE customer_id=$1',[owner])).rows[0] || null),
  preparePaymentMapping:(owner,sessionHash,now)=>transaction(async client=>{
   await authority(client,owner,sessionHash,now);
   await client.query('INSERT INTO er_customer_payment_mappings(customer_id,provisioning_id,created_at,updated_at) VALUES($1,$2,$3,$3) ON CONFLICT(customer_id) DO NOTHING',[owner,crypto.randomUUID(),new Date(now)]);
   return (await client.query('SELECT '+mappingColumns+' FROM er_customer_payment_mappings WHERE customer_id=$1 FOR UPDATE',[owner])).rows[0];
  }),
  updatePaymentMapping:(owner,sessionHash,expected,state,now,result)=>transaction(async client=>{
   await authority(client,owner,sessionHash,now);
   const row=(await client.query('SELECT '+mappingColumns+' FROM er_customer_payment_mappings WHERE customer_id=$1 FOR UPDATE',[owner])).rows[0];
   if(!row || row.provisioning_id!==expected.provisioning_id || row.state!==expected.state || row.stripe_customer_id!==expected.stripe_customer_id)throw paymentError();
   if(row.state==='ready')throw paymentError(); // Mapping cannot be transferred or replaced.
   return (await client.query('UPDATE er_customer_payment_mappings SET state=$3,first_submitted_at=CASE WHEN $3=\'submitted_unknown\' THEN COALESCE(first_submitted_at,$4) ELSE first_submitted_at END,updated_at=$4,stripe_customer_id=$5,livemode=$6 WHERE customer_id=$1 AND provisioning_id=$2 RETURNING '+mappingColumns,[owner,row.provisioning_id,state,new Date(now),result?.id || null,result?.livemode ?? null])).rows[0];
  }),
  preparePaymentSetup:(owner,sessionHash,now)=>transaction(async client=>{
   await authority(client,owner,sessionHash,now);
   const mapping=(await client.query('SELECT state,last_setup_at FROM er_customer_payment_mappings WHERE customer_id=$1 FOR UPDATE',[owner])).rows[0];
   if(mapping?.state!=='ready')throw paymentError();
   const active=(await client.query("SELECT * FROM er_customer_payment_setups WHERE customer_id=$1 AND state IN ('prepared','submitted_unknown','identified','review_required') FOR UPDATE",[owner])).rows[0];
   if(active)return active;
   if(mapping.last_setup_at && now-new Date(mapping.last_setup_at).getTime()<60000)throw paymentError(429);
   const id=crypto.randomUUID(),date=new Date(now);
   await client.query('UPDATE er_customer_payment_mappings SET last_setup_at=$2 WHERE customer_id=$1',[owner,date]);
   return (await client.query('INSERT INTO er_customer_payment_setups(id,customer_id,consent_at,created_at,updated_at,expires_at) VALUES($1,$2,$3,$3,$3,$4) RETURNING *',[id,owner,date,new Date(now+30*60000)])).rows[0];
  }),
  paymentSetup:(owner,id)=>safe(async()=> (await pool.query('SELECT * FROM er_customer_payment_setups WHERE customer_id=$1 AND id=$2',[owner,id])).rows[0] || null),
  updatePaymentSetup:(owner,sessionHash,expected,state,now,setupId=expected.stripe_setup_id)=>transaction(async client=>{
   await authority(client,owner,sessionHash,now);
   const row=(await client.query('SELECT * FROM er_customer_payment_setups WHERE customer_id=$1 AND id=$2 FOR UPDATE',[owner,expected.id])).rows[0];
   if(!row || row.state!==expected.state || row.stripe_setup_id!==expected.stripe_setup_id || (row.stripe_setup_id && row.stripe_setup_id!==setupId))throw paymentError();
   return (await client.query("UPDATE er_customer_payment_setups SET state=$3,stripe_setup_id=$4,updated_at=$5,first_submitted_at=CASE WHEN $3='submitted_unknown' THEN COALESCE(first_submitted_at,$5) ELSE first_submitted_at END WHERE customer_id=$1 AND id=$2 RETURNING *",[owner,row.id,state,setupId,new Date(now)])).rows[0];
  })
 };
}
module.exports={customerPaymentStorage,policies};
