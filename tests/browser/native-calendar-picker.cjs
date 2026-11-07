'use strict';
// Sequential, isolated provider/storage fixtures. Chromium assertions exercise a
// real native popup, selection and Clear. WebKit on Windows has no iOS OS picker;
// its assertions cover trusted native hit/focus and date-change synchronization.
// It reports date inputs as text; it is not evidence of an iPhone OS popup.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {create,cases}=require('../helpers/booking-browser.cjs');
const engine=process.env.ER_TEST_PICKER_ENGINE||'chromium';let browser;const results=[];
test.before(async()=>{assert.ok(['chromium','webkit','firefox'].includes(engine));const playwright=require(process.env.ER_TEST_PLAYWRIGHT_MODULE||'playwright');const executablePath=engine==='webkit'?process.env.ER_TEST_WEBKIT_EXECUTABLE:engine==='firefox'?process.env.ER_TEST_FIREFOX_EXECUTABLE:process.env.ER_TEST_BROWSER_EXECUTABLE;browser=await playwright[engine].launch({headless:true,...(executablePath?{executablePath}:{})});});
test.after(async()=>{if(browser)await browser.close();if(process.env.ER_TEST_PICKER_RESULTS_FILE)fs.writeFileSync(process.env.ER_TEST_PICKER_RESULTS_FILE,JSON.stringify({mode:'isolated_mock_only',engine,nativePopupTested:engine!=='webkit',nativePopupSelectionTested:engine==='chromium',passed:results.length,realGoogleCalls:0,liveStripeCalls:0,results},null,2)+'\n');});
const profiles=[{name:'desktop mouse',mode:'throws',touch:false},{name:'phone touch / silent showPicker',mode:'noop',touch:true},{name:'phone touch / absent showPicker',mode:'missing',touch:true}];
async function setup(t,width,profile){
 const {h,input}=await create(t,cases.find(c=>c.id==='round_trip')),context=await browser.newContext({viewport:{width,height:1000},locale:'en-GB',timezoneId:'Asia/Tokyo',isMobile:profile.touch,hasTouch:profile.touch});t.after(()=>context.close());
 await context.addInitScript(mode=>{
  const NativeDate=Date,fixed=Date.parse('2026-10-01T16:00:00Z');window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};
  window.pickerCalls=0;Object.defineProperty(HTMLInputElement.prototype,'showPicker',{configurable:true,value:mode==='missing'?undefined:()=>{window.pickerCalls++;if(mode==='throws')throw Error('Unsupported picker');}});
  window.nativeClicks=[];window.cspFailures=[];document.addEventListener('click',event=>{if(event.target.matches?.('.us-date-native'))window.nativeClicks.push({id:event.target.id,trusted:event.isTrusted});},true);document.addEventListener('securitypolicyviolation',e=>window.cspFailures.push(e.effectiveDirective));
 },profile.mode);
 await context.route('**/*',r=>new URL(r.request().url()).origin===h.url?r.continue():r.abort());const page=await context.newPage();page.setDefaultTimeout(12000);await page.goto(h.url+'/#book',{waitUntil:'networkidle'});return {h,input,page,profile};
}
async function tapNative(s,id){
 const field=s.page.locator('#'+id);await field.scrollIntoViewIfNeeded();const hit=await field.evaluate(e=>{const r=e.getBoundingClientRect();return {id:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.id,width:r.width,height:r.height,hidden:e.getAttribute('aria-hidden'),tabIndex:e.tabIndex,label:e.getAttribute('aria-label')};});
 assert.equal(hit.id,id,'The real native control must receive the icon tap');assert.ok(hit.width>=40&&hit.height>=40);assert.notEqual(hit.hidden,'true');assert.ok(hit.tabIndex>=0);assert.match(hit.label,/Choose .*from calendar/);
 if(s.profile.touch)await field.tap();else await field.click();
 assert.equal(await field.evaluate(e=>e===document.activeElement),true);const click=await s.page.evaluate(()=>window.nativeClicks.at(-1));assert.deepEqual(click,{id,trusted:true});assert.equal(await s.page.evaluate(()=>window.pickerCalls),0);
 if(engine!=='webkit'){
  assert.equal(await field.evaluate(e=>e.matches(':open')),true,'The native calendar must actually open, not just invoke an API');
  if(process.env.ER_TEST_PICKER_SCREENSHOTS_DIR&&!s.profile.touch&&id==='date'&&await field.inputValue()==='2026-11-17'){fs.mkdirSync(process.env.ER_TEST_PICKER_SCREENSHOTS_DIR,{recursive:true});await s.page.screenshot({path:path.join(process.env.ER_TEST_PICKER_SCREENSHOTS_DIR,'native-calendar-'+s.page.viewportSize().width+'.png')});}
 }return field;
}
async function chooseNext(s,id,expected){
 const field=await tapNative(s,id);
 if(engine==='chromium'){await s.page.keyboard.press('ArrowRight');await s.page.keyboard.press('Enter');assert.equal(await field.evaluate(e=>e.matches(':open')),false);}
 else {if(engine==='firefox')await s.page.keyboard.press('Escape');await field.fill(expected);} // OS chooser selection cannot be driven here; native value editing still synchronizes.
 assert.equal(await field.inputValue(),expected);assert.equal(await s.page.locator('#'+id+'-display').inputValue(),require('../../public/trip-date-format').date(expected));
}
async function clear(s,id){
 const field=await tapNative(s,id);if(engine==='chromium'){await s.page.keyboard.press('Tab');await s.page.keyboard.press('Enter');assert.equal(await field.evaluate(e=>e.matches(':open')),false);}else {if(engine==='firefox')await s.page.keyboard.press('Escape');await s.page.locator('#'+id+'-display').fill('');}
 assert.equal(await field.inputValue(),'');assert.equal(await s.page.locator('#'+id+'-display').inputValue(),'');
}
async function quote(s){
 // Commit the active text edit before clicking Continue (the same action as
 // leaving a phone keyboard with Next/Done). WebKit emits change on blur.
 await s.page.keyboard.press('Tab');const response=s.page.waitForResponse(r=>r.url()===s.h.url+'/api/quote');response.catch(()=>{});await s.page.locator('#quoteBtn').click();assert.deepEqual(await s.page.locator('#bookingForm :invalid').evaluateAll(inputs=>inputs.map(e=>({id:e.id,message:e.validationMessage}))),[]);const r=await response;assert.equal(r.status(),200);await s.page.waitForFunction(()=>document.getElementById('book').dataset.bookingStep==='3');await s.page.locator('#cancelPolicyAccepted').check();return {body:await r.json(),sent:r.request().postDataJSON()};
}
for(const width of [320,390,1440])for(const profile of engine==='firefox'?profiles.slice(0,1):profiles)test(engine+' / '+profile.name+' / pickup, return, clear and quote refresh / '+width+'px',{timeout:45000},async t=>{
 const s=await setup(t,width,profile),{page,h,input}=s;await page.locator('[data-trip-type="roundtrip"]').click();await page.locator('#pickup').fill(input.pickup);await page.locator('#dropoff').fill(input.dropoff);await page.locator('#vehicle').selectOption('suv');
 for(const [id,value]of [['date','11/17/2026'],['time','1:30 PM'],['returnDate','11/20/2026'],['returnTime','6:00 PM']])await page.locator('#'+id+'-display').fill(value);
 await chooseNext(s,'date','2026-11-18');await chooseNext(s,'returnDate','2026-11-21');
 // Real popup Clear must synchronize the US field and keep required validation.
 for(const [id,value]of [['date','11/18/2026'],['returnDate','11/21/2026']]){await clear(s,id);await page.locator('#bookingContinue').click();assert.equal(await page.locator('#book').getAttribute('data-booking-step'),'1');await page.locator('#'+id+'-display').fill(value);}
 await page.locator('#bookingContinue').click();assert.equal(await page.locator('#book').getAttribute('data-booking-step'),'2',JSON.stringify(await page.locator('#bookingTripStep input:invalid').evaluateAll(inputs=>inputs.map(e=>({id:e.id,type:e.type,message:e.validationMessage,value:e.value})))));for(const key of ['firstName','lastName','email','phone','notes'])await page.locator('#'+key).fill(input[key]);const first=await quote(s);assert.equal(first.sent.date,'2026-11-18');assert.equal(first.sent.returnDate,'2026-11-21');assert.equal(first.sent.time,'13:30');assert.equal(first.sent.returnTime,'18:00');assert.match(await page.locator('#sumPickupTime').innerText(),/11\/18\/2026 · 1:30 PM/);assert.match(await page.locator('#sumReturnTime').innerText(),/11\/21\/2026 · 6:00 PM/);
 await page.locator('#bookingEditTrip').click();await chooseNext(s,'date','2026-11-19');await chooseNext(s,'returnDate','2026-11-22');assert.equal(await page.locator('#payBtn').isEnabled(),false);assert.equal(await page.locator('#payLaterBtn').isEnabled(),false);
 await page.evaluate(()=>document.getElementById('bookingForm').dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:document.getElementById('payBtn')})));assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);
 await page.locator('#bookingContinue').click();assert.equal(await page.locator('#notes').inputValue(),input.notes);const fresh=await quote(s);assert.notEqual(fresh.body.quoteRevision,first.body.quoteRevision);assert.equal(fresh.sent.date,'2026-11-19');assert.equal(fresh.sent.returnDate,'2026-11-22');assert.equal(await page.locator('#payBtn').isEnabled(),true);assert.equal(await page.locator('#payLaterBtn').isEnabled(),true);
 // A native autofill/change event also invalidates an already reviewed quote.
 await page.evaluate(()=>{const date=document.getElementById('date');date.value='2026-11-20';date.dispatchEvent(new Event('change',{bubbles:true}));});assert.equal(await page.locator('#payBtn').isEnabled(),false);assert.equal(await page.locator('#payLaterBtn').isEnabled(),false);assert.equal(h.records().length,0);
 assert.deepEqual(await page.evaluate(()=>({overflow:Math.max(0,document.documentElement.scrollWidth-innerWidth),calls:window.pickerCalls,csp:window.cspFailures})),{overflow:0,calls:0,csp:[]});results.push({width,profile:profile.name,passed:true});
});
