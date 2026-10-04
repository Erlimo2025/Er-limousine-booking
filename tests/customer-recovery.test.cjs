const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module'),{Pool}=require('pg'),{createStore}=require('../storage/postgres');
const {hashToken,verifyPassword}=require('../auth/customers'),recovery=require('../auth/recovery');
const testPath=path.join(__dirname,'security-abuse.test.cjs'),source=fs.readFileSync(testPath,'utf8');
const {harness}=new Function('require','__dirname',source.slice(0,source.indexOf('test("approved prices'))+'\nreturn {harness};')(createRequire(testPath),__dirname);
const account={fullName:'Recovery Test',email:'recovery@example.test',phone:'2015550166',password:'Synthetic original passphrase'};
const newPassword='Synthetic replacement passphrase';
const cookies=r=>r.headers.getSetCookie().map(x=>x.split(';')[0]).filter(x=>!x.endsWith('=')).join('; ');
const challengeCookie=r=>r.headers.getSetCookie().find(x=>x.includes('er_customer_recovery='))?.split(';')[0];
const resetCookie=r=>r.headers.getSetCookie().find(x=>x.includes('er_customer_reset='))?.split(';')[0];
async function setup(t,store){const h=await harness(t,{CUSTOMER_SMS_RECOVERY_ENABLED:'true'},'[]',store);const registration=await h.request('/api/customer/register',account);assert.equal(registration.status,201);return {h,session:cookies(registration)};}
async function sent(h,phone=account.phone,headers={}){
 const result=await h.request('/api/customer/recovery/request',{phone},headers);
 for(let i=0;i<30;i++){if(h.state.smsMessages.length)break;await new Promise(r=>setImmediate(r));}
 return result;
}
async function verified(h,request){const code=h.state.smsMessages.at(-1).code;return h.request('/api/customer/recovery/verify',{code},{cookie:challengeCookie(request)});}
async function reset(h,grant,body={password:newPassword,confirmPassword:newPassword}){return h.request('/api/customer/recovery/reset',body,{cookie:resetCookie(grant)});}

test('recovery sends secure six-digit codes with generic known/unknown responses and no plaintext storage or leakage',async t=>{
 const {h}=await setup(t),known=await sent(h),unknown=await h.request('/api/customer/recovery/request',{phone:'2025550166'});
 assert.equal(known.status,200);assert.equal(unknown.status,200);assert.deepEqual(known.body,unknown.body);assert.equal(known.body.message,recovery.MESSAGE);
 assert.equal(h.state.smsMessages.length,1);const delivered=h.state.smsMessages[0];assert.match(delivered.code,/^\d{6}$/);assert.equal(delivered.phone,'+12015550166');
 const records=[...h.testStore.shared.recovery.values()];assert.equal(records.length,2);assert.ok(records.every(r=>/^[a-f0-9]{64}$/.test(r.code_verifier)));assert.ok(!JSON.stringify(records).includes(delivered.code));
 for(const r of [known,unknown]){assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('referrer-policy'),'no-referrer');assert.ok(!JSON.stringify(r.body).includes(delivered.code));assert.ok(!r.headers.get('set-cookie').includes(delivered.code));}
 assert.ok(!h.state.logs.join('').includes(delivered.code));assert.ok(!h.state.logs.join('').includes(account.phone));
});
test('valid verification authorizes reset; old password fails, new password succeeds and all sessions/challenges are revoked',async t=>{
 const {h,session}=await setup(t);const other=await h.request('/api/customer/login',{email:account.email,password:account.password});
 const req=await sent(h);h.advance(61000);const outstanding=await sent(h,account.phone,{cookie:challengeCookie(req)});
 const grant=await verified(h,outstanding);assert.equal(grant.status,200);assert.deepEqual(grant.body,{ok:true});
 const done=await reset(h,grant);assert.equal(done.status,200);assert.match(done.body.message,/Password updated/);assert.match(done.headers.get('set-cookie'),/er_customer_reset=;/);
 for(const cookie of [session,cookies(other)])assert.equal((await h.request('/api/customer/profile',undefined,{cookie})).status,401);
 assert.equal((await h.request('/api/customer/login',{email:account.email,password:account.password})).status,401);assert.equal((await h.request('/api/customer/login',{email:account.email,password:newPassword})).status,200);
 assert.equal((await verified(h,outstanding)).status,400);assert.equal((await reset(h,grant)).status,400);assert.ok([...h.testStore.shared.recovery.values()].every(r=>r.consumed_at));
 const c=[...h.testStore.shared.customers.values()][0];assert.ok(await verifyPassword(newPassword,c.password_hash));assert.ok(!c.password_hash.includes(newPassword));
});
test('wrong and malformed codes count toward a hard five-attempt challenge limit, including concurrent guesses',async t=>{
 const {h}=await setup(t),req=await sent(h),real=h.state.smsMessages[0].code;const wrong=real==='000000'?'111111':'000000';
 const attempts=await Promise.all([null,'letters',wrong,wrong,wrong,real].map(code=>h.request('/api/customer/recovery/verify',{code},{cookie:challengeCookie(req)})));
 assert.ok(attempts.every(r=>r.status===400));assert.equal([...h.testStore.shared.recovery.values()][0].failed_attempts,5);assert.equal((await verified(h,req)).status,400);
});
test('expired challenges and grants reject recovery without extending the original 10-minute deadline',async t=>{
 const {h}=await setup(t),req=await sent(h);h.advance(9*60000);const grant=await verified(h,req);assert.equal(grant.status,200);assert.match(grant.headers.get('set-cookie'),/Max-Age=60;/);
 h.advance(60001);assert.equal((await reset(h,grant)).status,400);assert.equal((await verified(h,req)).status,400);
});
test('code is single-use and verification cannot rotate a previously granted reset credential',async t=>{
 const {h}=await setup(t),req=await sent(h),grant=await verified(h,req);const again=await verified(h,req);assert.equal(again.status,400);assert.equal(again.headers.get('set-cookie'),null);assert.equal((await reset(h,grant)).status,200);
});
test('resend cooldown preserves the original browser challenge; phone limits survive normalized inputs and workers',async t=>{
 const {h}=await setup(t),req=await sent(h),second=await harness(t,{CUSTOMER_SMS_RECOVERY_ENABLED:'true'},'[]',h.testStore);
 const retry=await second.request('/api/customer/recovery/request',{phone:'+1 (201) 555-0166'},{cookie:challengeCookie(req)});assert.equal(retry.status,200);assert.equal(challengeCookie(retry),challengeCookie(req));assert.equal(second.state.smsMessages.length,0);
 h.advance(61000);second.advance(61000);await sent(h);h.advance(61000);await sent(h);assert.equal(h.state.smsMessages.length,2);
 assert.equal((await h.request('/api/customer/recovery/verify',{code:h.state.smsMessages[0].code},{cookie:challengeCookie(req)})).status,200);
});
test('persistent client request limits and HTTP IP limits prevent SMS spam without account enumeration',async t=>{
 const {h}=await setup(t);
 for(let i=0;i<22;i++) {h.advance(61000);const phone='202555'+String(1000+i);const r=await h.request('/api/customer/recovery/request',{phone});assert.equal(r.status,200);}
 const before=h.testStore.shared.recovery.size;h.advance(61000);await h.request('/api/customer/recovery/request',{phone:account.phone});assert.equal(h.testStore.shared.recovery.size,before);assert.equal(h.state.smsMessages.length,0);
 const rate=await harness(t,{CUSTOMER_SMS_RECOVERY_ENABLED:'true'});
 for(let i=0;i<5;i++)assert.equal((await rate.request('/api/customer/recovery/request',{phone:account.phone})).status,200);
 assert.equal((await rate.request('/api/customer/recovery/request',{phone:account.phone})).status,429);
});
test('concurrent send requests cannot bypass phone cooldown across storage instances',async t=>{
 const {h}=await setup(t),second=await harness(t,{CUSTOMER_SMS_RECOVERY_ENABLED:'true'},'[]',h.testStore);
 const responses=await Promise.all([sent(h),sent(second),sent(h)]);assert.ok(responses.every(r=>r.status===200));assert.equal(h.state.smsMessages.length+second.state.smsMessages.length,1);
});
test('unknown phones, forged challenge/grant cookies and browser-supplied account IDs never authorize reset',async t=>{
 const {h}=await setup(t),unknown=await sent(h,'2025550166');
 for(const cookie of ['', 'er_customer_recovery=malformed', 'er_customer_recovery='+'a'.repeat(43),challengeCookie(unknown)])assert.equal((await h.request('/api/customer/recovery/verify',{code:'000000',customerId:[...h.testStore.shared.customers.keys()][0]},{cookie})).status,400);
 assert.equal((await h.request('/api/customer/recovery/reset',{password:newPassword,confirmPassword:newPassword,verified:true,customerId:[...h.testStore.shared.customers.keys()][0]},{cookie:'er_customer_reset='+'a'.repeat(43)})).status,400);
 assert.equal((await h.request('/api/customer/login',{email:account.email,password:account.password})).status,200);
});
test('malformed phone/password/confirmation and cross-origin mutations reject safely',async t=>{
 const {h}=await setup(t);
 for(const phone of [null,[],{},'letters','1'.repeat(41)])assert.equal((await h.request('/api/customer/recovery/request',{phone})).status,400);
 h.advance(61000);const req=await sent(h),grant=await verified(h,req);
 for(const body of [{password:'short',confirmPassword:'short'},{password:newPassword,confirmPassword:'different'},{password:'x'.repeat(129),confirmPassword:'x'.repeat(129)}])assert.equal((await reset(h,grant,body)).status,400);
 assert.equal((await reset(h,grant)).status,200);
 for(const action of ['request','verify','reset'])assert.equal((await h.request('/api/customer/recovery/'+action,{phone:account.phone},{origin:'https://attacker.example.test'})).status,403);
});
test('mock provider failure is generic and never grants recovery or logs code/provider details',async t=>{
 const {h}=await setup(t);h.state.smsFail=true;const req=await sent(h);
 assert.equal(req.status,200);const r=[...h.testStore.shared.recovery.values()][0];assert.equal(r.delivery_state,'failed');assert.equal((await h.request('/api/customer/recovery/verify',{code:'000000'},{cookie:challengeCookie(req)})).status,400);
 assert.doesNotMatch(h.state.logs.join(''),/synthetic SMS secret marker|2015550166/);
});
test('disabled recovery and missing provider configuration fail closed, never selecting a live or console provider',async t=>{
 const disabled=await harness(t);assert.equal((await disabled.request('/api/customer/recovery/request',{phone:account.phone})).status,503);assert.equal(disabled.state.smsMessages.length,0);
 assert.throws(()=>require('../services/sms').createSmsProvider({enabled:true}),/unavailable/);
 const broken=await harness(t,{NODE_ENV:'production',SITE_URL:'https://er.example.test',CUSTOMER_SMS_RECOVERY_ENABLED:'true',TEST_RECOVERY_CONFIG_FAILURE:true});
 await new Promise(r=>setImmediate(r));assert.equal(broken.state.listenCalls||0,0);assert.equal((await broken.request('/api/customer/recovery/request',{phone:account.phone})).status,503);
});
test('production recovery cookies remain HttpOnly/Secure/Strict/restricted, while DB failures remain generic',async t=>{
 const h=await harness(t,{NODE_ENV:'production',SITE_URL:'https://er.example.test',CUSTOMER_SMS_RECOVERY_ENABLED:'true'});await h.request('/api/customer/register',account);const req=await sent(h);
 const header=req.headers.get('set-cookie');for(const p of [/__Secure-er_customer_recovery=/,/HttpOnly/,/Secure/,/SameSite=Strict/,/Path=\/api\/customer\/recovery/,/Max-Age=600/])assert.match(header,p);
 h.storageFailures.write=true;assert.equal((await h.request('/api/customer/recovery/request',{phone:account.phone})).status,503);
});
test('random code generation uses secure six-digit values and has no browser/debug provider implementation',()=>{
 const codes=Array.from({length:100},()=>recovery.randomCode());assert.ok(codes.every(code=>/^\d{6}$/.test(code)));assert.ok(new Set(codes).size>90);
 const provider=fs.readFileSync(path.join(__dirname,'../services/sms.js'),'utf8');assert.doesNotMatch(provider,/console\.|fetch\(|API_KEY|PASSWORD/);
 const frontend=fs.readFileSync(path.join(__dirname,'../public/account.js'),'utf8');assert.doesNotMatch(frontend,/localStorage|sessionStorage|innerHTML/);
});

test('PostgreSQL recovery transactions: concurrent send/verify/reset, rollback, stale login and multi-worker revocation',{skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
 const url=new URL(process.env.ER_TEST_DATABASE_URL);assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname.startsWith('/er_test_'));
 const admin=new Pool({connectionString:url.toString()}),schema='recovery_test_'+crypto.randomBytes(8).toString('hex');await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:url.toString(),options:'-c search_path='+schema}),p2=new Pool({connectionString:url.toString(),options:'-c search_path='+schema});const a=createStore({},pool),b=createStore({},p2);
 t.after(async()=>{await a.close();await b.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});await Promise.all([a.migrate(),b.migrate()]);
 const {h,session}=await setup(t,a),h2=await harness(t,{CUSTOMER_SMS_RECOVERY_ENABLED:'true'},'[]',b);
 const responses=await Promise.all([sent(h),sent(h2)]);assert.equal(h.state.smsMessages.length+h2.state.smsMessages.length,1);const winner=h.state.smsMessages.length?h:h2,req=responses[h.state.smsMessages.length?0:1];
 for(let i=0;i<30;i++){const state=(await pool.query('SELECT delivery_state FROM er_customer_recovery')).rows[0];if(state.delivery_state==='sent')break;await new Promise(r=>setTimeout(r,5));}
 const raw=challengeCookie(req).split('=')[1],real=winner.state.smsMessages[0].code,r=(await pool.query('SELECT * FROM er_customer_recovery')).rows[0];assert.equal(r.code_verifier,recovery.verifier(raw,real));assert.ok(!JSON.stringify(r).includes(real));
 const wrong=real==='000000'?'111111':'000000';
 await Promise.all(Array.from({length:8},()=>b.verifyRecovery(r.challenge_hash,recovery.verifier(raw,wrong),hashToken(crypto.randomBytes(32).toString('base64url')),Date.parse('2026-10-01T16:00:00Z'))));
 assert.equal((await pool.query('SELECT failed_attempts FROM er_customer_recovery')).rows[0].failed_attempts,5);
 // Advance past cooldown and request another challenge without changing the customer trip/account state.
 h.advance(61000);h2.advance(61000);const req2=await sent(h);for(let i=0;i<30;i++){if((await pool.query('SELECT delivery_state FROM er_customer_recovery WHERE challenge_hash=$1',[hashToken(challengeCookie(req2).split('=')[1])])).rows[0].delivery_state==='sent')break;await new Promise(r=>setTimeout(r,5));}
 const grant=await verified(h,req2);assert.equal(grant.status,200);const original=(await pool.query('SELECT * FROM er_customers')).rows[0];
 // Force a transactional failure after password update: sessions remain and password rolls back.
 const key=hashToken(resetCookie(grant).split('=')[1]);
 await pool.query("CREATE FUNCTION reject_test_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback'; END $$; CREATE TRIGGER reject_test_session_delete BEFORE DELETE ON er_customer_sessions FOR EACH ROW EXECUTE FUNCTION reject_test_session_delete()");
 await assert.rejects(a.resetCustomerPassword(key,'synthetic replacement hash',Date.parse('2026-10-01T16:01:01Z')));
 assert.equal((await a.customerByEmail(original.normalized_email)).password_hash,original.password_hash);
 assert.equal(await a.recoveryGrant(key,Date.parse('2026-10-01T16:01:01Z')),true);
 await pool.query('DROP TRIGGER reject_test_session_delete ON er_customer_sessions; DROP FUNCTION reject_test_session_delete()');
 assert.equal((await h.request('/api/customer/profile',undefined,{cookie:session})).status,200);
 const results=await Promise.all([reset(h,grant),reset(h2,grant)]);assert.deepEqual(results.map(x=>x.status).sort(),[200,400]);assert.equal((await h2.request('/api/customer/profile',undefined,{cookie:session})).status,401);
 assert.ok((await pool.query('SELECT consumed_at FROM er_customer_recovery WHERE customer_id=$1',[original.id])).rows.every(r=>r.consumed_at));
 const stale={hash:hashToken('stale synthetic session'),created:new Date(),expires:new Date(Date.now()+60000)};assert.equal(await b.createCustomerSession(original.id,stale,original.password_hash),false);
 assert.equal((await h2.request('/api/customer/login',{email:account.email,password:account.password})).status,401);assert.equal((await h2.request('/api/customer/login',{email:account.email,password:newPassword})).status,200);
});
