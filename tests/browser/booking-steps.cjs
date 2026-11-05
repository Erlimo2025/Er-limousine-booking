'use strict';
// Run separately and sequentially with an installed Playwright module:
// ER_TEST_PLAYWRIGHT_MODULE=<module path> node --test --test-concurrency=1 tests/browser/booking-steps.cjs
// Optional ER_TEST_BROWSER_EXECUTABLE / ER_TEST_BOOKING_RESULTS_FILE.
// No .env, real Google/Stripe, production database or customer data is used.
const test=require('node:test'),{before,after}=test,assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {create,cases}=require('../helpers/booking-browser.cjs');
let browser;const results=[];
before(async()=>{const {chromium}=require(process.env.ER_TEST_PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true,...(process.env.ER_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.ER_TEST_BROWSER_EXECUTABLE}:{})});});
after(async()=>{if(browser)await browser.close();if(process.env.ER_TEST_BOOKING_RESULTS_FILE)fs.writeFileSync(process.env.ER_TEST_BOOKING_RESULTS_FILE,JSON.stringify({mode:'isolated_mock_only',passed:results.length,liveStripeCalls:0,realGoogleCalls:0,results},null,2)+'\n');});
function cookies(response,url){return response.headers.getSetCookie().map(c=>{const [pair,...flags]=c.split(';'),at=pair.indexOf('='),a=flags.map(f=>f.trim());return {name:pair.slice(0,at),value:pair.slice(at+1),domain:new URL(url).hostname,path:a.find(f=>f.startsWith('Path='))?.slice(5)||'/',httpOnly:a.includes('HttpOnly'),secure:a.includes('Secure'),sameSite:'Strict'};});}
async function setup(t,width,c=cases[0]){
 const {h,input}=await create(t,c),context=await browser.newContext({viewport:{width,height:1000}});t.after(()=>context.close());
 await context.addInitScript(()=>{const NativeDate=Date,fixed=Date.parse('2026-10-01T16:00:00Z');window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};window.cspFailures=[];document.addEventListener('securitypolicyviolation',e=>window.cspFailures.push(e.effectiveDirective));});
 await context.route('**/*',r=>{const url=r.request().url();if(url==='https://checkout.example.test/mock')return r.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Isolated Checkout</title>No live charge.'});return new URL(url).origin===h.url?r.continue():r.abort();});
 if(c.account){const registered=await h.request('/api/customer/register',{fullName:input.firstName+' '+input.lastName,email:input.email,phone:input.phone,password:'Synthetic browser account password'});assert.equal(registered.status,201);await context.addCookies(cookies(registered,h.url));}
 const page=await context.newPage();page.setDefaultTimeout(12000);await page.goto(h.url+'/#book',{waitUntil:'networkidle'});
 const state=()=>page.locator('#book').getAttribute('data-booking-step');
 return {h,input,page,context,state,c};
}
async function details(s){const {page,input,c}=s;
 if(c.special){await page.locator('#ewrManhattanSpecialBtn').click();await page.locator('#pickupTerminal').selectOption('c');}
 else{if(input.tripType!=='oneway')await page.locator('[data-trip-type="'+input.tripType+'"]').click();await page.locator('#pickup').fill(input.pickup);}
 await page.locator('#dropoff').fill(input.dropoff);await page.locator('#date').fill(input.date);await page.locator('#time').fill(input.time);await page.locator('#passengers').selectOption('2');if(!c.special)await page.locator('#vehicle').selectOption(input.vehicle);
 if(input.tripType==='roundtrip'){await page.locator('#returnDate').fill(input.returnDate);await page.locator('#returnTime').fill(input.returnTime);}
 if(input.tripType==='hourly')await page.locator('#hours').selectOption(input.hours);
 await page.locator('#bookingContinue').click();assert.equal(await s.state(),'2');
}
async function customer(s){for(const id of ['firstName','lastName','email','phone','notes'])await s.page.locator('#'+id).fill(s.input[id]);if(s.input.promoCode)await s.page.locator('#promoCode').fill(s.input.promoCode);}
async function quote(s){const response=s.page.waitForResponse(r=>r.url()===s.h.url+'/api/quote'&&r.request().method()==='POST');await s.page.locator('#quoteBtn').click();const r=await response;assert.equal(r.status(),200);const q=await r.json();await s.page.waitForFunction(()=>document.getElementById('book').dataset.bookingStep==='3');return q;}
async function layout(s){const {page}=s;assert.equal(await page.locator('.summary-card').count(),1);assert.equal(await page.locator('#bookingForm .summary-card').count(),1);assert.equal(await page.locator('#bookingTripStep').isVisible(),false);assert.equal(await page.locator('#bookingCustomerStep').isVisible(),false);assert.equal(await page.locator('#bookingSummaryStep').isVisible(),true);
 const display=await page.evaluate(()=>({rows:[...document.querySelectorAll('#fareBreakdown .fare-breakdown-row')].map(r=>[...r.children].map(e=>e.textContent)),totalLabel:document.getElementById('sumTotalLabel').textContent,overflow:Math.max(0,document.documentElement.scrollWidth-innerWidth),csp:window.cspFailures,buttonsAfterTotal:document.getElementById('sumTotal').compareDocumentPosition(document.getElementById('payBtn'))&Node.DOCUMENT_POSITION_FOLLOWING}));assert.deepEqual(display.rows.map(r=>r[0]),['Trip Fare','Tolls']);assert.equal(display.totalLabel,'Total');assert.equal(display.overflow,0);assert.deepEqual(display.csp,[]);assert.ok(display.buttonsAfterTotal);assert.equal(await page.locator('#promoSummary').isVisible(),false);return display;}
async function capture(s,width,choice,step){const dir=process.env.ER_TEST_BOOKING_SCREENSHOTS_DIR;if(!dir||!['interstate_estimate','missing_category'].includes(s.c.id)||choice!=='now')return;fs.mkdirSync(dir,{recursive:true});await s.page.locator('#book').screenshot({path:path.join(dir,'booking-'+(s.c.id==='missing_category'?'review-':'')+width+'-step-'+step+'.png')});}

for(const width of [320,390,1440])for(const c of cases)for(const choice of ['now','later'])test(c.id+' / '+choice+' / '+width+'px',{timeout:30000},async t=>{
 const s=await setup(t,width,c),{page,h}=s;assert.equal(await s.state(),'1');assert.equal(await page.locator('#payBtn').isVisible(),false);await capture(s,width,choice,1);await details(s);assert.equal(await page.locator('#payLaterBtn').isVisible(),false);await customer(s);await capture(s,width,choice,2);
 if(c.expected==='review_required'){
  for(let i=0;i<2;i++){const response=page.waitForResponse(r=>r.url()===h.url+'/api/quote');await page.locator('#quoteBtn').click();const failed=await response;assert.equal(failed.status(),422);assert.equal((await failed.json()).checkoutAllowed,false);await page.waitForFunction(()=>!document.getElementById('quoteBtn').disabled);assert.equal(await s.state(),'2');assert.equal(await page.locator('#notice').innerText(),'Toll estimate unavailable — contact us for a final quote');assert.equal(await page.locator('#payBtn').isEnabled(),false);assert.equal(await page.locator('#payLaterBtn').isEnabled(),false);}
  assert.equal(await page.locator('#notes').inputValue(),s.input.notes);assert.equal(await page.evaluate(()=>Math.max(0,document.documentElement.scrollWidth-innerWidth)),0);
  await capture(s,width,choice,'review');await page.evaluate(id=>document.getElementById('bookingForm').dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:document.getElementById(id)})),choice==='later'?'payLaterBtn':'payBtn');assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);assert.equal(await s.state(),'2');results.push({scenario:c.id,width,choice,passed:true});return;
 }
 const q=await quote(s),display=await layout(s);await capture(s,width,choice,3);
 const cents=Number.isSafeInteger(q.totalCents)?q.totalCents:Math.round(q.total*100),money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value/100);
 assert.equal(await page.locator('#sumTotal').innerText(),money(cents));
 assert.equal(display.rows[0][1],money(cents-(q.pricingBreakdown?.tollsCents||0)));
 if(q.pricingBreakdown&&!q.pricingBreakdown.tollsIncluded)assert.equal(display.rows[1][1],money(q.pricingBreakdown.tollsCents));
 assert.equal(await page.locator('#sumDestination').innerText(),s.input.dropoff);assert.match(await page.locator('#sumPickupTime').innerText(),/11\/10\/2026.*12:00 PM/);assert.equal(await page.locator('#payBtn').isEnabled(),true);assert.equal(await page.locator('#payLaterBtn').isEnabled(),true);
 if(c.expected)assert.equal(q.tolls.status,c.expected);if(c.expected==='included'||c.disabled||c.tripType==='hourly')assert.equal(display.rows[1][1],'Included');
 if(c.special){assert.equal(q.totalCents,15000);assert.equal(q.discount,0);assert.equal(await page.locator('#sumTotal').innerText(),'$150.00');}
 if(c.promoCode){assert.equal(q.promotion.code,'FIRST15');assert.equal(q.promotion.percentOff,15);assert.ok(q.discount>0);}
 if(c.tripType==='roundtrip'){assert.equal(await page.locator('#summaryReturnRow').isVisible(),true);assert.match(await page.locator('#sumMiles').innerText(),/mi/);assert.doesNotMatch(await page.locator('#sumMiles').innerText(),/\$/);assert.equal(h.state.routes.length,2);}
 if(c.tripType==='hourly'){assert.equal(h.state.routes.length,0);assert.equal(await page.locator('#sumMinutes').innerText(),'3.5 hours reserved');}
 const response=page.waitForResponse(r=>r.url()===h.url+'/api/checkout'&&r.request().method()==='POST');await page.locator(choice==='later'?'#payLaterBtn':'#payBtn').dblclick();const reserved=await response;assert.equal(reserved.status(),200);assert.equal(h.records().length,1);const record=h.records()[0];assert.equal(record.quote.total,q.total);assert.equal(record.trip.notes,s.input.notes);if(q.quoteRevision)assert.equal(record.quote.quoteRevision,q.quoteRevision);if(c.account)assert.ok(await h.testStore.reservationOwner(record.id));
 if(c.expectedSource)assert.equal(record.quote.tolls.format,c.expectedSource);
 if(choice==='later'){await page.waitForURL(url=>url.pathname==='/success.html');await page.waitForFunction(()=>document.getElementById('message').textContent.includes('Payment is still required'));assert.equal(h.state.creates.length,0);assert.equal(await page.locator('#completePayment').isVisible(),true);if(c.expected==='included')assert.match(await page.locator('#details').innerText(),/Tolls\s+Included/);await page.locator('#completePayment').click();}
 await page.waitForURL('https://checkout.example.test/mock');assert.equal(h.state.creates.length,1);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,Math.round(q.total*100));
 const session=[...h.state.sessions.values()][0];session.status='complete';session.payment_status='paid';assert.equal((await h.webhook(session)).status,200);await page.goto(h.url+'/success.html?booking='+record.id+'&paid=true');await page.waitForFunction(()=>document.getElementById('message').textContent.includes('Payment received'));assert.equal(await page.locator('#completePayment').isVisible(),false);assert.equal(h.state.creates.length,1);
 results.push({scenario:c.id,width,choice,passed:true});
});

for(const width of [320,390,1440])test('validation, editing, fresh quotes and early-payment guard / '+width+'px',{timeout:30000},async t=>{
 const s=await setup(t,width),{page,h}=s;await page.locator('#bookingContinue').click();assert.equal(await s.state(),'1');assert.equal(h.state.routes.length,0);
 await details(s);await page.locator('#quoteBtn').click();assert.equal(await s.state(),'2');assert.equal(h.state.routes.length,0);await customer(s);await page.locator('#email').fill('not-an-email');await page.locator('#quoteBtn').click();assert.equal(h.state.routes.length,0);await page.locator('#email').fill(s.input.email);
 await page.evaluate(()=>document.getElementById('bookingForm').dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:document.getElementById('payLaterBtn')})));assert.equal(h.records().length,0);assert.equal(h.state.routes.length,0);
 await quote(s);const calls=h.state.routes.length;await page.locator('#bookingBack').click();assert.equal(await s.state(),'2');assert.equal(await page.locator('#notes').inputValue(),s.input.notes);await quote(s);assert.equal(h.state.routes.length,calls+1);
 await page.locator('#bookingEditTrip').click();assert.equal(await s.state(),'1');assert.equal(await page.locator('#pickup').inputValue(),s.input.pickup);await page.locator('#time').fill('13:00');await page.locator('#bookingContinue').click();assert.equal(await page.locator('#email').inputValue(),s.input.email);await quote(s);assert.match(await page.locator('#sumPickupTime').innerText(),/1:00 PM/);
 // A silent programmatic edit must also fail the local quote/input comparison.
 await page.evaluate(()=>document.getElementById('notes').value='Changed without an input event');await page.locator('#payBtn').click();assert.equal(await s.state(),'2');assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);assert.match(await page.locator('#notice').innerText(),/updated quote/);await quote(s);await layout(s);
 const resizedWidth=width===1440?320:1440;await page.setViewportSize({width:resizedWidth,height:1000});assert.equal(await s.state(),'3');assert.equal(await page.locator('#payBtn').isEnabled(),true);await layout(s);
 results.push({scenario:'navigation_and_guards',width,resizedWidth,passed:true});
});

test('quote errors, late responses, revision changes and browser restoration preserve inputs',{timeout:30000},async t=>{
 const s=await setup(t,390),{page,h}=s;await details(s);await customer(s);
 h.state.googleError=true;const failed=page.waitForResponse(r=>r.url()===h.url+'/api/quote');await page.locator('#quoteBtn').click();assert.ok((await failed).status()>=400);await page.waitForFunction(()=>!document.getElementById('quoteBtn').disabled);assert.equal(await s.state(),'2');assert.equal(await page.locator('#notes').inputValue(),s.input.notes);h.state.googleError=false;
 h.state.googleDelay=250;const started=page.waitForRequest(r=>r.url()===h.url+'/api/quote');await page.locator('#quoteBtn').click();await started;await page.locator('#bookingBack').click();await page.locator('#time').fill('14:00');h.state.googleDelay=0;await page.locator('#bookingContinue').click();await quote(s);assert.match(await page.locator('#sumPickupTime').innerText(),/2:00 PM/);
 // Backend recalculation still rejects changed prices before reservation creation.
 const original=h.state.routeResult;h.state.routeResult=r=>({...original(r),distanceMeters:200000});const rejected=page.waitForResponse(r=>r.url()===h.url+'/api/checkout');await page.locator('#payLaterBtn').click();assert.equal((await rejected).status(),409);await page.waitForFunction(()=>document.getElementById('book').dataset.bookingStep==='2');assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);assert.match(await page.locator('#notice').innerText(),/quote changed/);await quote(s);
 await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));assert.equal(await s.state(),'2');assert.equal(await page.locator('#notes').inputValue(),s.input.notes);assert.equal(await page.locator('#payBtn').isEnabled(),false);await quote(s);await layout(s);results.push({scenario:'errors_stale_quote_revision_restore',width:390,passed:true});
});

test('temporary checkout failure permits retry without losing the reviewed fare',{timeout:30000},async t=>{
 const s=await setup(t,390),{page,h}=s;await details(s);await customer(s);const q=await quote(s);
 const fail=route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Checkout is temporarily unavailable. Please try again.'})});await page.route('**/api/checkout',fail);
 const rejected=page.waitForResponse(r=>r.url()===h.url+'/api/checkout');await page.locator('#payBtn').click();assert.equal((await rejected).status(),503);await page.waitForFunction(()=>!document.getElementById('payBtn').disabled);assert.equal(await s.state(),'3');assert.equal(h.records().length,0);assert.equal(await page.locator('#sumTotal').innerText(),new Intl.NumberFormat('en-US',{style:'currency',currency:q.currency}).format(q.total));
 await page.unroute('**/api/checkout',fail);await page.locator('#payLaterBtn').click();await page.waitForURL(url=>url.pathname==='/success.html');assert.equal(h.records().length,1);assert.equal(h.records()[0].quote.total,q.total);assert.equal(h.state.creates.length,0);results.push({scenario:'checkout_retry',width:390,passed:true});
});

test('invalid promo is recoverable and selecting the $150 special excludes FIRST15',{timeout:30000},async t=>{
 const s=await setup(t,390),{page,h}=s;await details(s);await customer(s);await page.locator('#promoCode').fill('INVALID');const rejected=page.waitForResponse(r=>r.url()===h.url+'/api/quote');await page.locator('#quoteBtn').click();assert.equal((await rejected).status(),400);await page.waitForFunction(()=>!document.getElementById('quoteBtn').disabled);assert.equal(await s.state(),'2');assert.equal(h.records().length,0);assert.equal(await page.locator('#email').inputValue(),s.input.email);
 await page.locator('#promoCode').fill('FIRST15');assert.equal((await quote(s)).promotion.code,'FIRST15');await page.locator('#ewrManhattanSpecialBtn').click();assert.equal(await s.state(),'1');assert.equal(await page.locator('#promoCode').inputValue(),'');assert.equal(await page.locator('#promoCode').isEnabled(),false);await page.locator('#dropoff').fill('Manhattan');await page.locator('#bookingContinue').click();const special=await quote(s);assert.equal(special.totalCents,15000);assert.equal(special.discount,0);assert.equal(special.promotion,null);assert.equal(special.tolls.status,'included');results.push({scenario:'promo_and_special_restriction',width:390,passed:true});
});

test('late GPS completion cannot change a pickup after leaving Trip Details',{timeout:30000},async t=>{
 const s=await setup(t,390),{page,h}=s;await page.evaluate(()=>{navigator.geolocation.getCurrentPosition=success=>{window.finishMockGps=success;};});
 await page.locator('#currentLocationBtn').click();assert.match(await page.locator('#pickupLocationStatus').innerText(),/Detecting your location/);
 // Fill a selected address while the old native callback remains outstanding.
 // The component already ignores manual edits; Step 1 also cancels a pending
 // lookup when an existing address is accepted without another edit below.
 await page.locator('#pickup').fill(s.input.pickup);await page.locator('#pickup').focus();await page.locator('#pickupSuggestions .current-location-option').click();
 const finish=await page.evaluate(()=>typeof window.finishMockGps==='function');assert.equal(finish,true);
 await page.locator('#dropoff').fill(s.input.dropoff);await page.locator('#date').fill(s.input.date);await page.locator('#time').fill(s.input.time);await page.locator('#bookingContinue').click();await customer(s);await quote(s);const calls=h.state.googleCalls;
 await page.evaluate(async()=>window.finishMockGps({coords:{latitude:40.7,longitude:-74.17}}));assert.equal(await s.state(),'3');assert.equal(await page.locator('#sumPickup').innerText(),s.input.pickup);assert.equal(h.state.googleCalls,calls);assert.equal(await page.locator('#payBtn').isEnabled(),true);results.push({scenario:'late_gps_after_continue',width:390,passed:true});
});

for(const width of [320,390,1440])test('uncertain geometry invalidates the old quote; recovery preserves inputs and server cents / '+width+'px',{timeout:30000},async t=>{
 const s=await setup(t,width),{page,h}=s;await details(s);await customer(s);const original=h.state.routeResult,q=await quote(s);
 assert.equal(await page.locator('#sumTotal').innerText(),'$'+(q.totalCents/100).toFixed(2));await page.locator('#bookingBack').click();
 h.state.routeResult=()=>({distanceMeters:100000,duration:'1500s',staticDuration:'1200s'});
 const pending=page.waitForResponse(r=>r.url()===h.url+'/api/quote');await page.locator('#quoteBtn').click();assert.equal((await pending).status(),422);await page.waitForFunction(()=>!document.getElementById('quoteBtn').disabled);
 assert.equal(await s.state(),'2');assert.equal(await page.locator('#notice').innerText(),'Toll estimate unavailable — contact us for a final quote');assert.equal(await page.locator('#payBtn').isEnabled(),false);assert.equal(await page.locator('#payLaterBtn').isEnabled(),false);assert.equal(await page.locator('#sumTotal').innerText(),'Contact us');assert.equal(await page.locator('#notes').inputValue(),s.input.notes);assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);assert.equal(await page.evaluate(()=>Math.max(0,document.documentElement.scrollWidth-innerWidth)),0);
 h.state.routeResult=original;const recovered=await quote(s);assert.equal(recovered.totalCents,q.totalCents);await layout(s);assert.equal(await page.locator('#sumTotal').innerText(),'$'+(recovered.totalCents/100).toFixed(2));results.push({scenario:'uncertain_geometry_recovery',width,passed:true});
});

test('a successful HTTP response carrying the old absorbed fallback cannot enable payment',{timeout:30000},async t=>{
 const s=await setup(t,390),{page,h}=s;await details(s);await customer(s);const q=(await h.request('/api/quote',s.input)).body;
 await page.route('**/api/quote',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...q,tolls:{status:'absorbed',amountCents:0},pricingBreakdown:{...q.pricingBreakdown,tollsCents:0}})}));
 await page.locator('#quoteBtn').click();await page.waitForFunction(()=>!document.getElementById('quoteBtn').disabled);assert.equal(await s.state(),'2');assert.equal(await page.locator('#notice').innerText(),'Toll estimate unavailable — contact us for a final quote');assert.equal(await page.locator('#payBtn').isEnabled(),false);assert.equal(await page.locator('#payLaterBtn').isEnabled(),false);assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);results.push({scenario:'legacy_fallback_response_denied',width:390,passed:true});
});
