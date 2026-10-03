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
 await h.request('/api/customer/logout',{},{cookie:cookie(winner)});assert.equal((await h2.request('/api/customer/profile',undefined,{cookie:cookie(winner)})).status,401);
 const login=await h.request('/api/customer/login',{email:account.email,password:account.password});const key=auth.hashToken(cookie(login).split('=')[1]);
 await pool.query("UPDATE er_customer_sessions SET created_at=now()-interval '32 days',expires_at=now()-interval '1 day' WHERE token_hash=$1",[key]);h2.advance(auth.SESSION_MS+1);assert.equal((await h2.request('/api/customer/profile',undefined,{cookie:cookie(login)})).status,401);
});


function accountUiHarness(){
 const vm=require('node:vm'),elements={},events={},toggles=[];
 for(const id of ['loginView','registerView','dashboardView','accountNavigation','accountShell','message','welcome','profileName','profileEmail','profilePhone','logout','navLogout','loginEmail','loginPassword','fullName','registerEmail','phone','registerPassword','loginForm','registerForm'])elements[id]={value:'',textContent:'',hidden:true,disabled:false,type:id.endsWith('Password')?'password':'text',classList:{toggle(){}},addEventListener(event,fn){events[id+':'+event]=fn;}};
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
