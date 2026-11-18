'use strict';

const crypto = require('node:crypto');
const IDLE_MS = 30 * 60_000;
const uuid = value => typeof value === 'string' && value.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const invalid = () => Object.assign(new Error('Invalid audit filter.'), {status: 400});
const auditActions = new Set(['dispatch_sign_in','dispatch_logout','reservation_status_update','driver_assignment_update','reservation_cancellation','payment_recheck','financial_csv_export','owner_mfa_enrollment','owner_recovery','owner_recovery_codes','owner_sessions_revoked','owner_emergency_recovery','owner_provisioned']);
const auditOutcomes = new Set(['succeeded','unchanged','failed','denied','completed','interrupted']);

function dispatchAccessStorage(pool, transaction, safe) {
  const owner = row => row || null;
  async function append(client, entry) {
    if (!entry || !uuid(entry.referenceId) || typeof entry.action!=='string' || typeof entry.outcome!=='string' || !auditActions.has(entry.action) || !auditOutcomes.has(entry.outcome) || typeof entry.timestamp!=='string' || !Number.isFinite(Date.parse(entry.timestamp))) return false;
    await client.query('INSERT INTO er_dispatch_audit_events(occurred_at,reference_id,staff_id,actor_id,record_id,action,outcome) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(reference_id,action) DO NOTHING',
      [entry.timestamp,entry.referenceId,uuid(entry.staffId)?entry.staffId:null,uuid(entry.actorId)?entry.actorId:null,uuid(entry.recordId)?entry.recordId:null,entry.action,entry.outcome]);
    return true;
  }
  const audit = (client, entry, staffId, actorId) => entry ? append(client,{...entry,staffId,actorId}) : Promise.resolve();
  const current = (client, hash, now, lock = false) => client.query(`SELECT o.*,s.actor_id,s.token_hash,s.expires_at,s.last_seen_at,s.created_at AS session_created_at FROM er_dispatch_sessions s JOIN er_dispatch_owners o ON o.id=s.owner_id WHERE s.token_hash=$1 AND o.account_status='active' AND NOT o.recovery_pending AND o.mfa_cipher IS NOT NULL AND s.auth_version=o.auth_version AND s.expires_at>$2 AND s.last_seen_at>$3 ${lock?'FOR UPDATE OF o,s':''}`,[hash,new Date(now),new Date(now-IDLE_MS)]);
  // All multi-row authentication mutations lock the owner first. This keeps
  // logout, MFA completion, recovery and session refresh in the same lock order.
  const lockOwner = (client,sessionHash,challengeHash) => client.query('SELECT id FROM er_dispatch_owners WHERE id IN (SELECT owner_id FROM er_dispatch_sessions WHERE token_hash=$1 UNION SELECT owner_id FROM er_dispatch_challenges WHERE token_hash=$2) ORDER BY id FOR UPDATE',[sessionHash,challengeHash]);
  const revoke = async (client,id) => {await client.query('DELETE FROM er_dispatch_sessions WHERE owner_id=$1',[id]);await client.query('DELETE FROM er_dispatch_challenges WHERE owner_id=$1',[id]);};
  const codes = async (client,id,hashes) => {await client.query('DELETE FROM er_dispatch_recovery_codes WHERE owner_id=$1',[id]);for(const hash of hashes)await client.query('INSERT INTO er_dispatch_recovery_codes(owner_id,code_hash) VALUES($1,$2)',[id,hash]);};
  return {
    dispatchProvisionOwner: input => transaction(async client => {
      const {id=crypto.randomUUID(),name,email,passwordHash,now=Date.now()}=input;
      const inserted=await client.query('INSERT INTO er_dispatch_owners(id,display_name,normalized_email,password_hash,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',[id,name,email,passwordHash,new Date(now)]);
      if(!inserted.rowCount)throw Object.assign(new Error('An owner account already exists.'),{status:409});
      await audit(client,input.audit?{...input.audit,recordId:id}:null);return {id};
    }),
    dispatchOwnerByEmail: email => safe(async()=>owner((await pool.query('SELECT * FROM er_dispatch_owners WHERE normalized_email=$1',[email])).rows[0])),
    dispatchOwnerById: id => safe(async()=>owner((await pool.query('SELECT * FROM er_dispatch_owners WHERE id=$1',[id])).rows[0])),
    dispatchAuthLimit: (scope,hash,now,limit,windowMs) => safe(async()=> {
      // Bound cleanup work per request and do not wait on counters another
      // instance is updating. Only expired authentication metadata is pruned.
      await pool.query(`WITH expired AS (
        SELECT scope,identity_hash FROM er_dispatch_auth_limits WHERE reset_at<=$1
        ORDER BY reset_at,scope,identity_hash LIMIT 250 FOR UPDATE SKIP LOCKED
      ) DELETE FROM er_dispatch_auth_limits a USING expired e
        WHERE a.scope=e.scope AND a.identity_hash=e.identity_hash AND a.reset_at<=$1`,[new Date(now)]);
      const result=await pool.query('INSERT INTO er_dispatch_auth_limits(scope,identity_hash,attempts,reset_at) VALUES($1,$2,1,$4) ON CONFLICT(scope,identity_hash) DO UPDATE SET attempts=CASE WHEN er_dispatch_auth_limits.reset_at<=$3 THEN 1 ELSE er_dispatch_auth_limits.attempts+1 END,reset_at=CASE WHEN er_dispatch_auth_limits.reset_at<=$3 THEN $4 ELSE er_dispatch_auth_limits.reset_at END RETURNING attempts',[scope,hash,new Date(now),new Date(now+windowMs)]);
      return result.rows[0].attempts<=limit;
    }),
    dispatchCreateChallenge: (id,passwordHash,challenge,now) => transaction(async client=> {
      const row=(await client.query("SELECT * FROM er_dispatch_owners WHERE id=$1 AND account_status='active' FOR UPDATE",[id])).rows[0];
      if(!row || row.password_hash!==passwordHash || row.recovery_pending)return false;
      await client.query('DELETE FROM er_dispatch_challenges WHERE expires_at<=$1',[new Date(now)]);
      await client.query('DELETE FROM er_dispatch_sessions WHERE expires_at<=$1 OR last_seen_at<=$2',[new Date(now),new Date(now-IDLE_MS)]);
      // Bound live challenges per owner; a newer password-verified challenge replaces older ones.
      await client.query('DELETE FROM er_dispatch_challenges WHERE owner_id=$1 AND completed_session_hash IS NULL',[id]);
      await client.query('INSERT INTO er_dispatch_challenges(token_hash,owner_id,auth_version,purpose,expires_at) VALUES($1,$2,$3,$4,$5)',[challenge.hash,id,row.auth_version,row.mfa_cipher?'mfa':'enroll',new Date(now+5*60_000)]);
      return row.mfa_cipher?'mfa':'enroll';
    }),
    dispatchChallenge: (hash,now) => safe(async()=>owner((await pool.query("SELECT c.*,o.display_name,o.normalized_email FROM er_dispatch_challenges c JOIN er_dispatch_owners o ON o.id=c.owner_id WHERE c.token_hash=$1 AND c.expires_at>$2 AND c.completed_session_hash IS NULL AND c.auth_version=o.auth_version AND o.account_status='active'",[hash,new Date(now)])).rows[0])),
    dispatchEnrollmentSeed: (hash,now,cipher) => transaction(async client=> {
      await lockOwner(client,null,hash);
      const row=(await client.query("SELECT c.*,o.mfa_cipher FROM er_dispatch_challenges c JOIN er_dispatch_owners o ON o.id=c.owner_id WHERE c.token_hash=$1 AND c.expires_at>$2 AND c.completed_session_hash IS NULL AND c.auth_version=o.auth_version AND c.purpose='enroll' AND o.account_status='active' AND (o.mfa_cipher IS NULL OR o.recovery_pending) FOR UPDATE OF o,c",[hash,new Date(now)])).rows[0];
      if(!row)return null;
      if(!row.pending_cipher)await client.query('UPDATE er_dispatch_challenges SET pending_cipher=$2 WHERE token_hash=$1',[hash,cipher]);
      return row.pending_cipher || cipher;
    }),
    dispatchCompleteChallenge: (hash,now,verify,session,recoveryHashes,auditEntry) => transaction(async client=> {
      await lockOwner(client,null,hash);
      const row=(await client.query("SELECT c.*,o.mfa_cipher,o.last_totp_step,o.display_name,o.normalized_email,o.recovery_pending FROM er_dispatch_challenges c JOIN er_dispatch_owners o ON o.id=c.owner_id WHERE c.token_hash=$1 AND c.expires_at>$2 AND c.completed_session_hash IS NULL AND c.auth_version=o.auth_version AND o.account_status='active' FOR UPDATE OF o,c",[hash,new Date(now)])).rows[0];
      if(!row)return null;
      const cipher=row.purpose==='enroll'?row.pending_cipher:row.mfa_cipher;
      const step=cipher?verify(cipher,row.purpose==='enroll'?null:row.last_totp_step):null;
      if(step===null)return null;
      if(row.purpose==='enroll') {
        if(row.mfa_cipher&&!row.recovery_pending)return null;
        await client.query('UPDATE er_dispatch_owners SET mfa_cipher=$2,last_totp_step=$3,last_sign_in_at=$4,recovery_pending=false WHERE id=$1',[row.owner_id,cipher,step,new Date(now)]);
        await codes(client,row.owner_id,recoveryHashes);
      } else await client.query('UPDATE er_dispatch_owners SET last_totp_step=$2,last_sign_in_at=$3 WHERE id=$1',[row.owner_id,step,new Date(now)]);
      // The five-minute authentication grant is consumed immediately. Keep
      // only a non-authenticating session association until that session's
      // absolute expiry, so logout also revokes a delayed Set-Cookie reply.
      await client.query('UPDATE er_dispatch_challenges SET completed_session_hash=$2,pending_cipher=NULL,expires_at=$3 WHERE token_hash=$1',[hash,session.hash,new Date(session.expires)]);
      await client.query('INSERT INTO er_dispatch_sessions(token_hash,owner_id,actor_id,auth_version,created_at,last_seen_at,expires_at) VALUES($1,$2,$3,$4,$5,$5,$6)',[session.hash,row.owner_id,session.actorId,row.auth_version,new Date(now),new Date(session.expires)]);
      await client.query('INSERT INTO er_dispatch_actor_identities(actor_id,owner_id,created_at) VALUES($1,$2,$3)',[session.actorId,row.owner_id,new Date(now)]);
      await audit(client,auditEntry,row.owner_id,session.actorId);
      return {id:row.owner_id,name:row.display_name,email:row.normalized_email,actorId:session.actorId,enrolled:row.purpose==='enroll'};
    }),
    // Rechecks may run inside a reservation transaction/advisory-lock scope or
    // a repeatable-read CSV snapshot. Use a separate, fresh statement: beginning
    // a nested transaction on that scoped client could prematurely commit the
    // business mutation, and its old snapshot could miss a revocation.
    dispatchResolveSession: (hash,now,touch=true) => !touch?safe(async()=>owner((await current(pool,hash,now)).rows[0])):transaction(async client=> {
      await lockOwner(client,hash,null);
      const row=(await current(client,hash,now,touch)).rows[0];if(!row)return null;
      if(touch)await client.query('UPDATE er_dispatch_sessions SET last_seen_at=$2 WHERE token_hash=$1',[hash,new Date(now)]);
      return row;
    }),
    dispatchRevokeSession: (hash,auditEntry,challengeHash=null) => transaction(async client=> {
      await lockOwner(client,hash,challengeHash);
      const challenge=challengeHash ? await client.query('DELETE FROM er_dispatch_challenges WHERE token_hash=$1 RETURNING completed_session_hash',[challengeHash]) : null;
      const completed=challenge?.rows[0]?.completed_session_hash || null;
      const removed=(await client.query('DELETE FROM er_dispatch_sessions WHERE token_hash=$1 OR token_hash=$2 RETURNING owner_id,actor_id,token_hash',[hash,completed])).rows;
      await client.query('DELETE FROM er_dispatch_challenges WHERE completed_session_hash=$1 OR completed_session_hash=$2',[hash,completed]);
      // Possessing only a pre-MFA challenge does not establish named identity.
      const row=removed.find(session=>session.token_hash===hash);
      if(row)await audit(client,auditEntry,row.owner_id,row.actor_id);
      else if(challenge?.rowCount)await audit(client,auditEntry);
      return row || (challenge?.rowCount ? {challengeRevoked:true} : null);
    }),
    dispatchListSessions: (id,now) => safe(async()=> (await pool.query('SELECT s.actor_id AS id,s.created_at,s.last_seen_at,s.expires_at FROM er_dispatch_sessions s JOIN er_dispatch_owners o ON o.id=s.owner_id WHERE s.owner_id=$1 AND s.auth_version=o.auth_version AND s.expires_at>$2 AND s.last_seen_at>$3 ORDER BY s.created_at DESC LIMIT 50',[id,new Date(now),new Date(now-IDLE_MS)])).rows),
    dispatchSensitiveAction: (hash,now,passwordHash,verify,action,recoveryHashes,auditEntry) => transaction(async client=> {
      await lockOwner(client,hash,null);
      const row=(await current(client,hash,now,true)).rows[0];
      if(!row || row.password_hash!==passwordHash)return false;
      const step=verify(row.mfa_cipher,row.last_totp_step);if(step===null)return false;
      await client.query('UPDATE er_dispatch_owners SET last_totp_step=$2 WHERE id=$1',[row.id,step]);
      if(action==='revoke_others') {
        await client.query('DELETE FROM er_dispatch_sessions WHERE owner_id=$1 AND token_hash<>$2',[row.id,hash]);
        await client.query('DELETE FROM er_dispatch_challenges WHERE owner_id=$1',[row.id]);
      }else if(action==='recovery_codes')await codes(client,row.id,recoveryHashes);else return false;
      await audit(client,auditEntry,row.id,row.actor_id);return true;
    }),
    dispatchRecover: (id,passwordHash,codeHash,challenge,now,auditEntry) => transaction(async client=> {
      const row=(await client.query("SELECT * FROM er_dispatch_owners WHERE id=$1 AND account_status='active' FOR UPDATE",[id])).rows[0];
      if(!row || row.password_hash!==passwordHash || !row.mfa_cipher)return false;
      const used=await client.query('DELETE FROM er_dispatch_recovery_codes WHERE owner_id=$1 AND code_hash=$2 RETURNING owner_id',[id,codeHash]);if(!used.rowCount)return false;
      await revoke(client,id);await codes(client,id,[]);
      await client.query('UPDATE er_dispatch_owners SET recovery_pending=true,auth_version=auth_version+1 WHERE id=$1',[id]);
      await client.query("INSERT INTO er_dispatch_challenges(token_hash,owner_id,auth_version,purpose,expires_at) SELECT $1,id,auth_version,'enroll',$3 FROM er_dispatch_owners WHERE id=$2",[challenge.hash,id,new Date(now+5*60_000)]);
      await audit(client,auditEntry,id);return true;
    }),
    dispatchEmergencyRecovery: input => transaction(async client=> {
      const row=(await client.query('SELECT * FROM er_dispatch_owners WHERE normalized_email=$1 FOR UPDATE',[input.email])).rows[0];if(!row)throw Object.assign(new Error('Owner account unavailable.'),{status:404});
      await revoke(client,row.id);await codes(client,row.id,[]);
      await client.query("UPDATE er_dispatch_owners SET password_hash=$2,mfa_cipher=NULL,last_totp_step=NULL,recovery_pending=false,auth_version=auth_version+1,account_status='active' WHERE id=$1",[row.id,input.passwordHash]);
      await audit(client,input.audit?{...input.audit,recordId:row.id}:null);return {id:row.id};
    }),
    dispatchAppendAudit: entry => safe(()=>append(pool,entry)),
    dispatchAuditPage: input => safe(async()=> {
      const {staffId,action,from,to,cursor,limit=25}=input;
      if(!Number.isSafeInteger(limit)||limit<1||limit>100 || staffId && !uuid(staffId) || action && !auditActions.has(action))throw invalid();
      const validDate=value=>/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
      if(from&&!validDate(from)||to&&!validDate(to)||from&&to&&from>to)throw invalid();
      let decoded=null;
      if(cursor){try{if(typeof cursor!=='string'||cursor.length>200)throw Error();decoded=JSON.parse(Buffer.from(cursor,'base64url'));if(!decoded||typeof decoded.at!=='string'||!Number.isFinite(Date.parse(decoded.at))||typeof decoded.id!=='string'||!/^\d{1,19}$/.test(decoded.id)||BigInt(decoded.id)>9223372036854775807n||Object.keys(decoded).sort().join(',')!=='at,id')throw Error();}catch(_){throw invalid();}}
      const result=await pool.query(`SELECT e.id::text,e.occurred_at::text AS cursor_at,e.occurred_at,e.reference_id,e.staff_id,o.display_name,e.actor_id,e.record_id,e.action,e.outcome FROM er_dispatch_audit_events e LEFT JOIN er_dispatch_owners o ON o.id=e.staff_id WHERE ($1::uuid IS NULL OR e.staff_id=$1) AND ($2::text IS NULL OR e.action=$2) AND ($3::date IS NULL OR e.occurred_at >= ($3::date::timestamp AT TIME ZONE 'America/New_York')) AND ($4::date IS NULL OR e.occurred_at < (($4::date+1)::timestamp AT TIME ZONE 'America/New_York')) AND ($5::timestamptz IS NULL OR (e.occurred_at,e.id)<($5::timestamptz,$6::bigint)) ORDER BY e.occurred_at DESC,e.id DESC LIMIT $7`,[staffId||null,action||null,from||null,to||null,decoded?.at||null,decoded?.id||null,limit+1]);
      const rows=result.rows.slice(0,limit),last=rows.at(-1);
      return {events:rows.map(r=>({id:r.id,timestamp:r.occurred_at.toISOString(),staffId:r.staff_id,staffName:r.display_name,actorId:r.actor_id,referenceId:r.reference_id,recordId:r.record_id,action:r.action,outcome:r.outcome})),nextCursor:result.rows.length>limit&&last?Buffer.from(JSON.stringify({at:last.cursor_at,id:last.id})).toString('base64url'):null,coverageStartedAt:(await pool.query('SELECT min(occurred_at) AS at FROM er_dispatch_audit_events')).rows[0].at?.toISOString()||null};
    })
  };
}
module.exports={dispatchAccessStorage,auditActions,auditOutcomes,IDLE_MS};
