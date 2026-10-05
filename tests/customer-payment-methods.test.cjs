const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module'),{Pool}=require('pg');
const {createStore}=require('../storage/postgres'),{hashToken}=require('../auth/customers');
const {stripePaymentProvider}=require('../services/customer-payments');
const testPath=path.join(__dirname,'security-abuse.test.cjs'),source=fs.readFileSync(testPath,'utf8');
const {harness,booking}=new Function('require','__dirname',source.slice(0,source.indexOf('test("approved prices'))+'\nreturn {harness,booking};')(createRequire(testPath),__dirname);
const base='/api/customer/payment-methods',enabled={CUSTOMER_PAYMENT_METHODS_ENABLED:'true'};
const account={fullName:'Saved Card Test',email:'saved@example.test',phone:'2025550137',password:'Synthetic saved card passphrase'};
const cookie=r=>r.headers.getSetCookie().find(x=>x.includes('er_customer_session='))?.split(';')[0];
async function setup(t,env=enabled,store){const h=await harness(t,env,'[]',store),r=await h.request('/api/customer/register',account);assert.equal(r.status,201);return {h,headers:{cookie:cookie(r),origin:env.SITE_URL || 'http://localhost:3000','sec-fetch-site':'same-origin'}};}
const start=(h,headers,body={consent:true})=>h.request(base+'/setup',body,headers);
const verify=(h,headers,id,body={})=>h.request(base+'/setup/'+id+'/verify',body,headers);
const remove=(h,headers,id)=>h.request(base+'/'+id,{},headers,'DELETE');
function complete(h,attempt){const a=h.testStore.shared.paymentSetups.get(attempt),si=h.state.payments.setups.get(a.stripe_setup_id);const pm={id:'pm_saved'+(h.state.payments.cards.size+1),type:'card',customer:si.customer,livemode:false,card:{brand:'visa',last4:'4242',exp_month:3,exp_year:2030,fingerprint:'synthetic_private_fingerprint'},billing_details:{address:{line1:'synthetic_private_address'}},metadata:{private:'synthetic_private_metadata'}};h.state.payments.cards.set(pm.id,pm);si.status='succeeded';si.payment_method=pm.id;return {a,si,pm};}
const databaseState=h=>JSON.stringify({mappings:[...h.testStore.shared.paymentMappings.values()],setups:[...h.testStore.shared.paymentSetups.values()]});

test('saved-card feature defaults disabled and never changes booking Checkout',async t=>{
 const {h,headers}=await setup(t,{});for(const [url,body,method]of [[base,undefined,'GET'],[base+'/setup',{consent:true},'POST'],[base+'/setup/'+crypto.randomUUID()+'/verify',{},'POST'],[base+'/pm_foreign',{},'DELETE']]){const r=await h.request(url,body,headers,method);assert.equal(r.status,503);assert.equal(r.headers.get('cache-control'),'no-store');}
 assert.equal(h.state.payments.calls.length,0);assert.equal(h.testStore.shared.paymentMappings.size,0);
 const out=await h.request('/api/checkout',booking);assert.equal(out.status,200);assert.ok(!Object.hasOwn(h.state.creates[0].params,'customer'));assert.equal(h.state.creates[0].params.customer_email,booking.email);
});

test('every saved-card API rejects missing, invalid, revoked, expired and disabled sessions',async t=>{
 for(const kind of ['missing','invalid','revoked','expired','disabled']){
  const {h,headers}=await setup(t);const owner=[...h.testStore.shared.customers.keys()][0];
  if(kind==='missing')delete headers.cookie;if(kind==='invalid')headers.cookie='er_customer_session=invalid';if(kind==='revoked')h.testStore.shared.customerSessions.clear();if(kind==='expired')h.advance(31*86400000);if(kind==='disabled')h.testStore.shared.customers.get(owner).account_status='disabled';
  for(const [url,body,method]of [[base,undefined,'GET'],[base+'/setup',{consent:true},'POST'],[base+'/setup/'+crypto.randomUUID()+'/verify',{},'POST'],[base+'/pm_foreign',{},'DELETE']])assert.equal((await h.request(url,body,headers,method)).status,401);
  assert.equal(h.state.payments.calls.length,0);
 }
});

test('strict consent and request allowlists reject browser ownership, card data and forged success',async t=>{
 const {h,headers}=await setup(t);
 for(const body of [{},{consent:false},{consent:'true'},{consent:1},{consent:true,customer:'cus_foreign'},{consent:true,card:'synthetic'},{consent:true,customer_id:crypto.randomUUID()},{consent:true,clientSecret:'synthetic'},[]])assert.equal((await start(h,headers,body)).status,400);
 const out=await start(h,headers);assert.equal(out.status,200);assert.equal((await verify(h,headers,out.body.attempt,{succeeded:true})).status,400);assert.equal((await h.request(base+'/pm_foreign',{customer:'cus_foreign'},headers,'DELETE')).status,400);assert.equal((await h.request(base+'?customer=cus_foreign',undefined,headers)).status,400);
});

test('saved-card mutations require canonical Origin, JSON and safe Fetch Metadata',async t=>{
 const {h,headers}=await setup(t);
 for(const change of [{origin:'https://attacker.example.test'},{origin:''},{'sec-fetch-site':'cross-site'},{'sec-fetch-site':'same-site'},{'content-type':'text/plain'}]){
  assert.equal((await start(h,{...headers,...change})).status,403);
  assert.equal((await verify(h,{...headers,...change},crypto.randomUUID())).status,403);
  assert.equal((await remove(h,{...headers,...change},'pm_foreign')).status,403);
 }
 assert.equal(h.state.payments.calls.length,0);
});

test('enabled missing Stripe and invalid production canonical configuration fail closed',async t=>{
 for(const env of [{...enabled,STRIPE_SECRET_KEY:''},{...enabled,NODE_ENV:'production',SITE_URL:'http://localhost:3000'},{...enabled,NODE_ENV:'production',SITE_URL:'https://example.test/?private=1'}]){
  const {h,headers}=await setup(t,env);assert.equal((await start(h,headers)).status,503);assert.equal(h.state.payments?.calls.length || 0,0);
 }
});

test('lazy provisioning and setup are server-owned, card-only, on-session, reusable and hash-free of client secrets',async t=>{
 const {h,headers}=await setup(t);assert.deepEqual((await h.request(base,undefined,headers)).body,[]);assert.equal(h.state.payments.calls.length,0);
 const first=await start(h,headers),second=await start(h,headers);assert.equal(first.status,200);assert.deepEqual(first.body,second.body);assert.deepEqual(Object.keys(first.body).sort(),['attempt','clientSecret']);assert.match(first.body.attempt,/^[a-f0-9-]{36}$/);
 const calls=h.state.payments.calls,create=calls.find(c=>c.op==='createSetup'),mapping=[...h.testStore.shared.paymentMappings.values()][0];
 assert.equal(create.params.customer,mapping.stripe_customer_id);assert.deepEqual(create.params.payment_method_types,['card']);assert.equal(create.params.usage,'on_session');assert.equal(calls.filter(c=>c.op==='createCustomer').length,1);assert.equal(calls.filter(c=>c.op==='createSetup').length,1);assert.ok(calls.every(c=>c.options.timeout===8000&&c.options.maxNetworkRetries===0));
 const stored=databaseState(h);assert.ok(!stored.includes(first.body.clientSecret));assert.doesNotMatch(stored,/client_secret|fingerprint|billing_details|last4/);assert.ok(!h.state.logs.join('').includes(first.body.clientSecret));assert.equal(first.headers.get('cache-control'),'no-store');assert.equal(first.headers.get('referrer-policy'),'no-referrer');
});

test('concurrent setup/provisioning is serialized; one Stripe Customer and active attempt remain',async t=>{
 const {h,headers}=await setup(t);h.state.payments.delay=30;
 const results=await Promise.all([start(h,headers),start(h,headers)]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);assert.equal(h.state.payments.customers.size,1);assert.equal(h.state.payments.setups.size,1);assert.equal(h.testStore.shared.paymentSetups.size,1);
 assert.equal((await start(h,headers)).status,200);assert.equal(h.state.payments.customers.size,1);
});

test('lost Customer and SetupIntent responses retry immutable provider idempotency identities without duplicates',async t=>{
 for(const loss of ['loseCustomer','loseSetup']){
  const {h,headers}=await setup(t);h.state.payments[loss]=true;assert.equal((await start(h,headers)).status,503);
  const state=databaseState(h),r=await start(h,headers);assert.equal(r.status,200);assert.equal(h.state.payments.customers.size,1);assert.equal(h.state.payments.setups.size,1);
  const op=loss==='loseCustomer'?'createCustomer':'createSetup',calls=h.state.payments.calls.filter(x=>x.op===op);assert.equal(calls.length,2);assert.deepEqual(calls[0].params,calls[1].params);assert.equal(calls[0].options.idempotencyKey,calls[1].options.idempotencyKey);assert.match(state,/submitted_unknown/);
 }
});

test('database failure after provider creation preserves retry authority and never stores the client secret',async t=>{
 for(const failure of ['paymentMappingSave','paymentSetupSave']){
  const {h,headers}=await setup(t);h.storageFailures[failure]=true;assert.equal((await start(h,headers)).status,503);assert.match(databaseState(h),/submitted_unknown/);h.storageFailures[failure]=false;
  assert.equal((await start(h,headers)).status,200);assert.equal(h.state.payments.customers.size,1);assert.equal(h.state.payments.setups.size,1);assert.doesNotMatch(databaseState(h),/_secret_/);
 }
});

test('aged unknown provisioning/setup enters review rather than blindly creating new provider objects',async t=>{
 for(const loss of ['loseCustomer','loseSetup']){
  const {h,headers}=await setup(t);h.state.payments[loss]=true;assert.equal((await start(h,headers)).status,503);h.advance(23*3600000);
  const calls=h.state.payments.calls.length;assert.equal((await start(h,headers)).status,503);assert.equal(h.state.payments.calls.length,calls);assert.match(databaseState(h),/review_required/);assert.equal((await start(h,headers)).status,503);assert.equal(h.state.payments.calls.length,calls);
 }
});

test('setup verification is provider-authoritative, owner-scoped and rejects incomplete/failed states',async t=>{
 const {h,headers}=await setup(t),out=await start(h,headers);
 for(const status of ['requires_payment_method','requires_action','processing','canceled']){h.state.payments.setups.values().next().value.status=status;assert.equal((await verify(h,headers,out.body.attempt)).status,409);}
 const {pm}=complete(h,out.body.attempt);assert.equal((await verify(h,headers,out.body.attempt)).status,200);assert.equal((await verify(h,headers,out.body.attempt)).status,200);assert.equal(h.testStore.shared.paymentSetups.get(out.body.attempt).state,'succeeded');
 const list=await h.request(base,undefined,headers);assert.equal(list.status,200);assert.deepEqual(list.body,[{id:pm.id,brand:'visa',last4:'4242',expMonth:3,expYear:2030}]);assert.doesNotMatch(JSON.stringify(list.body),/cus_|fingerprint|billing|metadata|livemode|funding|network/);
});

test('cross-account/nonexistent/forged attempts are equivalent and never expose Stripe IDs',async t=>{
 const {h,headers}=await setup(t),out=await start(h,headers),b=await h.request('/api/customer/register',{...account,email:'other@example.test',phone:'2035550137'}),foreign={...headers,cookie:cookie(b)};
 for(const id of [out.body.attempt,crypto.randomUUID(),'forged','seti_saved1']){const r=await verify(h,foreign,id);assert.equal(r.status,404);assert.equal(r.body.error,'Payment method setup unavailable.');assert.deepEqual(Object.keys(r.body).sort(),['error','referenceId']);}
 assert.equal(h.state.payments.calls.filter(c=>c.op==='retrieveSetup').length,0);assert.deepEqual((await h.request(base,undefined,foreign)).body,[]);
});

test('SetupIntent/customer/card association, type, live mode and returned identity must all match',async t=>{
 for(const change of [{customer:'cus_foreign'},{id:'seti_foreign'},{livemode:true},{usage:'off_session'},{payment_method_types:['card','other']},{metadata:{setupReference:crypto.randomUUID()}}]){
  const {h,headers}=await setup(t),out=await start(h,headers),{si}=complete(h,out.body.attempt);Object.assign(si,change);assert.equal((await verify(h,headers,out.body.attempt)).status,503);
 }
 for(const change of [{customer:'cus_foreign'},{type:'us_bank_account'},{livemode:true}]){const {h,headers}=await setup(t),out=await start(h,headers),{pm}=complete(h,out.body.attempt);Object.assign(pm,change);assert.equal((await verify(h,headers,out.body.attempt)).status,503);}
});

test('ownership is checked before detach; foreign, missing and repeated removal are safe equivalent no-ops',async t=>{
 const {h,headers}=await setup(t),out=await start(h,headers),{pm}=complete(h,out.body.attempt);await verify(h,headers,out.body.attempt);
 const b=await h.request('/api/customer/register',{...account,email:'other@example.test',phone:'2035550137'}),other={...headers,cookie:cookie(b)};await start(h,other);
 const foreign=await remove(h,other,pm.id),missing=await remove(h,other,'pm_nonexistent');assert.equal(foreign.status,200);assert.deepEqual(foreign.body,missing.body);assert.equal(h.state.payments.calls.filter(c=>c.op==='detach').length,0);
 assert.equal((await remove(h,headers,pm.id)).status,200);assert.equal((await remove(h,headers,pm.id)).status,200);assert.equal(h.state.payments.calls.filter(c=>c.op==='detach').length,1);assert.equal(pm.customer,null);assert.deepEqual((await h.request(base,undefined,headers)).body,[]);
 assert.equal((await remove(h,headers,'invalid')).status,400);
});

test('list pagination is bounded, owner-scoped and rejects foreign cursor/provider data',async t=>{
 const {h,headers}=await setup(t),out=await start(h,headers),{pm}=complete(h,out.body.attempt);
 for(let i=0;i<22;i++)h.state.payments.cards.set('pm_page'+i,{...pm,id:'pm_page'+i});const first=await h.request(base,undefined,headers);assert.equal(first.body.length,20);const next=first.headers.get('x-payment-methods-next');assert.ok(next);const second=await h.request(base+'?cursor='+next,undefined,headers);assert.equal(second.body.length,3);
 for(const query of ['limit=0','limit=51','limit=1.5','limit=1&limit=2','cursor=invalid','cursor=pm_foreign'])assert.equal((await h.request(base+'?'+query,undefined,headers)).status,400);
 h.state.payments.listResult={data:[{...pm,customer:'cus_foreign'}],has_more:false};assert.equal((await h.request(base,undefined,headers)).status,503);
});

test('completed setup cooldown and expiry keep at most one active attempt; processing is never replaced',async t=>{
 const {h,headers}=await setup(t),out=await start(h,headers);complete(h,out.body.attempt);await verify(h,headers,out.body.attempt);assert.equal((await start(h,headers)).status,429);h.advance(60001);const next=await start(h,headers);assert.equal(next.status,200);assert.notEqual(next.body.attempt,out.body.attempt);
 h.advance(30*60000);assert.equal((await start(h,headers)).status,200);assert.equal(h.state.payments.calls.filter(x=>x.op==='cancelSetup').length,1);assert.equal((await start(h,headers)).status,200);
 const active=[...h.testStore.shared.paymentSetups.values()].find(x=>x.state==='identified');h.state.payments.setups.get(active.stripe_setup_id).status='processing';h.advance(30*60000);assert.equal((await start(h,headers)).status,409);assert.equal(h.state.payments.setups.size,3);
});

test('completed card detached before verification retires stale attempt and permits a new setup without duplicate Customers',async t=>{
 const {h,headers}=await setup(t),first=await start(h,headers),{pm}=complete(h,first.body.attempt);
 assert.equal((await remove(h,headers,pm.id)).status,200);assert.deepEqual((await h.request(base,undefined,headers)).body,[]);
 assert.equal((await verify(h,headers,first.body.attempt)).status,503);h.advance(30*60000);
 const next=await start(h,headers);assert.equal(next.status,200);assert.notEqual(next.body.attempt,first.body.attempt);
 assert.equal(h.testStore.shared.paymentSetups.get(first.body.attempt).state,'cancelled');assert.equal((await verify(h,headers,first.body.attempt)).status,404);
 assert.equal(h.state.payments.customers.size,1);assert.equal(h.state.payments.calls.filter(x=>x.op==='createCustomer').length,1);
});

test('expired pending, provider-completed and provider-cancelled attempts reconcile before replacement; ambiguous cancellation stays blocked',async t=>{
 for(const status of ['requires_payment_method','succeeded','canceled']){
  const {h,headers}=await setup(t),first=await start(h,headers);if(status==='succeeded')complete(h,first.body.attempt);else h.state.payments.setups.values().next().value.status=status;
  h.advance(30*60000);const next=await start(h,headers);assert.equal(next.status,200);assert.notEqual(next.body.attempt,first.body.attempt);
  assert.equal(h.testStore.shared.paymentSetups.get(first.body.attempt).state,status==='succeeded'?'succeeded':'cancelled');assert.equal(h.state.payments.customers.size,1);
 }
 const {h,headers}=await setup(t),first=await start(h,headers);h.advance(30*60000);h.state.payments.fail='cancelSetup';assert.equal((await start(h,headers)).status,503);assert.equal(h.testStore.shared.paymentSetups.get(first.body.attempt).state,'identified');assert.equal(h.state.payments.setups.size,1);
 h.state.payments.fail=null;assert.equal((await start(h,headers)).status,200);
});

test('expired payment limits are cleaned in bounded time-gated batches, never deleting live counters',async t=>{
 const {h}=await setup(t),shared=h.testStore.shared,now=Date.parse('2026-10-01T16:00:00Z'),owner=crypto.randomUUID();
 for(let i=0;i<205;i++)shared.paymentLimits.set('expired'+i,{attempts:1,reset:now-1});shared.paymentLimits.set('live',{attempts:19,reset:now+900000});
 await h.testStore.paymentLimit(owner,'cleanup-client','setup',now);assert.equal([...shared.paymentLimits.keys()].filter(x=>x.startsWith('expired')).length,105);
 await h.testStore.paymentLimit(owner,'cleanup-client','setup',now);assert.equal([...shared.paymentLimits.keys()].filter(x=>x.startsWith('expired')).length,105);
 await h.testStore.paymentLimit(owner,'cleanup-client','setup',now+30000);assert.equal([...shared.paymentLimits.keys()].filter(x=>x.startsWith('expired')).length,5);
 await h.testStore.paymentLimit(owner,'cleanup-client','setup',now+60000);assert.equal([...shared.paymentLimits.keys()].filter(x=>x.startsWith('expired')).length,0);assert.ok(shared.paymentLimits.has('live'));
 for(let i=0;i<16;i++)assert.equal(await h.testStore.paymentLimit(owner,'cleanup-client','setup',now+60000),true);assert.equal(await h.testStore.paymentLimit(owner,'cleanup-client','setup',now+60000),false);
});

test('stale lifecycle reconciliation still rejects foreign SetupIntent identity before replacing anything',async t=>{
 const {h,headers}=await setup(t),first=await start(h,headers),{si}=complete(h,first.body.attempt);si.customer='cus_foreign';h.advance(30*60000);
 assert.equal((await start(h,headers)).status,503);assert.equal(h.testStore.shared.paymentSetups.get(first.body.attempt).state,'identified');assert.equal(h.state.payments.setups.size,1);assert.equal(h.state.payments.calls.filter(x=>x.op==='ownedCard').length,0);
});

test('shared customer limits protect all operations across workers and client limits span accounts',async t=>{
 const {h,headers}=await setup(t),other=await harness(t,enabled,'[]',h.testStore);other.state.payments=h.state.payments;
 for(const [operation,path,body,method,max]of [['setup',base+'/setup',{consent:true},'POST',20],['verify',base+'/setup/'+crypto.randomUUID()+'/verify',{},'POST',30],['list',base,undefined,'GET',60],['remove',base+'/pm_missing',{},'DELETE',20]]){
  for(let i=0;i<max;i++){const r=await (i%2?other:h).request(path,body,headers,method);assert.notEqual(r.status,429,operation);}
  assert.equal((await other.request(path,body,headers,method)).status,429,operation);
 }
 const owner=[...h.testStore.shared.customers.keys()][0],now=Date.parse('2026-10-01T16:00:00Z');let last;for(let i=0;i<41;i++)last=await h.testStore.paymentLimit(crypto.randomUUID(),'shared-client','setup',now);assert.equal(last,false);assert.equal(await h.testStore.paymentLimit(owner,'new-client','list',now+60001),true);
});

test('provider failures never leak secrets, card data, raw errors or request/customer details',async t=>{
 const {h,headers}=await setup(t),out=await start(h,headers),{pm}=complete(h,out.body.attempt);
 for(const op of ['retrieveSetup','listCards','ownedCard','detach']){
  h.state.payments.fail=op;const r=op==='retrieveSetup'?await verify(h,headers,out.body.attempt):op==='listCards'?await h.request(base,undefined,headers):await remove(h,headers,pm.id);assert.equal(r.status,503);assert.ok(r.body.error.includes(r.body.referenceId || r.headers.get('x-request-id')));
 }
 h.state.payments.fail=null;const logs=h.state.logs.join(' ');for(const marker of [out.body.clientSecret,pm.id,pm.customer,pm.card.last4,pm.card.fingerprint,account.email,account.phone,'synthetic private provider message','mock-google-key'])assert.ok(!logs.includes(marker),marker);
 assert.equal(h.state.creates.length,0);assert.equal(h.records().length,0);
});

test('session revoked while provider request is pending cannot receive a setup secret or persist mapping ownership',async t=>{
 const {h,headers}=await setup(t);h.state.payments.onCall=async op=>{if(op==='createCustomer')h.testStore.shared.customerSessions.clear();};const r=await start(h,headers);assert.equal(r.status,401);assert.ok(!Object.hasOwn(r.body,'clientSecret'));assert.equal([...h.testStore.shared.paymentMappings.values()][0].stripe_customer_id,null);
});

test('Stripe adapter bounds timeouts and sanitizes timeout/network errors without output',async()=>{
 const provider=stripePaymentProvider({customers:{create:async()=>{throw Object.assign(new Error('synthetic-private-secret'),{type:'StripeConnectionError'});}}});await assert.rejects(provider.createCustomer(crypto.randomUUID()),error=>error.paymentFailure && error.status===503 && !error.message.includes('synthetic-private'));
});

test('cleanup failure is isolated from counters, preserves limits and retries only after its gate',async()=>{
 const {customerPaymentStorage}=require('../storage/customer-payments');let cleanupCalls=0,mainCalls=0,failCleanup=true,failMain=false;
 const counters=new Map();const store=customerPaymentStorage({},async fn=>fn({query:async(sql,params)=>{
  if(sql.startsWith('WITH expired')){cleanupCalls++;if(failCleanup)throw new Error('synthetic private maintenance error');return {rows:[]};}
  mainCalls++;if(failMain)throw new Error('synthetic private main failure');const value=(counters.get(params[0])||0)+1;counters.set(params[0],value);return {rows:[{attempts:value}]};
 }}),fn=>fn());
 for(let i=0;i<20;i++)assert.equal(await store.paymentLimit('owner','client','setup',100000),true);
 assert.equal(cleanupCalls,1);assert.equal(mainCalls,40);assert.equal(await store.paymentLimit('owner','client','setup',100000),false);
 assert.equal(await store.paymentLimit('owner','client','setup',130000),false);assert.equal(cleanupCalls,2);
 failCleanup=false;assert.equal(await store.paymentLimit('owner','client','setup',160000),false);assert.equal(cleanupCalls,3);
 failMain=true;await assert.rejects(store.paymentLimit('owner','client','setup',160000),/synthetic private main failure/);
});

test('PostgreSQL cleanup faults do not fail requests or bypass counters; later cleanup retries and main faults still fail closed',{skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
 const u=new URL(process.env.ER_TEST_DATABASE_URL);assert.ok(['127.0.0.1','localhost'].includes(u.hostname));assert.ok(u.pathname.startsWith('/er_test_'));
 const admin=new Pool({connectionString:u.toString()}),schema='cards_cleanup_'+crypto.randomBytes(8).toString('hex');await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:u.toString(),options:'-c search_path='+schema}),store=createStore({},pool);
 t.after(async()=>{await store.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});await store.migrate();
 const {h,headers}=await setup(t,enabled,store),now=Date.parse('2026-10-01T16:00:00Z');
 const expired=crypto.createHash('sha256').update('expired-fixture').digest('hex'),live=crypto.createHash('sha256').update('live-fixture').digest('hex');
 await pool.query('INSERT INTO er_customer_payment_limits VALUES($1,7,$3),($2,19,$4)',[expired,live,new Date(now-1),new Date(now+900000)]);
 await pool.query('CREATE SEQUENCE cleanup_attempts');
 await pool.query("CREATE FUNCTION reject_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('cleanup_attempts'); RAISE EXCEPTION 'synthetic private cleanup payload'; END $$");
 await pool.query('CREATE TRIGGER reject_cleanup BEFORE DELETE ON er_customer_payment_limits FOR EACH ROW EXECUTE FUNCTION reject_cleanup()');
 assert.equal((await h.request(base,undefined,headers)).status,200);
 for(let i=0;i<20;i++)assert.equal((await remove(h,headers,'pm_missing')).status,200);
 assert.equal((await remove(h,headers,'pm_missing')).status,429);assert.equal((await pool.query('SELECT last_value FROM cleanup_attempts')).rows[0].last_value,'1');
 let rows=(await pool.query('SELECT identity_hash,attempts FROM er_customer_payment_limits WHERE identity_hash=ANY($1)',[[expired,live]])).rows;assert.equal(rows.length,2);assert.equal(rows.find(x=>x.identity_hash===live).attempts,19);
 h.advance(30000);assert.equal((await remove(h,headers,'pm_missing')).status,429);assert.equal((await pool.query('SELECT last_value FROM cleanup_attempts')).rows[0].last_value,'2');
 await pool.query('DROP TRIGGER reject_cleanup ON er_customer_payment_limits');h.advance(30000);assert.equal((await h.request(base,undefined,headers)).status,200);
 assert.equal((await pool.query('SELECT 1 FROM er_customer_payment_limits WHERE identity_hash=$1',[expired])).rowCount,0);assert.equal((await pool.query('SELECT attempts FROM er_customer_payment_limits WHERE identity_hash=$1',[live])).rows[0].attempts,19);
 await pool.query("CREATE FUNCTION reject_counter() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic private counter payload'; END $$");await pool.query('CREATE TRIGGER reject_counter BEFORE INSERT OR UPDATE ON er_customer_payment_limits FOR EACH ROW EXECUTE FUNCTION reject_counter()');
 assert.equal((await h.request(base,undefined,headers)).status,503);
 const logs=h.state.logs.join(' ');for(const marker of ['synthetic private cleanup payload','synthetic private counter payload',expired,live,account.email,account.phone,headers.cookie])assert.ok(!logs.includes(marker));assert.equal(h.state.payments.calls.length,0);
});

test('PostgreSQL saved cards: migrations, competing workers, persistent retries, ownership, shared limits and rollback',{skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
 const u=new URL(process.env.ER_TEST_DATABASE_URL);assert.ok(['127.0.0.1','localhost'].includes(u.hostname));assert.ok(u.pathname.startsWith('/er_test_'));
 const admin=new Pool({connectionString:u.toString()}),schema='cards_test_'+crypto.randomBytes(8).toString('hex');await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:u.toString(),options:'-c search_path='+schema,application_name:schema}),pool2=new Pool({connectionString:u.toString(),options:'-c search_path='+schema,application_name:schema});const store=createStore({},pool),second=createStore({},pool2);
 t.after(async()=>{await store.close();await second.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});await store.migrate();await Promise.all([store.migrate(),second.migrate()]);
 const {h,headers}=await setup(t,enabled,store),worker=await harness(t,enabled,'[]',second);worker.state.payments=h.state.payments;
 let networkChecks=0;h.state.payments.onCall=async()=>{const open=await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid() AND xact_start IS NOT NULL",[schema]);assert.equal(open.rowCount,0,'Stripe network calls must occur outside database transactions');networkChecks++;};
 h.state.payments.delay=30;const results=await Promise.all([start(h,headers),start(worker,headers)]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);h.state.payments.delay=0;assert.equal(h.state.payments.customers.size,1);
 let rows=(await pool.query('SELECT * FROM er_customer_payment_mappings')).rows;assert.equal(rows.length,1);const owner=rows[0].customer_id;let attempts=(await pool.query('SELECT * FROM er_customer_payment_setups')).rows;assert.equal(attempts.length,1);
 assert.equal((await start(worker,headers)).status,200);assert.equal(h.state.payments.setups.size,1);const a=attempts[0],si=h.state.payments.setups.get(a.stripe_setup_id),pm={id:'pm_pgowned',type:'card',customer:rows[0].stripe_customer_id,livemode:false,card:{brand:'visa',last4:'4242',exp_month:2,exp_year:2030}};h.state.payments.cards.set(pm.id,pm);si.payment_method=pm.id;si.status='succeeded';assert.equal((await verify(worker,headers,a.id)).status,200);
 const b=await worker.request('/api/customer/register',{...account,email:'pgother@example.test',phone:'2035550137'}),otherHeaders={...headers,cookie:cookie(b)};assert.equal((await verify(worker,otherHeaders,a.id)).status,404);assert.deepEqual((await worker.request(base,undefined,otherHeaders)).body,[]);assert.equal((await remove(worker,otherHeaders,pm.id)).status,200);assert.equal(h.state.payments.calls.filter(x=>x.op==='detach').length,0);
 assert.deepEqual((await h.request(base,undefined,headers)).body,[{id:pm.id,brand:'visa',last4:'4242',expMonth:2,expYear:2030}]);assert.equal((await remove(worker,headers,pm.id)).status,200);assert.equal((await remove(h,headers,pm.id)).status,200);
 // A lost provider response survives a worker change using durable PostgreSQL authority.
 h.state.payments.loseCustomer=true;assert.equal((await start(h,otherHeaders)).status,503);
 h.state.payments.loseSetup=true;assert.equal((await start(worker,otherHeaders)).status,503);
 assert.equal((await start(h,otherHeaders)).status,200);
 const customerRetries=h.state.payments.calls.filter(x=>x.op==='createCustomer').slice(-2),setupRetries=h.state.payments.calls.filter(x=>x.op==='createSetup').slice(-2);
 assert.equal(customerRetries[0].options.idempotencyKey,customerRetries[1].options.idempotencyKey);assert.equal(setupRetries[0].options.idempotencyKey,setupRetries[1].options.idempotencyKey);assert.equal(h.state.payments.customers.size,2);assert.equal(h.state.payments.setups.size,2);assert.ok(networkChecks>0);
 const stored=JSON.stringify((await pool.query('SELECT * FROM er_customer_payment_setups')).rows);assert.ok(!stored.includes(si.client_secret));assert.doesNotMatch(stored,/fingerprint|billing_details|last4/);
 // Reproduce completion -> detach -> no app verification -> expiry -> replacement across workers.
 const pending=(await pool.query('SELECT * FROM er_customer_payment_setups WHERE customer_id<>$1',[owner])).rows[0],pendingSi=h.state.payments.setups.get(pending.stripe_setup_id);
 const detached={...pm,id:'pm_pgdetached',customer:pendingSi.customer};h.state.payments.cards.set(detached.id,detached);pendingSi.payment_method=detached.id;pendingSi.status='succeeded';
 assert.equal((await remove(worker,otherHeaders,detached.id)).status,200);h.advance(30*60000);worker.advance(30*60000);
 assert.equal((await start(worker,otherHeaders)).status,200);assert.equal((await pool.query('SELECT state FROM er_customer_payment_setups WHERE id=$1',[pending.id])).rows[0].state,'cancelled');assert.equal(h.state.payments.customers.size,2);
 const now=Date.parse('2026-10-01T16:00:00Z');await pool.query('TRUNCATE er_customer_payment_limits');const limits=await Promise.all(Array.from({length:21},(_,i)=>(i%2?store:second).paymentLimit(owner,'same-ip','setup',now)));assert.equal(limits.filter(Boolean).length,20);
 await pool.query("CREATE FUNCTION fail_saved_setup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic private rollback'; END $$");await pool.query('CREATE TRIGGER fail_saved_setup BEFORE INSERT ON er_customer_payment_setups FOR EACH ROW EXECUTE FUNCTION fail_saved_setup()');const hash=hashToken(headers.cookie.split('=')[1]),before=(await store.paymentMapping(owner)).last_setup_at;
 await assert.rejects(store.preparePaymentSetup(owner,hash,now+60001),e=>e.storageFailure);assert.equal(new Date((await store.paymentMapping(owner)).last_setup_at).getTime(),new Date(before).getTime());await pool.query('DROP TRIGGER fail_saved_setup ON er_customer_payment_setups');
 await store.revokeCustomerSession(hash);await assert.rejects(store.preparePaymentSetup(owner,hash,now+60001),e=>e.status===401);
 await assert.rejects(pool.query('DELETE FROM er_customers WHERE id=$1',[owner]),e=>['23503','23001'].includes(e.code));assert.equal((await pool.query('SELECT 1 FROM er_schema_migrations WHERE version=7')).rowCount,1);
 // Fresh workers: at most 100 expired rows removed per invocation, with safe parallel cleanup.
 await pool.query('TRUNCATE er_customer_payment_limits');await pool.query("INSERT INTO er_customer_payment_limits SELECT md5(i::text)||md5(i::text),1,$1 FROM generate_series(1,250) i",[new Date(now-1)]);
 const live=crypto.createHash('sha256').update('live-fixture').digest('hex');await pool.query('INSERT INTO er_customer_payment_limits VALUES($1,19,$2)',[live,new Date(now+900000)]);
 const cleanupA=createStore({},pool),cleanupB=createStore({},pool2),beforeCleanup=now+40000;
 await cleanupA.paymentLimit(owner,'cleanup-client','list',beforeCleanup);assert.equal((await pool.query('SELECT count(*)::int AS n FROM er_customer_payment_limits WHERE reset_at<$1',[new Date(now)])).rows[0].n,150);
 await cleanupA.paymentLimit(owner,'cleanup-client','list',beforeCleanup);assert.equal((await pool.query('SELECT count(*)::int AS n FROM er_customer_payment_limits WHERE reset_at<$1',[new Date(now)])).rows[0].n,150);
 await Promise.all([cleanupA.paymentLimit(owner,'cleanup-client','list',beforeCleanup+30000),cleanupB.paymentLimit(owner,'cleanup-client','list',beforeCleanup+30000)]);assert.equal((await pool.query('SELECT count(*)::int AS n FROM er_customer_payment_limits WHERE reset_at<$1',[new Date(now)])).rows[0].n,0);
 assert.equal((await pool.query('SELECT attempts FROM er_customer_payment_limits WHERE identity_hash=$1',[live])).rows[0].attempts,19);
 const index=(await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='er_customer_payment_limits_expiry'",[schema])).rows[0];assert.match(index.indexdef,/reset_at, identity_hash/);
});
