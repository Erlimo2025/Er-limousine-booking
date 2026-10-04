const {Pool} = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {AsyncLocalStorage} = require('async_hooks');
class StorageError extends Error {
  constructor() { super('Reservation service temporarily unavailable. Please try again.'); this.status = 503; this.storageFailure = true; }
}
const statuses = ['awaiting_payment','confirmed','assigned','driver_en_route','passenger_on_board','completed','cancelled'];
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function validateRecord(r) {
  const fail = () => {throw new StorageError();};
  if (!plain(r) || typeof r.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(r.id) ||
      typeof r.createdAt !== 'string' || !Number.isFinite(Date.parse(r.createdAt)) || !statuses.includes(r.status) ||
      !['unpaid','paid','failed'].includes(r.paymentStatus) || !plain(r.customer) || !plain(r.trip) || !plain(r.quote) || !plain(r.dispatch)) fail();
  for (const key of ['firstName','lastName','email','phone']) if(typeof r.customer[key] !== 'string' || !r.customer[key].trim() || r.customer[key].length>200) fail();
  for (const key of ['pickup','dropoff','date','time','vehicle','tripType']) if(typeof r.trip[key] !== 'string' || !r.trip[key].trim() || r.trip[key].length>200) fail();
  if(!['escalade','suv'].includes(r.trip.vehicle) || !['oneway','roundtrip','airport','hourly'].includes(r.trip.tripType) ||
     typeof r.quote.total !== 'number' || !Number.isFinite(r.quote.total) || r.quote.total<=0 || typeof r.quote.vehicle !== 'string' ||
     r.quote.currency !== 'usd') fail();
  const validDate=value=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
  const validTime=value=>typeof value==='string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  if(!validDate(r.trip.date) || !validTime(r.trip.time) || !Number.isInteger(r.trip.passengers) || r.trip.passengers<1 || r.trip.passengers>6 || !Number.isSafeInteger(Math.round(r.quote.total*100)))fail();
  if(r.trip.tripType==='roundtrip' && (!validDate(r.trip.returnDate) || !validTime(r.trip.returnTime) || r.trip.returnDate+'T'+r.trip.returnTime<=r.trip.date+'T'+r.trip.time))fail();
  if(r.trip.tripType==='hourly' && ![3,3.5,4,4.5,5,5.5,6,7,8].includes(Number(r.trip.hours)))fail();
  if(r.customerAccess !== undefined && (!plain(r.customerAccess) || typeof r.customerAccess.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(r.customerAccess.tokenHash) || !Number.isFinite(r.customerAccess.expiresAt) || Object.keys(r.customerAccess).some(key=>!['tokenHash','expiresAt'].includes(key)))) fail();
  if(r.stripeSessionId !== null && r.stripeSessionId !== undefined && (typeof r.stripeSessionId !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(r.stripeSessionId))) fail();
  if(r.checkoutAttempt !== null && r.checkoutAttempt !== undefined && (!plain(r.checkoutAttempt) || typeof r.checkoutAttempt.key !== 'string' || !Number.isFinite(r.checkoutAttempt.expiresAt) || !plain(r.checkoutAttempt.quote) || !Number.isFinite(r.checkoutAttempt.quote.total) || r.checkoutAttempt.quote.total<=0)) fail();
  if(r.checkoutAttempt?.version !== undefined) {
    const a=r.checkoutAttempt;
    if(a.version!==1 || typeof a.correlationId!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(a.correlationId) ||
       !['prepared','submitted_unknown','session_identified','confirmed_paid','confirmed_unpaid','review_required'].includes(a.state) ||
       (a.firstSubmittedAt!==null && !Number.isFinite(a.firstSubmittedAt)) ||
       (a.lastReconciledAt!==null && !Number.isFinite(a.lastReconciledAt)) || !Number.isSafeInteger(a.submissionCount) || a.submissionCount<0)fail();
  }
  if(r.checkoutAttempt?.version===1 && r.checkoutAttempt.parameters!==undefined) {
    const a=r.checkoutAttempt,p=a.parameters,item=p?.line_items?.[0];
    if(!plain(p) || Object.keys(p).some(k=>!['mode','expires_at','customer_email','line_items','metadata','success_url','cancel_url'].includes(k)) ||
       p.mode!=='payment' || p.expires_at!==a.expiresAt || p.customer_email!==r.customer.email ||
       !Array.isArray(p.line_items) || p.line_items.length!==1 || item.quantity!==1 ||
       item.price_data?.unit_amount!==Math.round(a.quote.total*100) || item.price_data?.currency!==a.quote.currency ||
       p.metadata?.bookingId!==r.id || p.metadata?.attemptReference!==a.correlationId ||
       p.metadata?.promoCode!=='FIRST15' || p.metadata?.discount!==String(a.quote.discount || 0))fail();
  }
  for(const key of ['driver','driverPhone','vehicle','plate'])if(typeof r.dispatch[key] !== 'string' || r.dispatch[key].length>200)fail();
  return r;
}
function validateRecords(records) {
  if(!Array.isArray(records)) throw new StorageError();
  const ids=new Set(); for(const r of records) {validateRecord(r); if(ids.has(r.id)) throw new StorageError(); ids.add(r.id);} return records;
}
// Only Render database names, bare or with the exact .internal suffix, qualify on Render.
function connectionOptions(env) {
  try {
    const url=new URL(env.DATABASE_URL);
    if(!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.pathname.slice(1) || url.hash)throw new Error();
    for(const value of [url.username,url.password,url.pathname])decodeURIComponent(value);
    const internal=env.RENDER==='true' && /^dpg-[a-z0-9]+(?:-[a-z0-9]+)?(?:\.internal)?$/i.test(url.hostname);
    const mode=url.searchParams.get('sslmode');
    if(url.searchParams.getAll('sslmode').length>1 || (mode!==null && !['disable','require','verify-ca','verify-full'].includes(mode)))throw new Error();
    for(const key of ['ssl','sslcert','sslkey','sslrootcert','uselibpqcompat','host','hostaddr'])if(url.searchParams.has(key))throw new Error();
    if(!internal && mode==='disable')throw new Error();
    url.searchParams.delete('sslmode');
    let ssl={rejectUnauthorized:true};
    if(internal && (mode===null || mode==='disable'))ssl=false;
    else if(internal && mode==='require')ssl={rejectUnauthorized:false};
    return {connectionString:url.toString(),ssl};
  }catch(_){throw new StorageError();}
}
function createStore(env = process.env, suppliedPool) {
  if (!env.DATABASE_URL && !suppliedPool) throw new StorageError();
  const options=suppliedPool ? {} : connectionOptions(env);
  const scope=new AsyncLocalStorage();
  const pool=suppliedPool || new Pool({...options,max:10,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,statement_timeout:15000,application_name:'er-limousine'});
  pool.on?.('error',()=>console.error('Reservation storage connection unavailable.'));
  const safe = async fn => {try{return await fn();}catch(error){
    if(error.storageFailure)throw new StorageError();
    if(error.status && !error.storageFailure)throw error;
    throw new StorageError();
  }};
  async function transaction(fn) {
    return safe(async()=>{const shared=scope.getStore();const client=shared || await pool.connect();let broken=false;try {
      await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout = '5s'");
      const result=await fn(client);await client.query('COMMIT');return result;
    } catch(error) {try{await client.query('ROLLBACK');}catch(_){broken=true;}throw error;}finally{if(!shared)client.release(broken);}});
  }
  const decode = rows => validateRecords(rows.map(row=> {if(!plain(row.record) || row.record.id !== row.id)throw new StorageError();return row.record;}));
  const list = client => safe(async()=>decode((await (client || scope.getStore() || pool).query('SELECT id, record FROM er_reservations ORDER BY created_at DESC, id')).rows));
  const get = (id,client) => safe(async()=> {
    if(typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return null;
    const rows=(await (client || scope.getStore() || pool).query('SELECT id, record FROM er_reservations WHERE id = $1',[id])).rows;return decode(rows)[0] || null;
  });
  const hashIdentity = value => value ? crypto.createHash('sha256').update(value).digest('hex') : null;
  async function recordPaid(client,r) {
    if(r.paymentStatus !== 'paid')return;
    await client.query('SELECT pg_advisory_xact_lock($1)',[730903]);
    const paidAt=r.paidAt || r.createdAt;
    if(!Number.isFinite(Date.parse(paidAt)))throw new StorageError();
    await client.query("INSERT INTO er_payment_ledger (booking_id, amount_cents, currency, stripe_session_id, paid_at, retain_until) VALUES ($1,$2,$3,$4,$5,$5::timestamptz + interval '7 years') ON CONFLICT (booking_id) DO NOTHING",[r.id,Math.round(r.quote.total*100),r.quote.currency,r.stripeSessionId || null,paidAt]);
    await client.query('INSERT INTO er_paid_ride_eligibility (booking_id, email_hash, phone_hash) VALUES ($1,$2,$3) ON CONFLICT (booking_id) DO NOTHING',[r.id,hashIdentity(r.customer.email.trim().toLowerCase()),hashIdentity(r.customer.phone.replace(/\D/g,''))]);
  }
  const hasPaidRide = (email,phone) => safe(async()=> {
    const result=await (scope.getStore() || pool).query('SELECT 1 FROM er_paid_ride_eligibility WHERE email_hash = $1 OR phone_hash = $2 LIMIT 1',[hashIdentity(email),hashIdentity(phone)]);
    return result.rows.length>0;
  });
  const insert = (record,client,skip=false) => safe(async()=>{
    validateRecord(record);
    const result=await client.query('INSERT INTO er_reservations (id, record, created_at) VALUES ($1, $2::jsonb, $3) '+(skip?'ON CONFLICT (id) DO NOTHING ':'')+'RETURNING id', [record.id,JSON.stringify(record),record.createdAt]);if(result.rowCount)await recordPaid(client,record);return result.rowCount;
  });
  async function update(id,fn) {
    if(typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))return null;
    return transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock($1)',[730903]);
      const rows=(await client.query('SELECT id, record FROM er_reservations WHERE id = $1 FOR UPDATE',[id])).rows;
      const record=decode(rows)[0];if(!record)return null;
      const result=await fn(record,client);validateRecord(record);
      await client.query('UPDATE er_reservations SET record = $2::jsonb, version = version + 1, updated_at = now() WHERE id = $1',[id,JSON.stringify(record)]);
      await recordPaid(client,record);
      if(record.paymentStatus==='paid' || record.checkoutAttempt?.state==='confirmed_unpaid' || (!record.checkoutAttempt && !record.stripeSessionId))await client.query('DELETE FROM er_first_ride_claims WHERE booking_id=$1',[id]);
      return result === undefined ? record : result;
    });
  }
  async function createWithBudget(record,check) {
    return transaction(async client=>{
      // Atomic budget/read/create across processes, held only for database operations.
      await client.query('SELECT pg_advisory_xact_lock($1)',[730901]);
      const records=await list(client);await check(records);await insert(record,client);return record;
    });
  }
  async function withActionLock(fingerprint,fn) {
    return safe(async()=>{
      const client=await pool.connect();let locked=false;let broken=false;
      const key=crypto.createHash('sha256').update(fingerprint).digest().readBigInt64BE().toString();
      try {
        // A nonblocking lock prevents waiting requests from exhausting the pool.
        locked=(await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked',[key])).rows[0].locked;
        if(!locked)throw Object.assign(new Error('Checkout is already processing. Please try again.'),{status:409});
        try {return await scope.run(client,fn);} catch(error) {if(!error.storageFailure && !error.status)error.status=400;throw error;}
      } finally {
        if(locked)try{await client.query('SELECT pg_advisory_unlock($1::bigint)',[key]);}catch(_){broken=true;}
        client.release(broken);
      }
    });
  }
  const identityHashes=customer=>[hashIdentity(customer.email.trim().toLowerCase()),hashIdentity(customer.phone.replace(/\D/g,''))];
  async function firstRideConflicts(record) {
    return safe(async()=>decode((await (scope.getStore() || pool).query('SELECT DISTINCT r.id,r.record FROM er_first_ride_claims c JOIN er_reservations r ON r.id=c.booking_id WHERE c.identity_hash=ANY($1::text[]) AND c.booking_id<>$2',[identityHashes(record.customer),record.id])).rows));
  }
  async function claimFirstRide(record) {
    return transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock($1)',[730903]);
      const hashes=identityHashes(record.customer);
      const paid=await client.query('SELECT 1 FROM er_paid_ride_eligibility WHERE email_hash=$1 OR phone_hash=$2 LIMIT 1',hashes);
      if(paid.rows.length)throw Object.assign(new Error('FIRST15 is only available for your first ride.'),{status:400});
      const conflict=await client.query('SELECT 1 FROM er_first_ride_claims WHERE identity_hash=ANY($1::text[]) AND booking_id<>$2 LIMIT 1',[hashes,record.id]);
      if(conflict.rows.length)throw Object.assign(new Error('A first-ride Checkout is already pending. Please complete or retry that booking.'),{status:409});
      for(const hash of [...new Set(hashes)].sort())await client.query('INSERT INTO er_first_ride_claims (identity_hash,booking_id) VALUES ($1,$2) ON CONFLICT (identity_hash) DO NOTHING',[hash,record.id]);
    });
  }
  async function releaseExpiredFirstRide(id,sessionId) {
    return transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock($1)',[730903]);
      const record=await get(id,client);
      if(record && record.paymentStatus!=='paid' && record.stripeSessionId===sessionId)await client.query('DELETE FROM er_first_ride_claims WHERE booking_id=$1',[id]);
    });
  }
  async function reconciliationCandidates(limit=10) {
    return safe(async()=>decode((await pool.query("SELECT r.id,r.record FROM er_reservations r WHERE r.record->>'paymentStatus'<>'paid' AND EXISTS (SELECT 1 FROM er_first_ride_claims c WHERE c.booking_id=r.id) ORDER BY (r.record #>> '{checkoutAttempt,lastReconciledAt}')::bigint NULLS FIRST,r.created_at LIMIT $1",[limit])).rows));
  }
  async function finalizeReconciliation(snapshot,outcome) {
    return update(snapshot.id,async(record,client)=>{
      const attempt=record.checkoutAttempt;
      if(!attempt || attempt.key!==snapshot.checkoutAttempt?.key ||
         (record.stripeSessionId || null)!==(snapshot.stripeSessionId || null) ||
         (attempt.state || null)!==(snapshot.checkoutAttempt.state || null))return false;
      if(record.paymentStatus==='paid') {attempt.state='confirmed_paid';return false;}
      if(outcome.state==='confirmed_unpaid') {
        const proof=outcome.evidence==='verified_expired_unpaid' && !!outcome.sessionId ||
          outcome.evidence==='not_submitted' && attempt.version===1 && attempt.state==='prepared' && attempt.firstSubmittedAt===null && attempt.submissionCount===0 && !record.stripeSessionId ||
          outcome.evidence==='validation_rejected_before_execution' && attempt.version===1 && attempt.submissionCount===1 && attempt.state==='submitted_unknown' && !record.stripeSessionId;
        if(!proof)return false;
        const paid=await client.query('SELECT 1 FROM er_paid_ride_eligibility WHERE email_hash=$1 OR phone_hash=$2 LIMIT 1',identityHashes(record.customer));
        const claims=await client.query('SELECT 1 FROM er_first_ride_claims WHERE booking_id=$1 LIMIT 1',[record.id]);
        if(paid.rows.length || !claims.rows.length) {attempt.state='review_required';attempt.evidence='paid_identity_or_claim_changed';attempt.lastReconciledAt=outcome.at;return false;}
      }
      if(outcome.sessionId)record.stripeSessionId=outcome.sessionId;
      Object.assign(attempt,{state:outcome.state,evidence:outcome.evidence,lastReconciledAt:outcome.at});
      if(outcome.state==='confirmed_paid') {
        record.paymentStatus='paid';if(record.status==='awaiting_payment')record.status='confirmed';record.paidAt=new Date(outcome.at).toISOString();
      }
      return true;
    });
  }
  async function migrate() {
    return transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock($1)',[730902]);
      await client.query(fs.readFileSync(path.join(__dirname,'../migrations/001-reservations.sql'),'utf8'));
      await client.query(fs.readFileSync(path.join(__dirname,'../migrations/003-customer-accounts.sql'),'utf8'));
      await client.query(fs.readFileSync(path.join(__dirname,'../migrations/004-customer-recovery.sql'),'utf8'));
      await client.query(fs.readFileSync(path.join(__dirname,'../migrations/005-email-recovery.sql'),'utf8'));
    });
  }
  async function importLegacy(records) {
    validateRecords(records);
    return transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock($1)',[730901]);
      let inserted=0;for(const record of records)inserted+=await insert(record,client,true);
      const skipped=records.length-inserted;
      await client.query('INSERT INTO er_storage_audit (event_type, inserted_count, skipped_count) VALUES ($1,$2,$3)',['legacy_import',inserted,skipped]);
      return {inserted,skipped};
    });
  }
  return {...require('./recovery').recoveryStorage(pool,transaction,safe),...require('./customers').customerStorage(pool,transaction,safe),list,get,hasPaidRide,update,createWithBudget,withActionLock,firstRideConflicts,claimFirstRide,releaseExpiredFirstRide,reconciliationCandidates,finalizeReconciliation,migrate,importLegacy,close:()=>pool.end()};
}
module.exports={createStore,StorageError,validateRecord,validateRecords,connectionOptions};
