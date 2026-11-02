'use strict';
// Run separately from the Node-only suite, sequentially:
// ER_TEST_PLAYWRIGHT_MODULE=<installed playwright module> node --test --test-concurrency=1 tests/browser/complete-payment-visibility.cjs
// Optional ER_TEST_BROWSER_EXECUTABLE selects a local Chromium/Edge binary.
// All Google/Stripe/storage operations below are isolated mocks. No .env is read.
const test=require('node:test'),{before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{createRequire}=require('node:module');
const anchor=path.join(__dirname,'../security-abuse.test.cjs'),raw=fs.readFileSync(anchor,'utf8');
const source=raw.replace('server.listen(0, "127.0.0.1", resolve)','server.listen(Number(env.PORT || 0), "127.0.0.1", resolve)');
assert.notEqual(source,raw,'Isolated HTTP fixture must support its own canonical origin');
const boundary=source.indexOf('test("approved prices');assert.ok(boundary>0);
const {harness,booking}=new Function('require','__dirname',source.slice(0,boundary)+'\nreturn {harness,booking};')(createRequire(anchor),path.dirname(anchor));
let browser;const results=[];
before(async()=>{
 const {chromium}=require(process.env.ER_TEST_PLAYWRIGHT_MODULE||'playwright');
 browser=await chromium.launch({headless:true,...(process.env.ER_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.ER_TEST_BROWSER_EXECUTABLE}:{})});
});
after(async()=>{
 if(browser)await browser.close();
 if(process.env.ER_TEST_BROWSER_RESULTS_FILE)fs.writeFileSync(process.env.ER_TEST_BROWSER_RESULTS_FILE,JSON.stringify({mode:'isolated_mock_only',expectedCases:30,passedCases:results.length,realGoogleCalls:0,liveStripeCalls:0,results},null,2)+'\n');
});
async function port(){const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const value=server.address().port;await new Promise(r=>server.close(r));return value;}
const pairs=response=>response.headers.getSetCookie().map(c=>c.split(';')[0]);
function browserCookies(response,url){
 return response.headers.getSetCookie().filter(c=>/er_(?:booking_access_|customer_session)/.test(c)).map(c=>{
  const [pair,...flags]=c.split(';'),at=pair.indexOf('='),attributes=flags.map(f=>f.trim());
  return {name:pair.slice(0,at),value:pair.slice(at+1),domain:new URL(url).hostname,path:attributes.find(f=>f.startsWith('Path='))?.slice(5)||'/',
   httpOnly:attributes.includes('HttpOnly'),secure:attributes.includes('Secure'),sameSite:'Strict'};
 });
}
for(const account of [false,true])for(const state of ['unpaid','paid','cancelled_unpaid','cancelled_paid','verification_pending'])for(const width of [320,390,1440]){
 test((account?'account':'guest')+' '+state+' at '+width+'px',{timeout:30000},async t=>{
  const p=await port(),h=await harness(t,{PORT:String(p),SITE_URL:'http://127.0.0.1:'+p,ROUTE_TOLLS_ENABLED:'false',ADMIN_TOLL_VALIDATION_ENABLED:'false'});
  const origin={origin:h.url,'sec-fetch-site':'same-origin'},cookies=[];let auth={};
  if(account){
   const registered=await h.request('/api/customer/register',{fullName:'Visibility Fixture',email:'visibility@example.test',phone:'2025550168',password:'Synthetic visibility test password'});
   assert.equal(registered.status,201);auth={cookie:pairs(registered).find(c=>c.includes('er_customer_session'))};cookies.push(...browserCookies(registered,h.url));
  }
  const reserved=await h.request('/api/checkout',{...booking,vehicle:'suv',paymentChoice:'later'},auth);assert.equal(reserved.status,200);
  const id=reserved.body.bookingId,expectedTotal=h.records()[0].quote.total;
  if(account)assert.ok(await h.testStore.reservationOwner(id));else assert.equal(await h.testStore.reservationOwner(id),null);
  // Account cases must exercise the account-status fallback, not a guest cookie.
  if(!account)cookies.push(...browserCookies(reserved,h.url));
  const paymentPath=account?'/api/customer/trips/'+id+'/payment':'/api/booking/'+id+'/checkout';
  const credentials=account?auth:{cookie:pairs(reserved).filter(c=>c.includes('er_booking_access_')).join('; ')};
  const payment=()=>h.request(paymentPath,{}, {...origin,...credentials});let session;
  if(['paid','cancelled_paid','verification_pending'].includes(state)){
   assert.equal((await payment()).status,200);session=[...h.state.sessions.values()][0];session.status='complete';session.payment_status='paid';
   if(state==='verification_pending')assert.equal((await payment()).status,409);
   else assert.equal((await h.webhook(session)).status,200);
  }
  // Preload cancelled UI fixtures; do not invoke refunds or change cancellation rules.
  if(state.startsWith('cancelled'))await h.testStore.withActionLock(h.records()[0].checkoutFingerprint,()=>h.testStore.update(id,r=>{r.status='cancelled';}));
  if(state==='verification_pending'){
   assert.equal(h.records()[0].paymentStatus,'unpaid');assert.equal(require('../../storage/customer-trips').paymentVerificationPending(h.records()[0]),true);
  }
  const context=await browser.newContext({viewport:{width,height:1000}});let release;const gate=new Promise(r=>release=r);let released=false;
  try{
   await context.addCookies(cookies);await context.addInitScript(()=>{window.cspFailures=[];document.addEventListener('securitypolicyviolation',e=>window.cspFailures.push(e.effectiveDirective));});
   await context.route('**/*',async r=>{
    const url=new URL(r.request().url());
    if(url.href==='https://checkout.example.test/mock')return r.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Isolated Checkout</title>No live payment.'});
    if(url.origin!==h.url)return r.abort();
    if(!released&&url.pathname==='/api/booking/'+id&&r.request().method()==='GET')await gate;
    return r.continue();
   });
   const page=await context.newPage();await page.goto(h.url+'/success.html?booking='+id+'&paid=true&session_id=forged',{waitUntil:'domcontentloaded'});
   const button=page.locator('#completePayment');assert.equal(await button.isVisible(),false,'Loading state must not flash a payment action');
   assert.equal(await button.evaluate(e=>getComputedStyle(e).display),'none');released=true;release();
   const message=state==='unpaid'?'Payment is still required':state==='verification_pending'?'confirming your payment':state.startsWith('cancelled')?'cancelled':'Payment received';
   await page.waitForFunction(text=>document.getElementById('message').textContent.includes(text),message);
   assert.equal(await button.evaluate(e=>e.hidden),state!=='unpaid');assert.equal(await button.isVisible(),state==='unpaid');
   assert.equal(await button.evaluate(e=>getComputedStyle(e).display),state==='unpaid'?'inline-flex':'none');
   assert.equal(await page.locator('#refreshReservation').isVisible(),true,'The scoped fix must not hide other controls');
   assert.deepEqual(await page.evaluate(()=>window.cspFailures),[]);
   if(state==='unpaid'){
    assert.equal(h.state.creates.length,0);h.state.createDelay=75;
    await button.dblclick({delay:10});await page.waitForURL('https://checkout.example.test/mock');assert.equal(h.state.creates.length,1);
    const duplicate=await Promise.all([payment(),payment()]);assert.ok(duplicate.every(r=>r.status===200));assert.equal(h.state.creates.length,1);
    session=[...h.state.sessions.values()][0];assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,Math.round(expectedTotal*100));
    session.status='complete';session.payment_status='paid';assert.equal((await h.webhook(session)).status,200);
    await page.goto(h.url+'/success.html?booking='+id);await page.waitForFunction(()=>document.getElementById('message').textContent.includes('Payment received'));
    assert.equal(await button.isVisible(),false);assert.equal(await button.evaluate(e=>getComputedStyle(e).display),'none');
    const denied=await Promise.all([payment(),payment()]);assert.ok(denied.every(r=>r.status===409));assert.equal(h.state.creates.length,1);
   }else{
    const creates=h.state.creates.length,denied=await Promise.all([payment(),payment()]);assert.ok(denied.every(r=>r.status===409));assert.equal(h.state.creates.length,creates);
    if(state==='verification_pending'){
     assert.equal(h.records()[0].paymentStatus,'unpaid');assert.equal((await h.webhook(session)).status,200);await page.locator('#refreshReservation').click();
     await page.waitForFunction(()=>document.getElementById('message').textContent.includes('Payment received'));assert.equal(await button.isVisible(),false);
    }
   }
   assert.equal(h.records()[0].quote.total,expectedTotal);assert.equal(h.records().length,1);assert.deepEqual(await page.evaluate(()=>window.cspFailures),[]);
   results.push({account,state,width,loadingHidden:true,correctVisibility:true,duplicatePaymentPrevented:true,storedTotalUnchanged:true,passed:true});
  }finally{released=true;release();await context.close();}
 });
}
