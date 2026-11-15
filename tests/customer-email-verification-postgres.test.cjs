const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash,randomUUID}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {Pool}=require('pg');
const {createStore}=require('../storage/postgres');

const database=process.env.ER_TEST_DATABASE_URL;
const minute=60000;
const time=Date.parse('2026-11-01T15:00:00Z');
const hash=value=>createHash('sha256').update(value).digest('hex');
const session=(value,at=time)=>({hash:hash(value),created:new Date(at),expires:new Date(at+24*60*minute)});
const draft=(value,email,phone,displayEmail=email)=>({
  tokenHash:hash(value+'-token'),
  browserHash:hash(value+'-browser'),
  fullName:'Synthetic Customer',
  normalizedEmail:email,
  displayEmail,
  normalizedPhone:phone,
  passwordHash:'test-only-password-hash'
});

test('PostgreSQL enrollment migration and proofs preserve existing accounts and constrain new activation',{skip:!database},async t=>{
  const url=new URL(database);
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname));
  assert.ok(url.pathname.startsWith('/er_test_'));
  const admin=new Pool({connectionString:url.href});
  const schema='enrollment_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE SCHEMA '+schema);
  const settings={connectionString:url.href,options:'-c search_path='+schema};
  const pool=new Pool(settings),otherPool=new Pool(settings);
  const store=createStore({},pool),other=createStore({},otherPool);
  t.after(async()=>{
    await store.close();
    await other.close();
    await admin.query('DROP SCHEMA '+schema+' CASCADE');
    await admin.end();
  });

  const migrations=path.join(__dirname,'../migrations');
  for(const file of ['001-reservations.sql','003-customer-accounts.sql','006-customer-trips.sql']) {
    await pool.query(fs.readFileSync(path.join(migrations,file),'utf8'));
  }
  const legacyId=randomUUID(),legacySession=session('legacy-session');
  await pool.query(
    'INSERT INTO er_customers(id,full_name,normalized_email,display_email,normalized_phone,display_phone,password_hash) VALUES($1,$2,$3,$3,$4,$4,$5)',
    [legacyId,'Existing Customer','existing@example.test','+12025550100','synthetic-test-password-hash']
  );
  await pool.query(
    'INSERT INTO er_customer_sessions(token_hash,customer_id,created_at,expires_at,last_used_at) VALUES($1,$2,$3,$4,$3)',
    [legacySession.hash,legacyId,legacySession.created,legacySession.expires]
  );
  const legacyBooking=randomUUID();
  await pool.query(
    'INSERT INTO er_reservations(id,record,created_at,customer_id,scheduled_start_at,scheduled_end_at) VALUES($1,$2,$3,$4,$5,$5)',
    [legacyBooking,JSON.stringify({id:legacyBooking}),new Date(time),legacyId,new Date(time+minute)]
  );
  const legacyReservation=(await pool.query(
    'SELECT id,record,customer_id FROM er_reservations WHERE id=$1',[legacyBooking]
  )).rows[0];
  await Promise.all([store.migrate(),other.migrate()]);

  let registered;
  await t.test('pending proofs do not hold unique contacts, and concurrent confirmation creates exactly one linked account/session',async()=>{
    assert.deepEqual(await other.resolveCustomerSession(legacySession.hash,time),{
      id:legacyId,full_name:'Existing Customer',display_email:'existing@example.test',
      display_phone:'+12025550100',email_verified_at:null
    });
    const first=draft('concurrent-first','shared@example.test','+12025550101','Shared@Example.test');
    const second=draft('concurrent-second','shared@example.test','+12025550101','SHARED@EXAMPLE.test');
    assert.equal(await store.prepareEnrollment(first,hash('first-source'),time),first.displayEmail);
    assert.equal(await other.prepareEnrollment(second,hash('second-source'),time+minute),second.displayEmail);
    assert.equal((await pool.query('SELECT 1 FROM er_customer_enrollments WHERE normalized_email=$1',[first.normalizedEmail])).rowCount,2);
    assert.equal(await store.customerByEmail(first.normalizedEmail),null);
    assert.equal(await other.enrollmentForConfirmation(first.tokenHash,time+minute),null);
    await store.finishEnrollmentDelivery(first.tokenHash,true);
    await other.finishEnrollmentDelivery(second.tokenHash,true);
    assert.deepEqual(await other.enrollmentForConfirmation(first.tokenHash,time+minute),{
      browserHash:first.browserHash,passwordHash:first.passwordHash
    });
    assert.ok(await store.enrollmentForConfirmation(second.tokenHash,time+minute));
    const results=await Promise.all([
      store.activateEnrollment(first.tokenHash,session('first-activation'),time+minute),
      other.activateEnrollment(second.tokenHash,session('second-activation'),time+minute)
    ]);
    const winning=results[0]?.customer?0:1;
    registered={...results[winning].customer,session:session(winning===0?'first-activation':'second-activation')};
    assert.equal(registered.display_email,winning===0?first.displayEmail:second.displayEmail);
    assert.equal((await store.customerByEmail(first.normalizedEmail)).id,registered.id);
    assert.equal(registered.email_verified_at.toISOString(),new Date(time+minute).toISOString());
    assert.deepEqual(results[1-winning],{conflict:true});
    assert.equal(await store.activateEnrollment(first.tokenHash,session('replay'),time+minute),null);
    assert.equal((await pool.query('SELECT 1 FROM er_customer_enrollments WHERE normalized_email=$1',[first.normalizedEmail])).rowCount,0);
    assert.equal((await pool.query('SELECT 1 FROM er_customer_sessions WHERE customer_id=$1',[registered.id])).rowCount,1);
    assert.equal((await other.resolveCustomerSession(registered.session.hash,time+minute)).id,registered.id);
    assert.equal(await other.prepareEnrollment({...first,tokenHash:hash('new-ref')},hash('different-source'),time+2*minute),null);

    const duplicatePhone=draft('duplicate-phone','other@example.test',first.normalizedPhone);
    assert.equal(await store.prepareEnrollment(duplicatePhone,hash('different-source'),time+2*minute),duplicatePhone.normalizedEmail);
    await store.finishEnrollmentDelivery(duplicatePhone.tokenHash,true);
    assert.deepEqual(await other.activateEnrollment(duplicatePhone.tokenHash,session('duplicate-phone-activation'),time+2*minute),{conflict:true});
    assert.equal(await store.customerByEmail(duplicatePhone.normalizedEmail),null);
  });

  await t.test('expiry, delivery state, retry cap and sending limits are shared across database workers',async()=>{
    const current=draft('resend','resend@example.test','+12025550102','ReSend@Example.test');
    assert.equal(await store.prepareEnrollment(current,hash('shared-source'),time),current.displayEmail);
    await store.finishEnrollmentDelivery(current.tokenHash,false);
    assert.equal(await other.enrollmentForConfirmation(current.tokenHash,time),null);
    const secondToken=hash('resend-token-replacement');
    assert.equal(await store.resendEnrollment({browserHash:current.browserHash,tokenHash:secondToken},hash('shared-source'),time+minute-1),null);
    assert.equal(await other.resendEnrollment({browserHash:current.browserHash,tokenHash:secondToken},hash('shared-source'),time+minute),current.displayEmail);
    await store.finishEnrollmentDelivery(current.tokenHash,true);
    assert.equal(await other.enrollmentForConfirmation(current.tokenHash,time+minute),null);
    await other.finishEnrollmentDelivery(secondToken,true);
    const attempts=await Promise.all(Array.from({length:9},(_,index)=>(index%2?store:other).enrollmentForConfirmation(secondToken,time+minute)));
    assert.equal(attempts.filter(Boolean).length,8);
    const thirdToken=hash('resend-token-final');
    assert.equal(await store.resendEnrollment({browserHash:current.browserHash,tokenHash:thirdToken},hash('shared-source'),time+12*minute),current.displayEmail);
    await other.finishEnrollmentDelivery(thirdToken,true);
    assert.equal(await store.enrollmentForConfirmation(thirdToken,time+12*minute),null);
    assert.equal(await other.resendEnrollment({browserHash:current.browserHash,tokenHash:hash('resend-denied')},hash('shared-source'),time+13*minute),null);
    assert.equal(await store.activateEnrollment(thirdToken,session('expired-activation'),time+30*minute),null);

    const unused=hash('nonexistent-browser');
    const checks=Array.from({length:20},(_,index)=>({
      browserHash:unused,tokenHash:hash('deny-'+index)
    }));
    await Promise.all(checks.map((input,index)=>(index%2?store:other).resendEnrollment(input,hash('rate-denied-source'),time)));
    const blocked=draft('source','source@example.test','+12025550103');
    assert.equal(await other.prepareEnrollment(blocked,hash('rate-denied-source'),time),null);
    assert.equal(await store.prepareEnrollment(blocked,hash('rate-denied-source'),time+60*minute),blocked.normalizedEmail);
    assert.equal(await other.activateEnrollment(blocked.tokenHash,session('pending-activation'),time+60*minute),null);
  });

  await t.test('legacy verification checks current owner and mailbox and leaves reservations and payment mapping unchanged',async()=>{
    const tokenHash=hash('existing-verification');
    const mapping=await store.preparePaymentMapping(legacyId,legacySession.hash,time);
    assert.equal(await store.prepareExistingVerification({
      customerId:legacyId,sessionHash:legacySession.hash,tokenHash
    },hash('legacy-source'),time),'existing@example.test');
    await other.finishExistingVerificationDelivery(tokenHash,true);
    assert.equal(await other.activateExistingVerification({
      customerId:legacyId,sessionHash:registered.session.hash,tokenHash
    },time+minute),null);
    assert.equal(await other.activateExistingVerification({
      customerId:registered.id,sessionHash:registered.session.hash,tokenHash
    },time+minute),null);
    const existing=await store.customerByEmail('existing@example.test');
    const sameOwnerSession=session('existing-owner-second-session');
    assert.equal(await store.createCustomerSession(legacyId,sameOwnerSession,existing.password_hash),true);
    const verified=await other.activateExistingVerification({
      customerId:legacyId,sessionHash:sameOwnerSession.hash,tokenHash
    },time+minute);
    assert.equal(verified.id,legacyId);
    assert.equal(verified.email_verified_at.toISOString(),new Date(time+minute).toISOString());
    assert.equal((await store.resolveCustomerSession(legacySession.hash,time+minute)).id,legacyId);
    assert.deepEqual(await store.paymentMapping(legacyId),mapping);
    assert.deepEqual((await pool.query(
      'SELECT id,record,customer_id FROM er_reservations WHERE id=$1',[legacyBooking]
    )).rows[0],legacyReservation);
    assert.equal(await store.activateExistingVerification({
      customerId:legacyId,sessionHash:legacySession.hash,tokenHash
    },time+minute),null);
    assert.equal((await pool.query('SELECT 1 FROM er_customer_email_challenges WHERE customer_id=$1',[legacyId])).rowCount,0);
  });

  await t.test('indexed bounded cleanup removes expired pending records and rate counters',async()=>{
    const indexes=(await pool.query('SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname=ANY($2)',[schema,[
      'er_customer_enrollments_expiry','er_customer_email_challenges_expiry','er_customer_enrollment_limits_expiry'
    ]])).rows;
    assert.equal(indexes.length,3);
    await pool.query(
      'INSERT INTO er_customer_enrollments(browser_hash,token_hash,full_name,normalized_email,display_email,normalized_phone,password_hash,expires_at,draft_expires_at,delivery_state) '+
      "SELECT lpad(to_hex(n),64,'a'),lpad(to_hex(n),64,'b'),'Fixture','expired@example.test','expired@example.test','+12025550104','test-hash',$1,$1,'pending' FROM generate_series(1,101) n",
      [new Date(time-1)]
    );
    await other.cleanupEmailEnrollments(time);
    assert.equal((await pool.query("SELECT 1 FROM er_customer_enrollments WHERE normalized_email='expired@example.test'")).rowCount,1);
    await store.cleanupEmailEnrollments(time+2*60*minute);
    for(const table of ['er_customer_enrollments','er_customer_email_challenges','er_customer_enrollment_limits']) {
      assert.equal((await pool.query('SELECT 1 FROM '+table)).rowCount,0);
    }
    assert.equal((await store.resolveCustomerSession(legacySession.hash,time+2*60*minute)).id,legacyId);
    assert.equal((await store.resolveCustomerSession(registered.session.hash,time+2*60*minute)).id,registered.id);
  });
});
