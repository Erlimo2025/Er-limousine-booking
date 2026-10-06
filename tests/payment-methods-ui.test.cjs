const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const source=fs.readFileSync(path.join(__dirname,'../public/payment-methods.js'),'utf8'),html=fs.readFileSync(path.join(__dirname,'../public/payment-methods.html'),'utf8');
const harnessPath=path.join(__dirname,'security-abuse.test.cjs'),serverSource=fs.readFileSync(harnessPath,'utf8');
const {harness}=new Function('require','__dirname',serverSource.slice(0,serverSource.indexOf('test("approved prices'))+'\nreturn {harness};')(createRequire(harnessPath),__dirname);
const card={id:'pm_synthetic1',brand:'visa',last4:'4242',expMonth:3,expYear:2030};
function ui(){
 class Element{constructor(tag='div'){this.tag=tag;this.children=[];this.events={};this.hidden=false;this.disabled=false;this.checked=false;this.textContent='';this.attributes={};}append(...x){this.children.push(...x);}replaceChildren(...x){this.children=x;}setAttribute(k,v){this.attributes[k]=v;}addEventListener(k,v){this.events[k]=v;}querySelectorAll(tag){return this.children.flatMap(x=>[...(x.tag===tag?[x]:[]),...x.querySelectorAll(tag)]);}focus(){this.focused=true;}remove(){this.removed=true;}}
 const elements=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(x=>[x[1],new Element()])),events={},state={calls:[],cards:[],stripeCalls:[],destroyed:0,scripts:[],redirect:null,verifyFailure:false,confirmFailure:false,sessionExpired:false,disabled:false};
 const element={mount:selector=>state.stripeCalls.push(['mount',selector]),destroy:()=>state.destroyed++};
 const Stripe=key=>{state.stripeCalls.push(['key',key]);return {elements:()=>({create:(type,options)=>{state.stripeCalls.push(['element',type,options]);return element;}}),confirmCardSetup:async(secret,params)=>{state.stripeCalls.push(['confirm',secret,params]);if(state.confirmWait)await state.confirmWait;return state.confirmFailure?{error:{message:'synthetic private provider error'}}:{setupIntent:{status:'succeeded',customer:'cus_private'}};}};};
 const storage=new Map();const context={sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},document:{getElementById:id=>elements[id],createElement:tag=>new Element(tag),head:{append:s=>{state.scripts.push(s);context.window.Stripe=Stripe;queueMicrotask(()=>s.onload());}}},window:{addEventListener:(k,v)=>events[k]=v},location:{replace:url=>state.redirect=url},fetch:async(url,options)=>{state.calls.push({url,options});if(state.fetchWait)await state.fetchWait;
 let status=200,data={},next=null;if(state.sessionExpired)status=401;else if(url.endsWith('/config')){if(state.disabled)status=503;else data={publishableKey:'pk_test_synthetic123'};}
 else if(url.endsWith('/setup'))data={attempt:'11111111-1111-4111-8111-111111111111',clientSecret:'seti_synthetic_secret_notreal'};
 else if(url.endsWith('/verify')){if(state.verifyFailure)status=503;else {data={ok:true};state.cards=[card];}}
 else if(options.method==='DELETE'){state.cards=[];data={ok:true};}else if(url.includes('/payment-methods')){data=state.cards;next=state.next;}
 return {ok:status===200,status,json:async()=>data,headers:{get:()=>next}};
 }};
 vm.createContext(context);vm.runInContext(source,context);const click=id=>elements[id].events.click?.({preventDefault(){}}),submit=id=>elements[id].events.submit({preventDefault(){}});
 return {elements,state,events,context,storage,click,submit,load:()=>events.pageshow(),start:async()=>{await click('addCard');elements.saveConsent.checked=true;await submit('consentForm');}};
}
test('payment page/config require existing authentication; only publishable key is exposed',async t=>{
 const h=await harness(t,{CUSTOMER_PAYMENT_METHODS_ENABLED:'true',STRIPE_PUBLISHABLE_KEY:'pk_test_synthetic123'});
 assert.equal((await h.request('/api/customer/payment-methods/config')).status,401);
 const unauth=await h.request('/payment-methods.html');assert.ok(unauth.headers.get('content-type').includes('text/html'));assert.ok(!unauth.body?.includes?.('id="savedCards"'));
 const r=await h.request('/api/customer/register',{fullName:'UI Fixture',email:'ui@example.test',phone:'2025550149',password:'Synthetic UI passphrase'}),headers={cookie:r.headers.getSetCookie().find(x=>x.includes('er_customer_session=')).split(';')[0]};
 const config=await h.request('/api/customer/payment-methods/config',undefined,headers);assert.equal(config.status,200);assert.deepEqual(config.body,{publishableKey:'pk_test_synthetic123'});assert.equal(config.headers.get('cache-control'),'no-store');
 const page=await h.request('/payment-methods.html',undefined,headers);assert.equal(page.status,200);assert.equal(page.headers.get('cache-control'),'no-store');assert.equal(page.headers.get('referrer-policy'),'no-referrer');
 const csp=page.headers.get('content-security-policy');assert.match(csp,/https:\/\/js\.stripe\.com/);assert.match(csp,/https:\/\/api\.stripe\.com/);assert.match(csp,/https:\/\/hooks\.stripe\.com/);assert.match(csp,/frame-ancestors 'none'/);assert.equal(page.headers.get('x-frame-options'),'DENY');assert.doesNotMatch(csp,/unsafe-eval|maps\.google|link\.com/);
 const home=await h.request('/');assert.match(home.headers.get('content-security-policy'),/frame-src 'none'/);assert.doesNotMatch(home.headers.get('content-security-policy'),/stripe\.com/);assert.equal(h.state.payments.calls.length,0);
});
test('disabled feature, missing or non-publishable configuration fail generically without key disclosure',async t=>{
 for(const env of [{},{CUSTOMER_PAYMENT_METHODS_ENABLED:'true'},{CUSTOMER_PAYMENT_METHODS_ENABLED:'true',STRIPE_PUBLISHABLE_KEY:'sk_test_not_a_real_key'}]){
  const h=await harness(t,env),r=await h.request('/api/customer/register',{fullName:'UI Fixture',email:'ui@example.test',phone:'2025550149',password:'Synthetic UI passphrase'}),cookie=r.headers.getSetCookie().find(x=>x.includes('er_customer_session=')).split(';')[0];const out=await h.request('/api/customer/payment-methods/config',undefined,{cookie});assert.equal(out.status,503);assert.doesNotMatch(JSON.stringify(out.body),/sk_test|publishableKey/);assert.equal(h.state.payments.calls.length,0);
 }
});
test('empty/loading/unavailable UI never loads Stripe until explicit consent',async()=>{
 const h=ui();await h.load();assert.equal(h.elements.paymentStatus.textContent,'No saved payment methods yet.');assert.equal(h.state.scripts.length,0);await h.click('addCard');await h.submit('consentForm');assert.equal(h.state.calls.filter(x=>x.url.endsWith('/setup')).length,0);assert.equal(h.state.stripeCalls.length,0);
 h.state.disabled=true;await h.load();assert.equal(h.elements.addCard.disabled,true);assert.match(h.elements.paymentStatus.textContent,/temporarily unavailable/);
});
test('consent starts setup; card Element confirms then server verification gates success and list refresh',async()=>{
 const h=ui();await h.load();await h.start();assert.equal(h.state.scripts[0].src,'https://js.stripe.com/v3/');assert.equal(h.state.stripeCalls.find(x=>x[0]==='element')[1],'card');assert.deepEqual(JSON.parse(h.state.calls.find(x=>x.url.endsWith('/setup')).options.body),{consent:true});
 await h.submit('saveCardForm');const urls=h.state.calls.map(x=>x.url);assert.ok(urls.indexOf('/api/customer/profile')<urls.findIndex(x=>x.endsWith('/verify')));assert.ok(urls.at(-1)==='/api/customer/payment-methods');assert.equal(h.elements.paymentStatus.textContent,'Card saved successfully.');assert.equal(h.elements.savedCards.children.length,1);assert.equal(h.state.destroyed,1);
 assert.ok(h.state.calls.every(x=>x.options.cache==='no-store'&&x.options.credentials==='same-origin'));assert.doesNotMatch(JSON.stringify(h.state.calls),/seti_synthetic_secret|cus_private|card_number|cvc/);
});
test('browser-reported success cannot bypass failed server verification; retry verifies without reconfirming',async()=>{
 const h=ui();await h.load();await h.start();h.state.verifyFailure=true;await h.submit('saveCardForm');assert.doesNotMatch(h.elements.paymentStatus.textContent,/saved successfully/);assert.equal(h.elements.retryVerification.hidden,false);assert.equal(h.elements.savedCards.children.length,0);
 h.state.verifyFailure=false;await h.click('retryVerification');assert.equal(h.elements.paymentStatus.textContent,'Card saved successfully.');assert.equal(h.state.stripeCalls.filter(x=>x[0]==='confirm').length,1);
});
test('Stripe errors are generic and never rendered as raw provider errors',async()=>{const h=ui();await h.load();await h.start();h.state.confirmFailure=true;await h.submit('saveCardForm');assert.doesNotMatch(h.elements.paymentStatus.textContent,/synthetic private|saved successfully/);assert.ok(!h.state.calls.some(x=>x.url.endsWith('/verify')));});
test('safe card DTO rendering excludes provider IDs and forbidden fields; remove requires confirmation',async()=>{
 const h=ui();h.state.cards=[{...card,customer:'cus_private',fingerprint:'private-fingerprint',billing_details:{address:'private-address'},metadata:{private:true}}];await h.load();const rendered=JSON.stringify(h.elements.savedCards);assert.match(rendered,/VISA •••• 4242/);assert.doesNotMatch(rendered,/pm_synthetic|cus_private|fingerprint|billing|private-address/);
 const remove=h.elements.savedCards.querySelectorAll('button')[0];remove.events.click();assert.equal(h.state.calls.filter(x=>x.options.method==='DELETE').length,0);await h.click('cancelRemove');assert.equal(h.elements.removeConfirmation.hidden,true);remove.events.click();await h.click('confirmRemove');assert.equal(h.state.calls.filter(x=>x.options.method==='DELETE').length,1);assert.equal(h.elements.savedCards.children.length,0);assert.equal(h.elements.paymentStatus.textContent,'Card removed.');
});
test('double submits are blocked; pagehide clears cards/setup and ignores pending provider results',async()=>{
 const h=ui();await h.load();await h.start();let resolve;h.state.confirmWait=new Promise(r=>resolve=r);const saving=h.submit('saveCardForm');await new Promise(r=>setImmediate(r));await h.submit('saveCardForm');assert.equal(h.state.stripeCalls.filter(x=>x[0]==='confirm').length,1);assert.equal(h.elements.saveCard.disabled,true);h.events.pagehide();resolve();await saving;assert.ok(!h.state.calls.some(x=>x.url.endsWith('/verify')));assert.equal(h.elements.savedCards.children.length,0);assert.equal(h.elements.addCardPanel.hidden,true);
});
test('session expiry redirects to login and clears transient card state before confirmation',async()=>{const h=ui();await h.load();await h.start();h.state.sessionExpired=true;await h.submit('saveCardForm');assert.equal(h.state.redirect,'/account.html');assert.equal(h.state.stripeCalls.filter(x=>x[0]==='confirm').length,0);assert.equal(h.elements.addCardPanel.hidden,true);});
test('logout and bfcache restoration clear private UI and revalidate config/list',async()=>{
 const h=ui();h.state.cards=[card];await h.load();await h.start();h.events.pagehide();assert.equal(h.elements.savedCards.children.length,0);assert.equal(h.elements.saveConsent.checked,false);h.state.cards=[];h.state.verifyFailure=true;await h.events.pageshow();assert.equal(h.elements.savedCards.children.length,0);assert.equal(h.elements.retryVerification.hidden,false);assert.equal(h.state.calls.filter(x=>x.url.endsWith('/config')).length,2);
 await h.click('paymentLogout');assert.equal(h.state.redirect,'/account.html');assert.ok(h.state.calls.some(x=>x.url==='/api/customer/logout'));
});
test('payment page uses local assets, accessible consent/status/controls, responsive CSS and no persistent storage or logging',()=>{
 assert.doesNotMatch(source,/localStorage|indexedDB|console\.|innerHTML|return_url/);assert.doesNotMatch(html,/https:\/\/|analytics|type="(?:text|number)"/);assert.match(html,/role="status" aria-live="polite"/);assert.match(html,/type="checkbox" required/);assert.match(html,/ER Limousine Service does not store your full card number or CVC/);assert.match(html,/not yet available for booking payments/);
 const css=fs.readFileSync(path.join(__dirname,'../public/payment-methods.css'),'utf8');assert.match(css,/@media\(max-width:700px\)/);assert.match(css,/@media\(max-width:350px\)/);assert.match(css,/overflow-wrap:anywhere/);assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../public/account.html'),'utf8'),/href="\/payment-methods.html"/);
});

test('stale 401 cannot clear a newer setup, while current 401 clears recovery and redirects',async()=>{
 const h=ui(),f=h.context.fetch;let release;
 h.context.fetch=async(u,o)=>{if(!release&&u.endsWith('/config'))return new Promise(r=>release=r);return f(u,o)};
 const old=h.load();await Promise.resolve();await h.load();await h.start();release({ok:false,status:401});await old;
 assert.equal(h.state.redirect,null);assert.equal(h.elements.saveCardForm.hidden,false);assert.equal(h.storage.size,1);
 h.state.sessionExpired=true;await h.submit('saveCardForm');assert.equal(h.state.redirect,'/account.html');assert.equal(h.storage.size,0);
});
test('verified save survives list failure; refresh retries neither setup nor Stripe confirmation',async()=>{
 const h=ui();await h.load();await h.start();const f=h.context.fetch;let fail=true;
 h.context.fetch=async(u,o)=>{if(fail&&u==='/api/customer/payment-methods'&&h.state.cards.length)throw Error('mock');return f(u,o)};
 await h.submit('saveCardForm');assert.match(h.elements.paymentStatus.textContent,/Card saved successfully.*could not be refreshed/);assert.equal(h.elements.paymentRetry.hidden,false);assert.equal(h.storage.size,0);
 fail=false;await h.click('paymentRetry');assert.equal(h.elements.paymentStatus.textContent,'Card saved successfully.');assert.equal(h.state.calls.filter(x=>x.url.endsWith('/setup')).length,1);assert.equal(h.state.stripeCalls.filter(x=>x[0]==='confirm').length,1);
});
test('navigation retains only attempt UUID and resumes server verification without secret or confirmation',async()=>{
 const h=ui();await h.load();await h.start();assert.deepEqual([...h.storage.values()],['11111111-1111-4111-8111-111111111111']);h.events.pagehide();assert.equal(h.elements.addCardPanel.hidden,true);
 await h.load();assert.equal(h.elements.paymentStatus.textContent,'Card saved successfully.');assert.equal(h.storage.size,0);assert.equal(h.state.stripeCalls.filter(x=>x[0]==='confirm').length,0);
 assert.equal(h.state.calls.filter(x=>x.url.endsWith('/setup')).length,1);
});
test('unresolved resume remains retryable; terminal or foreign attempt clears recovery',async()=>{
 for(const status of [409,503,404]){
 const h=ui();await h.load();await h.start();h.events.pagehide();const f=h.context.fetch;
 h.context.fetch=async(u,o)=>u.endsWith('/verify')?{ok:false,status}:f(u,o);
 await h.load();assert.doesNotMatch(h.elements.paymentStatus.textContent,/saved successfully/);
 assert.equal(h.storage.size,status===404?0:1);assert.equal(h.elements.retryVerification.hidden,status===404);
 }
});
test('logout clears persisted attempt; stale resumed verification cannot alter newer generation',async()=>{
 const h=ui();await h.load();await h.start();h.events.pagehide();const f=h.context.fetch;let release;
 h.context.fetch=async(u,o)=>u.endsWith('/verify')?new Promise(r=>release=r):f(u,o);
 const old=h.load();while(!release)await new Promise(r=>setImmediate(r));await h.click('paymentLogout');release({ok:true,status:200,json:async()=>({ok:true}),headers:{get:()=>null}});await old;
 assert.equal(h.storage.size,0);assert.equal(h.state.redirect,'/account.html');assert.doesNotMatch(h.elements.paymentStatus.textContent,/saved successfully/);
});

test('account UI has no Payment Methods management entry or obsolete navigation, while booking and My Trips remain',()=>{
 const account=fs.readFileSync(path.join(__dirname,'../public/account.html'),'utf8');
 assert.doesNotMatch(account,/Payment Methods|Manage cards securely saved with Stripe|Manage Payment Methods|payment-methods\.html/);
 assert.match(account,/id="tripsPanel"/);assert.match(account,/Book a Ride/);assert.match(account,/id="profile"/);
 for(const name of fs.readdirSync(path.join(__dirname,'../public')).filter(x=>/\.(html|js)$/.test(x)))assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../public',name),'utf8'),/href=["']\/payment-methods\.html["']/,'Obsolete management-page navigation in '+name);
});
