const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const {Pool}=require('pg');
const {createStore}=require('../storage/postgres');
const auth=require('../auth/customers');
const testPath=path.join(__dirname,'security-abuse.test.cjs'),source=fs.readFileSync(testPath,'utf8');
const {harness}=new Function('require','__dirname',source.slice(0,source.indexOf('test("approved prices'))+'\nreturn {harness};')(createRequire(testPath),__dirname);
const account={fullName:'Zoë García',email:'Customer@Example.test',phone:'(201) 555-0199',password:'A comfortable test passphrase'};
const cookie=r=>r.headers.getSetCookie().find(x=>x.includes('er_customer_session'))?.split(';')[0];
const register=h=>h.request('/api/customer/register',account);
const profileUpdate=(h,c,body,extra={})=>h.request('/api/customer/profile',body,{cookie:c,origin:'http://localhost:3000','sec-fetch-site':'same-origin',...extra});

test('profile edits use the session owner, preserve historical bookings/payment mapping and keep the session valid',async t=>{
 const h=await harness(t),a=await register(h),c=cookie(a),stored=[...h.testStore.shared.customers.values()][0],id=stored.id;
 const b=await h.request('/api/customer/register',{...account,email:'other-profile@example.test',phone:'2025550188',fullName:'Other Owner'});
 const foreign=[...h.testStore.shared.customers.values()].find(x=>x.id!==id),beforeForeign=structuredClone(foreign);
 const mapping=await h.testStore.paymentMapping(id);assert.equal(mapping,null);
 await h.testStore.preparePaymentMapping(id,auth.hashToken(c.split('=')[1]),Date.now());
 const beforeMapping=await h.testStore.paymentMapping(id);
 const booking=await h.request('/api/checkout',{pickup:'EWR',pickupPlaceId:'ChIJ7wzsxeFSwokRhvLXxTe087M',dropoff:'Manhattan',date:'2026-11-10',time:'12:00',vehicle:'suv',passengers:2,tripType:'oneway',firstName:'Original',lastName:'Snapshot',email:account.email,phone:account.phone,paymentChoice:'later'},{cookie:c});
 assert.equal(booking.status,200);const snapshots=h.records(),owner=await h.testStore.reservationOwner(booking.body.bookingId);
 for(const [body,expected] of [[{fullName:'  Zoë   Updated  '},{fullName:'Zoë Updated',phone:account.phone}],[{phone:'+1 (973) 555-0123'},{fullName:'Zoë Updated',phone:'+1 (973) 555-0123'}],[{fullName:'Final Owner',phone:'973-555-0190'},{fullName:'Final Owner',phone:'973-555-0190'}]]){
  const r=await profileUpdate(h,c,body);assert.equal(r.status,200);assert.deepEqual(r.body.customer,{...expected,email:account.email});assert.match(r.headers.get('cache-control'),/no-store/);assert.equal(r.headers.get('referrer-policy'),'no-referrer');
 }
 assert.equal(stored.id,id);assert.equal(stored.normalized_phone,'+19735550190');assert.deepEqual(foreign,beforeForeign);
 assert.deepEqual(await h.testStore.paymentMapping(id),beforeMapping);assert.deepEqual(h.records(),snapshots);assert.equal(await h.testStore.reservationOwner(booking.body.bookingId),owner);assert.equal(owner,id);
 assert.equal((await h.request('/api/customer/profile',undefined,{cookie:c})).body.customer.fullName,'Final Owner');
 assert.equal((await h.request('/api/customer/profile',undefined,{cookie:cookie(b)})).body.customer.fullName,'Other Owner');
});

test('profile forbids email/owner/provider fields, invalid input, foreign-phone collisions and CSRF',async t=>{
 const h=await harness(t),a=await register(h),c=cookie(a);
 const other=await h.request('/api/customer/register',{...account,email:'profile-second@example.test',phone:'2025550188'});
 for(const body of [{email:'new@example.test'},{fullName:'Changed',customer_id:require('node:crypto').randomUUID()},{customerId:require('node:crypto').randomUUID(),phone:'9735550123'},{stripeCustomerId:'cus_forged',fullName:'Changed'},{},[],{fullName:''},{fullName:' '},{fullName:'1'},{fullName:'12345'},{fullName:'x'.repeat(121)},{fullName:'<script>'},{fullName:'Name\nInjected'},{phone:'letters'},{phone:'201+5550199'},{phone:'1111111111'},{phone:'+442071234567'},{phone:null},{phone:'202-555-0188'}]){
  assert.equal((await profileUpdate(h,c,body)).status,400,JSON.stringify(body));
 }
 assert.equal((await profileUpdate(h,c,{fullName:'Changed'},{origin:'https://attacker.example.test'})).status,403);
 assert.equal((await profileUpdate(h,c,{fullName:'Changed'},{'sec-fetch-site':'same-site'})).status,403);
 assert.equal((await profileUpdate(h,c,{fullName:'Changed'},{'content-type':'text/plain'})).status,403);
 assert.equal((await h.request('/api/customer/profile',undefined,{cookie:c})).body.customer.fullName,account.fullName);
 assert.equal((await h.request('/api/customer/profile',undefined,{cookie:cookie(other)})).body.customer.phone,'2025550188');
});

test('profile update denies guests, revoked/expired/disabled sessions and storage rechecks ownership',async t=>{
 const h=await harness(t),a=await register(h),c=cookie(a),owner=[...h.testStore.shared.customers.values()][0];
 assert.equal((await profileUpdate(h,'',{fullName:'Guest'})).status,401);
 const sessionHash=auth.hashToken(c.split('=')[1]);
 assert.equal(await h.testStore.updateCustomerProfile(require('node:crypto').randomUUID(),sessionHash,{fullName:'Foreign'},Date.now()),null);
 assert.equal(await h.testStore.updateCustomerProfile(owner.id,'0'.repeat(64),{fullName:'Foreign'},Date.now()),null);
 owner.account_status='disabled';assert.equal((await profileUpdate(h,c,{fullName:'Disabled'})).status,401);owner.account_status='active';
 await h.request('/api/customer/logout',{},{cookie:c});assert.equal((await profileUpdate(h,c,{fullName:'Revoked'})).status,401);
 const login=await h.request('/api/customer/login',{email:account.email,password:account.password});h.advance(auth.SESSION_MS+1);
 assert.equal((await profileUpdate(h,cookie(login),{fullName:'Expired'})).status,401);assert.equal(owner.full_name,account.fullName);
});

test('profile storage failures are sanitized and account update throttling is shared',async t=>{
 const h=await harness(t),a=await register(h),c=cookie(a),second=await harness(t,{},'[]',h.testStore);
 for(let i=0;i<20;i++)assert.equal((await profileUpdate(i%2?h:second,c,{fullName:'Updated Owner'})).status,200);
 assert.equal((await profileUpdate(second,c,{fullName:'Blocked Owner'})).status,429);
 h.advance(16*60000);assert.equal((await profileUpdate(h,c,{fullName:'Allowed Owner'})).status,200);
 h.storageFailures.write=true;const result=await profileUpdate(h,c,{fullName:'Private Name'});assert.equal(result.status,503);assert.doesNotMatch(JSON.stringify(result.body)+h.state.logs.join(''),/Private Name|private-storage-marker/);
});

test('customer registration stores only salted scrypt and session hashes; profile is minimal',async t=>{
 const h=await harness(t),r=await register(h);assert.equal(r.status,201);assert.deepEqual(Object.keys(r.body.customer).sort(),['email','fullName','phone']);
 const stored=[...h.testStore.shared.customers.values()][0],raw=cookie(r).split('=')[1];
 assert.equal(stored.normalized_email,'customer@example.test');assert.equal(stored.normalized_phone,'+12015550199');
 assert.match(stored.password_hash,/^scrypt\$v1\$65536\$8\$2\$/);assert.ok(!stored.password_hash.includes(account.password));
 assert.ok(h.testStore.shared.customerSessions.has(auth.hashToken(raw)));assert.ok(!JSON.stringify([...h.testStore.shared.customerSessions]).includes(raw));
 assert.ok(!JSON.stringify(r.body).includes('password'));assert.match(r.headers.get('cache-control'),/no-store/);
 assert.equal((await h.request('/api/customer/profile',undefined,{cookie:cookie(r)})).body.customer.fullName,account.fullName);
});
test('normalized email and phone uniqueness rejects both equivalent formats',async t=>{
 const h=await harness(t);await register(h);
 for(const b of [{...account,email:' customer@example.test ',phone:'2025550199'},{...account,email:'other@example.test',phone:'+1 201-555-0199'}])assert.equal((await h.request('/api/customer/register',b)).status,400);
 assert.equal(h.testStore.shared.customers.size,1);
});
for(const [label,change] of Object.entries({badEmail:{email:'broken'},emailControl:{email:'bad\u0000@example.test'},emailDomain:{email:'test@example..test'},emailDots:{email:'test..user@example.test'},phonePlus:{phone:'201+5550199'},badPhone:{phone:'letters'},internationalUnsupported:{phone:'+442071234567'},shortPassword:{password:'short'},longPassword:{password:'a'.repeat(129)},largeName:{fullName:'x'.repeat(121)},largeEmail:{email:'x'.repeat(255)},largePhone:{phone:'1'.repeat(41)},emptyName:{fullName:' '},controlName:{fullName:'A\u0000B'}})) {
 test('registration rejects '+label,async t=>{const h=await harness(t);assert.equal((await h.request('/api/customer/register',{...account,...change})).status,400);assert.equal(h.testStore.shared.customers.size,0);});
}
test('password salts are random and correct verification is constant-length',async()=>{
 const a=await auth.hashPassword(account.password),b=await auth.hashPassword(account.password);assert.notEqual(a,b);
 assert.equal(await auth.verifyPassword(account.password,a),true);assert.equal(await auth.verifyPassword('incorrect passphrase',a),false);
 assert.equal(await auth.verifyPassword(account.password,'malformed'),false);
});
test('login accepts correct password and unknown/wrong credentials share generic behavior',async t=>{
 const h=await harness(t);await register(h);
 const good=await h.request('/api/customer/login',{email:' CUSTOMER@example.test ',password:account.password});assert.equal(good.status,200);
 for(const b of [{email:account.email,password:'incorrect passphrase'},{email:'unknown@example.test',password:account.password}]) {
  const r=await h.request('/api/customer/login',b);assert.equal(r.status,401);assert.equal(r.body.error,'Email or password is incorrect.');assert.match(r.body.referenceId,/^[a-f0-9-]{36}$/);
 }
});
test('failed login identity throttling persists across workers and equivalent email inputs',async t=>{
 const h=await harness(t);await register(h);const second=await harness(t,{},'[]',h.testStore);
 for(let i=0;i<20;i++)assert.equal((await (i%2?h:second).request('/api/customer/login',{email:i%2?' CUSTOMER@EXAMPLE.TEST ':account.email,password:'wrong password'})).status,401);
 assert.equal((await second.request('/api/customer/login',{email:account.email,password:account.password})).status,429);
 h.advance(16*60000);second.advance(16*60000);assert.equal((await h.request('/api/customer/login',{email:account.email,password:account.password})).status,200);
});
test('customer cookies have separate production host prefix, HttpOnly, Secure, Strict, Path and fixed lifetime',async t=>{
 const h=await harness(t,{NODE_ENV:'production',SITE_URL:'https://er.example.test'}),r=await register(h);
 assert.equal(r.status,201);const header=r.headers.getSetCookie()[0];
 for(const pattern of [/^__Host-er_customer_session=/,/HttpOnly/,/Secure/,/SameSite=Strict/,/Path=\//,/Max-Age=2592000/])assert.match(header,pattern);
 assert.ok(!header.includes('er_admin_session'));
});
test('sessions reject missing, malformed, wrong, duplicate and expired cookies; dashboard requires auth',async t=>{
 const h=await harness(t),r=await register(h),valid=cookie(r);
 for(const value of ['', 'er_customer_session=invalid','er_customer_session='+'a'.repeat(43),valid+'; '+valid])assert.equal((await h.request('/api/customer/profile',undefined,{cookie:value})).status,401);
 const response=await fetch(h.url+'/account/dashboard',{redirect:'manual'});assert.equal(response.status,302);assert.equal(response.headers.get('location'),'/account.html');
 h.advance(auth.SESSION_MS+1);assert.equal((await h.request('/api/customer/profile',undefined,{cookie:valid})).status,401);
});
test('cross-customer profile and admin authorization remain isolated; disabled account rejected',async t=>{
 const h=await harness(t),a=await register(h),b=await h.request('/api/customer/register',{...account,fullName:'Second Customer',email:'second@example.test',phone:'2025550199'});
 const result=await h.request('/api/customer/profile?customerId=ignored',undefined,{cookie:cookie(a)});assert.equal(result.body.customer.fullName,account.fullName);
 assert.equal((await h.request('/api/bookings',undefined,{cookie:cookie(a)})).status,401);
 const admin=await h.request('/api/admin/login',{token:'local-test-token'});assert.equal((await h.request('/api/customer/profile',undefined,{cookie:admin.headers.getSetCookie()[0].split(';')[0]})).status,401);
 [...h.testStore.shared.customers.values()].find(c=>c.normalized_email==='second@example.test').account_status='disabled';
 assert.equal((await h.request('/api/customer/profile',undefined,{cookie:cookie(b)})).status,401);
});
test('logout revokes current session and clears cookie; stale cookie cannot be reused',async t=>{
 const h=await harness(t),r=await register(h),c=cookie(r),out=await h.request('/api/customer/logout',{},{cookie:c});assert.equal(out.status,200);assert.match(out.headers.get('set-cookie'),/er_customer_session=;/);
 assert.equal((await h.request('/api/customer/profile',undefined,{cookie:c})).status,401);assert.equal(h.testStore.shared.customerSessions.size,0);
});
test('login rotates session and revokes old cookie; customer mutation endpoints reject CSRF',async t=>{
 const h=await harness(t),a=await register(h),b=await h.request('/api/customer/login',{email:account.email,password:account.password},{cookie:cookie(a)});
 assert.equal((await h.request('/api/customer/profile',undefined,{cookie:cookie(a)})).status,401);assert.equal((await h.request('/api/customer/profile',undefined,{cookie:cookie(b)})).status,200);
 for(const endpoint of ['register','login','logout'])assert.equal((await h.request('/api/customer/'+endpoint,account,{origin:'https://attacker.example.test'})).status,403);
 assert.equal((await h.request('/api/customer/logout',{},{cookie:cookie(b),'sec-fetch-site':'same-site'})).status,403);
});
test('customer storage failure fails closed without secret or password logging',async t=>{
 const h=await harness(t),r=await register(h);h.storageFailures.read=true;
 const out=await h.request('/api/customer/profile',undefined,{cookie:cookie(r)});assert.equal(out.status,503);assert.doesNotMatch(JSON.stringify(out.body)+h.state.logs.join(''),/private-storage-marker|comfortable test passphrase/);
});
test('frontend has active login link, safe text rendering, and no browser credential storage',()=>{
 assert.match(fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8'),/href="\/account.html">ACCOUNT LOGIN/);
 const js=fs.readFileSync(path.join(__dirname,'../public/account.js'),'utf8');assert.doesNotMatch(js,/localStorage|sessionStorage|innerHTML/);
 assert.match(js,/textContent/);assert.match(js,/type=password/);
});

test('PostgreSQL customer integration: atomic registration, unique identities, persistent sessions, rollback and shared limits',{skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
 const u=new URL(process.env.ER_TEST_DATABASE_URL);assert.ok(['127.0.0.1','localhost'].includes(u.hostname));assert.ok(u.pathname.startsWith('/er_test_'));
 const admin=new Pool({connectionString:u.toString()}),schema='account_test_'+require('node:crypto').randomBytes(8).toString('hex');
 await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:u.toString(),options:'-c search_path='+schema}),pool2=new Pool({connectionString:u.toString(),options:'-c search_path='+schema});
 const store=createStore({},pool),second=createStore({},pool2);t.after(async()=>{await store.close();await second.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 await Promise.all([store.migrate(),second.migrate()]);
 const h=await harness(t,{},'[]',store),h2=await harness(t,{},'[]',second);
 const results=await Promise.all([register(h),register(h2)]);assert.deepEqual(results.map(r=>r.status).sort(),[201,400]);
 const winner=results.find(r=>r.status===201),raw=cookie(winner).split('=')[1];
 const stored=(await pool.query('SELECT * FROM er_customers')).rows[0];assert.ok(!stored.password_hash.includes(account.password));
 assert.equal((await pool.query('SELECT token_hash FROM er_customer_sessions')).rows[0].token_hash,auth.hashToken(raw));
 assert.equal((await h2.request('/api/customer/profile',undefined,{cookie:cookie(winner)})).status,200);
 const statuses=await Promise.all(Array.from({length:21},()=>second.customerLoginLimit(auth.hashToken('shared-counter'),Date.now())));assert.equal(statuses.filter(Boolean).length,20);
 const c={...stored,id:require('node:crypto').randomUUID(),normalized_email:'rollback@example.test',normalized_phone:'+12025550199'};
 await assert.rejects(store.registerCustomer(c,{hash:'invalid',created:new Date(),expires:new Date(Date.now()+1000)}));
 assert.equal((await pool.query('SELECT 1 FROM er_customers WHERE id=$1',[c.id])).rowCount,0);
 const mapping=await store.preparePaymentMapping(stored.id,auth.hashToken(raw),Date.now());
 const before=(await pool.query('SELECT * FROM er_customers WHERE id=$1',[stored.id])).rows[0];
 const updated=await profileUpdate(h2,cookie(winner),{fullName:'Updated PostgreSQL Owner',phone:'973-555-0123'});assert.equal(updated.status,200);
 const after=(await pool.query('SELECT * FROM er_customers WHERE id=$1',[stored.id])).rows[0];
 for(const field of ['id','normalized_email','display_email','password_hash','account_status'])assert.equal(after[field],before[field]);
 assert.equal(after.normalized_phone,'+19735550123');assert.equal(after.full_name,'Updated PostgreSQL Owner');assert.deepEqual(await second.paymentMapping(stored.id),mapping);
 assert.equal(await second.updateCustomerProfile(stored.id,'0'.repeat(64),{fullName:'Forged'},Date.now()),null);
 const conflict=await h.request('/api/customer/register',{...account,email:'pg-profile-conflict@example.test',phone:'2025550188'});assert.equal(conflict.status,201);
 assert.equal((await profileUpdate(h2,cookie(winner),{phone:'202-555-0188',fullName:'Must Roll Back'})).status,400);
 assert.equal((await pool.query('SELECT full_name FROM er_customers WHERE id=$1',[stored.id])).rows[0].full_name,'Updated PostgreSQL Owner');
 await h.request('/api/customer/logout',{},{cookie:cookie(winner)});assert.equal((await h2.request('/api/customer/profile',undefined,{cookie:cookie(winner)})).status,401);
 const login=await h.request('/api/customer/login',{email:account.email,password:account.password});const key=auth.hashToken(cookie(login).split('=')[1]);
 await pool.query("UPDATE er_customer_sessions SET created_at=now()-interval '32 days',expires_at=now()-interval '1 day' WHERE token_hash=$1",[key]);h2.advance(auth.SESSION_MS+1);assert.equal((await h2.request('/api/customer/profile',undefined,{cookie:cookie(login)})).status,401);
});


function accountUiHarness(){
 const vm=require('node:vm'),elements={},events={},toggles=[];
 for(const id of ['loginView','registerView','dashboardView','accountNavigation','accountShell','message','welcome','profileName','profileEmail','profilePhone','logout','navLogout','loginEmail','loginPassword','fullName','registerEmail','phone','registerPassword','loginForm','registerForm','profileForm','editProfile','editFullName','editEmail','editPhone','saveProfile','cancelProfile','profileStatus'])elements[id]={value:'',textContent:'',hidden:true,disabled:false,type:id.endsWith('Password')?'password':'text',classList:{toggle(){}},focus(){},setAttribute(){},addEventListener(event,fn){events[id+':'+event]=fn;}};
 for(const name of ['login','register']){
  const input=elements[name+'Password'],button={dataset:{passwordToggle:name+'Password'},attributes:{},addEventListener(event,fn){events[name+'Toggle:'+event]=fn;},setAttribute(name,value){this.attributes[name]=value;}};
  toggles.push(button);const submit={disabled:false};
  elements[name+'Form'].querySelector=selector=>selector==='button[type=submit]'?submit:input;
  elements[name+'Form'].reset=()=>{input.value='';};elements[name+'Form'].submitButton=submit;
 }
 const state={requests:[]};
 const context={document:{getElementById:id=>elements[id],querySelectorAll:selector=>selector==='[data-password-toggle]'?toggles:[elements.loginPassword,elements.registerPassword]},window:{addEventListener(event,fn){events['window:'+event]=fn;}},history:{replaceState(){}},location:{hash:''},fetch:async(url,options)=>{state.requests.push({url,options});return {ok:true,json:async()=>({customer:{fullName:'salih Example',email:'test@example.test',phone:'2015550199'}})};}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/account.js'),'utf8'),context);
 return {context,elements,events,toggles,state};
}

test('profile UI edits only name/phone, renders authoritative response and stays logged in',async()=>{
 const h=accountUiHarness();h.context.dashboard({fullName:'Original Owner',email:'readonly@example.test',phone:'2015550199'});
 h.events['editProfile:click']();assert.equal(h.elements.profileForm.hidden,false);assert.equal(h.elements.editEmail.value,'readonly@example.test');
 h.elements.editFullName.value='Updated Owner';h.elements.editPhone.value='9735550123';let done;
 h.context.fetch=async(url,options)=>{h.state.requests.push({url,options});return await new Promise(resolve=>{done=resolve;});};
 const request=h.events['profileForm:submit']({preventDefault(){}});await h.events['profileForm:submit']({preventDefault(){}});assert.equal(h.state.requests.length,1);
 assert.deepEqual(JSON.parse(h.state.requests[0].options.body),{fullName:'Updated Owner',phone:'9735550123'});
 done({ok:true,json:async()=>({customer:{fullName:'Updated Owner',email:'readonly@example.test',phone:'9735550123'}})});await request;
 assert.equal(h.elements.profileName.textContent,'Updated Owner');assert.equal(h.elements.profilePhone.textContent,'9735550123');assert.equal(h.elements.profileEmail.textContent,'readonly@example.test');
 assert.equal(h.elements.dashboardView.hidden,false);assert.match(h.elements.profileStatus.textContent,/updated successfully/);assert.equal(h.elements.profileForm.hidden,true);
 assert.match(fs.readFileSync(path.join(__dirname,'../public/account.html'),'utf8'),/id="editEmail"[^>]*readonly/);
});

test('profile UI handles validation/session errors and ignores stale updates after session revalidation',async()=>{
 const h=accountUiHarness();h.context.dashboard({fullName:'Owner',email:'owner@example.test',phone:'2015550199'});h.events['editProfile:click']();
 h.context.fetch=async()=>({ok:false,status:400,json:async()=>({error:'Enter a valid U.S. phone number.'})});
 await h.events['profileForm:submit']({preventDefault(){}});assert.match(h.elements.profileStatus.textContent,/valid U.S./);assert.equal(h.elements.saveProfile.disabled,false);assert.equal(h.elements.dashboardView.hidden,false);
 let finish;h.context.fetch=async()=>await new Promise(resolve=>{finish=resolve;});const old=h.events['profileForm:submit']({preventDefault(){}});
 require('node:vm').runInContext('accountGeneration++;clearPrivateAccount();dashboard({fullName:"New Session",email:"new@example.test",phone:"9735550123"})',h.context);
 finish({ok:false,status:401,json:async()=>({error:'Please log in'})});await old;assert.equal(h.elements.profileName.textContent,'New Session');assert.equal(h.elements.dashboardView.hidden,false);
 h.events['editProfile:click']();h.context.fetch=async()=>({ok:false,status:401,json:async()=>({error:'Please log in'})});await h.events['profileForm:submit']({preventDefault(){}});
 assert.equal(h.elements.dashboardView.hidden,true);assert.equal(h.elements.loginView.hidden,false);assert.equal(h.elements.editPhone.value,'');
});
test('account UI: password visibility is accessible, reversible and never copies the password',()=>{
 const h=accountUiHarness();h.elements.loginPassword.value='synthetic private passphrase';
 h.events['loginToggle:click']();assert.equal(h.elements.loginPassword.type,'text');assert.equal(h.toggles[0].attributes['aria-pressed'],'true');assert.equal(h.toggles[0].textContent,'Hide');
 h.events['loginToggle:click']();assert.equal(h.elements.loginPassword.type,'password');assert.equal(h.toggles[0].attributes['aria-pressed'],'false');
 assert.ok(!JSON.stringify(h.toggles).includes('synthetic private passphrase'));assert.equal(h.state.requests.length,0);
});
test('account UI: displayed first name is polished while canonical profile stays unchanged',()=>{
 const h=accountUiHarness(),customer={fullName:'salih Example',email:'test@example.test',phone:'2015550199'};
 h.context.dashboard(customer);assert.equal(h.elements.welcome.textContent,'Welcome, Salih');assert.equal(h.elements.profileName.textContent,'salih Example');assert.equal(customer.fullName,'salih Example');
 assert.equal(h.elements.accountNavigation.hidden,false);h.context.location.hash='#profile';h.events['window:hashchange']();assert.equal(h.elements.dashboardView.hidden,false);
});
test('account UI: submitting a visible password clears it, re-hides it and targets the submit button',async()=>{
 const h=accountUiHarness();h.elements.loginEmail.value='test@example.test';h.elements.loginPassword.value='synthetic private passphrase';h.events['loginToggle:click']();
 await h.events['loginForm:submit']({preventDefault(){}});
 assert.equal(h.elements.loginPassword.value,'');assert.equal(h.elements.loginPassword.type,'password');assert.equal(h.elements.loginForm.submitButton.disabled,false);
 assert.equal(h.state.requests.length,1);assert.equal(h.state.requests[0].url,'/api/customer/login');
 await h.events['navLogout:click']();assert.equal(h.state.requests[1].url,'/api/customer/logout');assert.equal(h.elements.accountNavigation.hidden,true);assert.equal(h.elements.profileEmail.textContent,'');
});
