const {createHash,randomUUID}=require('node:crypto');

const MINUTE=60000;
const TOKEN_TTL=20*MINUTE;
const DRAFT_TTL=30*MINUTE;
const RATE_WINDOW=60*MINUTE;
const EMAIL_COOLDOWN=MINUTE;
const EMAIL_LIMIT=3;
const SOURCE_LIMIT=20;
const CONFIRMATION_LIMIT=8;
const CLEANUP_BATCH=100;
const customerColumns='id,full_name,display_email,display_phone,email_verified_at';
const emailHash=email=>createHash('sha256').update(email).digest('hex');

function customerEmailVerificationStorage(pool,transaction,safe) {
 async function takeRate(client,scope,hash,now,limit,cooldown=0) {
  const at=new Date(now);
  const result=await client.query(
   'INSERT INTO er_customer_enrollment_limits(scope,identity_hash,attempts,expires_at,next_allowed_at) VALUES($1,$2,1,$4,$5) '+
   'ON CONFLICT(scope,identity_hash) DO UPDATE SET '+
   'attempts=CASE WHEN er_customer_enrollment_limits.expires_at<=$3 THEN 1 ELSE er_customer_enrollment_limits.attempts+1 END, '+
   'expires_at=CASE WHEN er_customer_enrollment_limits.expires_at<=$3 THEN $4 ELSE er_customer_enrollment_limits.expires_at END, next_allowed_at=$5 '+
   'WHERE er_customer_enrollment_limits.next_allowed_at<=$3 AND '+
   '(er_customer_enrollment_limits.expires_at<=$3 OR er_customer_enrollment_limits.attempts<$6)',
   [scope,hash,at,new Date(now+RATE_WINDOW),new Date(now+cooldown),limit]
  );
  return result.rowCount===1;
 }

 async function hasAccount(client,email) {
  return (await client.query('SELECT 1 FROM er_customers WHERE normalized_email=$1',[email])).rowCount===1;
 }

 // Account locks precede session locks, as in password recovery and profile updates.
 async function activeLegacyCustomer(client,customerId,sessionHash,now) {
  const account=(await client.query(
   "SELECT normalized_email,display_email,email_verified_at FROM er_customers WHERE id=$1 AND account_status='active' FOR UPDATE",
   [customerId]
  )).rows[0];
  if(!account || account.email_verified_at)return null;
  const session=await client.query(
   'SELECT 1 FROM er_customer_sessions WHERE customer_id=$1 AND token_hash=$2 AND expires_at>$3 FOR SHARE',
   [customerId,sessionHash,new Date(now)]
  );
  return session.rowCount===1?account:null;
 }

 const finishDelivery=(table,tokenHash,sent)=>safe(async()=>{
  await pool.query("UPDATE "+table+" SET delivery_state=$2 WHERE token_hash=$1 AND delivery_state='pending'",
   [tokenHash,sent?'sent':'failed']);
 });

 const deleteExpired=(client,table,key,expiry,at)=>client.query(
  'WITH expired AS (SELECT '+key+' FROM '+table+' WHERE '+expiry+'<=$1 ORDER BY '+expiry+' LIMIT $2 FOR UPDATE SKIP LOCKED) '+
  'DELETE FROM '+table+' AS target USING expired WHERE target.'+key+'=expired.'+key,[at,CLEANUP_BATCH]
 );

 return {
  prepareEnrollment:(draft,sourceHash,now)=>transaction(async client=>{
   const {tokenHash,browserHash,fullName,normalizedEmail,displayEmail,normalizedPhone,passwordHash}=draft;
   if(!await takeRate(client,'source',sourceHash,now,SOURCE_LIMIT) ||
      !await takeRate(client,'email',emailHash(normalizedEmail),now,EMAIL_LIMIT,EMAIL_COOLDOWN) ||
      await hasAccount(client,normalizedEmail))return null;

   await client.query(
    'INSERT INTO er_customer_enrollments(browser_hash,token_hash,full_name,normalized_email,display_email,normalized_phone,password_hash,expires_at,draft_expires_at,delivery_state) '+
    "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') ON CONFLICT(browser_hash) DO UPDATE SET "+
    'token_hash=EXCLUDED.token_hash, full_name=EXCLUDED.full_name, normalized_email=EXCLUDED.normalized_email, '+
    'display_email=EXCLUDED.display_email, normalized_phone=EXCLUDED.normalized_phone, password_hash=EXCLUDED.password_hash, '+
    'expires_at=EXCLUDED.expires_at, draft_expires_at=EXCLUDED.draft_expires_at, confirmation_attempts=0, delivery_state=EXCLUDED.delivery_state',
    [browserHash,tokenHash,fullName,normalizedEmail,displayEmail,normalizedPhone,passwordHash,new Date(now+TOKEN_TTL),new Date(now+DRAFT_TTL)]
   );
   return displayEmail;
  }),

  resendEnrollment:({browserHash,tokenHash},sourceHash,now)=>transaction(async client=>{
   if(!await takeRate(client,'source',sourceHash,now,SOURCE_LIMIT))return null;
   const at=new Date(now);
   const enrollment=(await client.query(
    'SELECT normalized_email,display_email,token_hash FROM er_customer_enrollments WHERE browser_hash=$1 AND draft_expires_at>$2',
    [browserHash,at]
   )).rows[0];
   if(!enrollment ||
      !await takeRate(client,'email',emailHash(enrollment.normalized_email),now,EMAIL_LIMIT,EMAIL_COOLDOWN) ||
      await hasAccount(client,enrollment.normalized_email))return null;

   // Only replace the token we inspected. A newer request or completed signup wins.
   const updated=await client.query(
    "UPDATE er_customer_enrollments SET token_hash=$2, expires_at=LEAST($3,draft_expires_at), delivery_state='pending' "+
    'WHERE browser_hash=$1 AND token_hash=$4 AND draft_expires_at>$5',
    [browserHash,tokenHash,new Date(now+TOKEN_TTL),enrollment.token_hash,at]
   );
   return updated.rowCount===1?enrollment.display_email:null;
  }),

  finishEnrollmentDelivery:(tokenHash,sent)=>finishDelivery('er_customer_enrollments',tokenHash,sent),

  enrollmentForConfirmation:(tokenHash,now)=>safe(async()=>{
   const row=(await pool.query(
    'UPDATE er_customer_enrollments SET confirmation_attempts=confirmation_attempts+1 '+
    "WHERE token_hash=$1 AND delivery_state='sent' AND expires_at>$2 AND confirmation_attempts<$3 "+
    'RETURNING browser_hash,password_hash',
    [tokenHash,new Date(now),CONFIRMATION_LIMIT]
   )).rows[0];
   return row?{browserHash:row.browser_hash,passwordHash:row.password_hash}:null;
  }),

  activateEnrollment:(tokenHash,session,now)=>transaction(async client=>{
   const at=new Date(now);
   const enrollment=(await client.query(
    "DELETE FROM er_customer_enrollments WHERE token_hash=$1 AND delivery_state='sent' AND expires_at>$2 "+
    'RETURNING full_name,normalized_email,display_email,normalized_phone,password_hash',[tokenHash,at]
   )).rows[0];
   if(!enrollment)return null;

   const {full_name,normalized_email,display_email,normalized_phone,password_hash}=enrollment;
   const customer=(await client.query(
    'INSERT INTO er_customers(id,full_name,normalized_email,display_email,normalized_phone,display_phone,password_hash,created_at,updated_at,email_verified_at) '+
    'VALUES($1,$2,$3,$4,$5,$5,$6,$7,$7,$7) ON CONFLICT DO NOTHING RETURNING '+customerColumns,
    [randomUUID(),full_name,normalized_email,display_email,normalized_phone,password_hash,at]
   )).rows[0];
   if(!customer)return {conflict:true};

   await client.query(
    'INSERT INTO er_customer_sessions(token_hash,customer_id,created_at,expires_at,last_used_at) VALUES($1,$2,$3,$4,$3)',
    [session.hash,customer.id,session.created,session.expires]
   );
   return {customer};
  }),

  prepareExistingVerification:({customerId,sessionHash,tokenHash},sourceHash,now)=>transaction(async client=>{
   const account=await activeLegacyCustomer(client,customerId,sessionHash,now);
   if(!account ||
      !await takeRate(client,'source',sourceHash,now,SOURCE_LIMIT) ||
      !await takeRate(client,'email',emailHash(account.normalized_email),now,EMAIL_LIMIT,EMAIL_COOLDOWN))return null;

   await client.query(
    'INSERT INTO er_customer_email_challenges(customer_id,token_hash,normalized_email,expires_at,delivery_state) '+
    "VALUES($1,$2,$3,$4,'pending') ON CONFLICT(customer_id) DO UPDATE SET token_hash=EXCLUDED.token_hash, "+
    'normalized_email=EXCLUDED.normalized_email, expires_at=EXCLUDED.expires_at, delivery_state=EXCLUDED.delivery_state',
    [customerId,tokenHash,account.normalized_email,new Date(now+TOKEN_TTL)]
   );
   return account.display_email;
  }),

  finishExistingVerificationDelivery:(tokenHash,sent)=>finishDelivery('er_customer_email_challenges',tokenHash,sent),

  activateExistingVerification:({customerId,sessionHash,tokenHash},now)=>transaction(async client=>{
   const account=await activeLegacyCustomer(client,customerId,sessionHash,now);
   if(!account)return null;
   const at=new Date(now);
   const challenge=await client.query(
    "DELETE FROM er_customer_email_challenges WHERE customer_id=$1 AND token_hash=$2 AND normalized_email=$3 AND delivery_state='sent' AND expires_at>$4",
    [customerId,tokenHash,account.normalized_email,at]
   );
   if(challenge.rowCount!==1)return null;
   return (await client.query(
    'UPDATE er_customers SET email_verified_at=$2,updated_at=$2 WHERE id=$1 RETURNING '+customerColumns,
    [customerId,at]
   )).rows[0];
  }),

  cleanupEmailEnrollments:now=>transaction(async client=>{
   const at=new Date(now);
   await deleteExpired(client,'er_customer_enrollments','browser_hash','draft_expires_at',at);
   await deleteExpired(client,'er_customer_email_challenges','customer_id','expires_at',at);
   await client.query(
    'WITH expired AS (SELECT scope,identity_hash FROM er_customer_enrollment_limits WHERE expires_at<=$1 ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED) '+
    'DELETE FROM er_customer_enrollment_limits AS target USING expired '+
    'WHERE target.scope=expired.scope AND target.identity_hash=expired.identity_hash',[at,CLEANUP_BATCH]
   );
  })
 };
}

module.exports={customerEmailVerificationStorage};
