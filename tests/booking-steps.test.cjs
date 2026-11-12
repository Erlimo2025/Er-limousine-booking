'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8').replace(/\r\n/g,'\n');
function ui(){
 const events={},fields={},requests=[],messages=[];
 function element(value=''){return {value,required:false,disabled:false,hidden:false,textContent:'',dataset:{},custom:'',classList:{remove(){},add(){}},
  addEventListener(name,fn){this[name]=fn;},setCustomValidity(text){this.custom=text;},checkValidity(){return !this.custom&&(!this.required||!!this.value.trim());},reportValidity(){this.reported=true;},focus(){this.focused=true;},scrollIntoView(){},replaceChildren(...children){this.children=children;}};}
 for(const [key,value]of Object.entries({pickup:'Orange, NJ',dropoff:'Times Square, NY',date:'2026-11-10',time:'12:00',vehicle:'suv',passengers:'2',firstName:'Test',lastName:'Customer',email:'test@example.test',phone:'2025550199',notes:'Keep these notes',promoCode:''}))fields[key]=element(value);
 for(const key of ['pickup','dropoff','date','time','vehicle','passengers','firstName','lastName','email','phone'])fields[key].required=true;
 for(const id of ['bookingBack','bookingEditTrip','bookingContinue','bookingStepLabel','bookingSummaryHeading','sumPickup','sumDestination','sumPickupTime','summaryReturnRow','sumReturnTime','bookingPolicyDetails','bookingPolicyDialog','bookingPolicySummary','bookingPolicyTiers'])fields[id]=element();
 const tripKeys=['pickup','dropoff','date','time','vehicle','passengers'],customerKeys=['firstName','lastName','email','phone','notes','promoCode'];
 const tripStep={querySelectorAll:()=>tripKeys.map(k=>fields[k]),contains:e=>tripKeys.some(k=>fields[k]===e)},customerStep={querySelectorAll:()=>customerKeys.map(k=>fields[k])};
 const ctx={TripDateFormat:require('../public/trip-date-format'),AbortController,JSON,Number,...fields,tripStep,customerStep,summaryStep:element(),activeBookingStep:1,bookingPanel:element(),reservationBusy:false,quoteRequestGeneration:0,quoteController:null,quotedFormKey:null,currentQuote:null,replacementQuote:null,
  document:{getElementById:id=>fields[id],createElement:()=>element()},form:{addEventListener:(name,fn)=>events[name]=fn},quoteBtn:element(),payBtn:element(),payLaterBtn:element(),quoteArea:element(),promoSummary:element(),hours:element('3'),
  bookingContactMemory:{restore(){},isOptedIn:()=>false},bookingStopEditor:null,
  clearNotice(){messages.length=0;},showNotice(text){messages.push(text);},showPromoResult(){},renderFareBreakdown(){},formatMoney:n=>'$'+n.toFixed(2),
  getFormData:()=>Object.fromEntries([...tripKeys,...customerKeys].map(k=>[k,fields[k].value])),window:{location:{},addEventListener:(name,fn)=>events[name]=fn}};
 for(const name of ['sumVehicle','sumMiles','sumMinutes','sumTotal','sumMilesLabel','sumMinutesLabel','sumTotalLabel'])ctx[name]=element();
 ctx.vehicle.options=[{textContent:'Luxury SUV'}];ctx.vehicle.selectedIndex=0;
 const quote={vehicle:'Black SUV',vehicleKey:'suv',miles:10,minutes:20,total:80,currency:'usd',quoteRevision:'a'.repeat(64),quoteApproval:'reviewed-quote-token',
  cancellationPolicy:require('../services/cancellation-policy').currentPolicy};
 ctx.fetch=async(url,options)=>{requests.push({url,body:JSON.parse(options.body),options});return {ok:true,json:async()=>url==='/api/quote'?{...quote}:{url:'https://checkout.example.test/mock'}};};
 vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('function showBookingStep('),source.indexOf('const flightField')),ctx);
 vm.runInContext(source.slice(source.indexOf('function renderBookingPolicy('),source.indexOf('/* =========================================\n   SPECIAL OFFER')),ctx);
 vm.runInContext(source.slice(source.indexOf('function displayQuoteForReview('),source.indexOf('quoteBtn.addEventListener(',source.indexOf('async function requestQuote('))),ctx);
 const start=source.indexOf('form.addEventListener(\n  "input"');
 vm.runInContext(source.slice(start,source.indexOf('/* =========================================\n   FLEET BOOK BUTTONS',start)),ctx);
 vm.runInContext(source.slice(source.indexOf('// Restore booking controls after browser Back;')),ctx);
 const submit=choice=>events.submit({preventDefault(){},submitter:{id:choice==='later'?'payLaterBtn':'payBtn'}});
 ctx.showBookingStep(1);
 return {ctx,fields,events,requests,messages,quote,submit,continue:()=>ctx.requestQuote({currentTarget:ctx.quoteBtn})};
}

test('three-step navigation preserves input and only exposes the current panel',()=>{
 const h=ui();h.ctx.continueBooking();assert.equal(h.ctx.activeBookingStep,2);assert.equal(h.ctx.tripStep.hidden,true);assert.equal(h.ctx.customerStep.hidden,false);assert.equal(h.ctx.summaryStep.hidden,true);
 h.fields.bookingBack.click();assert.equal(h.ctx.activeBookingStep,1);assert.equal(h.fields.notes.value,'Keep these notes');assert.equal(h.fields.pickup.value,'Orange, NJ');
 assert.equal(h.ctx.payBtn.disabled,true);assert.equal(h.ctx.payLaterBtn.disabled,true);
});
test('required trip and customer inputs fail before any quote request without losing data',async()=>{
 const h=ui();h.fields.pickup.value=' ';h.ctx.continueBooking();assert.equal(h.ctx.activeBookingStep,1);assert.ok(h.fields.pickup.reported);
 h.fields.pickup.value='Orange, NJ';h.ctx.continueBooking();h.fields.firstName.value=' ';assert.equal(await h.continue(),null);assert.equal(h.ctx.activeBookingStep,2);assert.equal(h.requests.length,0);assert.ok(h.fields.firstName.reported);assert.equal(h.fields.notes.value,'Keep these notes');
});
test('Trip Details waits for GPS confirmation or correction before continuing and preserves the selected address',async()=>{
 const h=ui();let cancelled=0,confirmed=false;h.ctx.pickupLocation={cancel(){cancelled++;},validate:()=>confirmed};
 h.ctx.continueBooking();assert.equal(h.ctx.activeBookingStep,1);assert.equal(cancelled,0);await h.continue();assert.equal(h.requests.length,0);
 confirmed=true;h.fields.pickup.value='';h.ctx.continueBooking();assert.equal(cancelled,0);h.fields.pickup.value='Orange, NJ';h.ctx.continueBooking();assert.equal(cancelled,1);assert.equal(h.fields.pickup.value,'Orange, NJ');assert.equal(h.ctx.activeBookingStep,2);
});
test('early and implicit submissions cannot quote-and-pay or create a reservation',async()=>{
 const h=ui();await h.submit('now');h.ctx.continueBooking();await h.submit('later');assert.equal(h.requests.length,0);assert.equal(h.ctx.activeBookingStep,2);
});
for(const choice of ['now','later'])test('Step 3 '+choice+' sends the reviewed server revision and preserves the server total',async()=>{
 const h=ui();h.ctx.continueBooking();await h.continue();assert.equal(h.ctx.activeBookingStep,3);
 assert.equal(h.ctx.payBtn.disabled,false);assert.equal(h.ctx.payLaterBtn.disabled,false);
 assert.equal(h.ctx.currentQuote.total,80);assert.equal(h.ctx.sumTotal.textContent,'$80.00');await h.submit(choice);
 const sent=h.requests.find(r=>r.url==='/api/checkout').body;assert.equal(sent.quoteRevision,h.quote.quoteRevision);assert.equal(sent.paymentChoice,choice);assert.equal(sent.total,undefined);assert.equal(Object.hasOwn(sent,'cancellationPolicyAcceptance'),false);assert.equal(Object.hasOwn(sent,'cancellationPolicyAtBooking'),false);assert.equal(sent.notes,'Keep these notes');assert.equal(h.ctx.window.location.href,'https://checkout.example.test/mock');
});
test('an input edit invalidates the quote and cannot silently reprice and pay',async()=>{
 const h=ui();h.ctx.continueBooking();await h.continue();h.fields.phone.value='2025550100';h.events.input({target:h.fields.phone});await h.submit('now');assert.equal(h.ctx.activeBookingStep,2);assert.equal(h.ctx.currentQuote,null);assert.equal(h.ctx.payBtn.disabled,true);assert.equal(h.requests.filter(r=>r.url==='/api/quote').length,1);assert.equal(h.requests.filter(r=>r.url==='/api/checkout').length,0);assert.equal(h.fields.notes.value,'Keep these notes');
});
test('programmatic edits without DOM events are detected before either payment choice',async()=>{
 const h=ui();h.ctx.continueBooking();await h.continue();h.fields.pickup.value='Newark, NJ';await h.submit('later');assert.equal(h.ctx.currentQuote,null);assert.equal(h.ctx.activeBookingStep,2);assert.equal(h.requests.filter(r=>r.url==='/api/checkout').length,0);
});
test('late quote responses cannot restore an invalid quote even when a provider ignores abort',async()=>{
 const h=ui();h.ctx.continueBooking();let release;h.ctx.fetch=()=>new Promise(r=>release=r);const old=h.continue();h.fields.pickup.value='Newark, NJ';h.events.input({target:h.fields.pickup});release({ok:true,json:async()=>h.quote});assert.equal(await old,null);assert.equal(h.ctx.currentQuote,null);assert.equal(h.ctx.payBtn.disabled,true);assert.equal(h.ctx.activeBookingStep,2);assert.equal(h.ctx.quoteBtn.disabled,false);
});
test('repeated Continue and payment actions do not start duplicate requests',async()=>{
 const h=ui();h.ctx.continueBooking();let release,calls=0;h.ctx.fetch=()=>{calls++;return new Promise(r=>release=r);};const pending=h.continue();assert.equal(await h.continue(),null);assert.equal(calls,1);release({ok:true,json:async()=>h.quote});await pending;
 const payment=h.submit('now');await h.submit('later');assert.equal(calls,2);assert.equal(h.fields.bookingBack.disabled,true);release({ok:true,json:async()=>({url:'https://checkout.example.test/mock'})});await payment;
});
test('failed quotes stay on Customer Information and can be retried with the same inputs',async()=>{
 const h=ui();h.ctx.continueBooking();const working=h.ctx.fetch;h.ctx.fetch=async()=>({ok:false,json:async()=>({error:'Route estimate unavailable. Please try again.'})});assert.equal(await h.continue(),null);assert.equal(h.ctx.activeBookingStep,2);assert.equal(h.ctx.quoteBtn.disabled,false);assert.equal(h.ctx.payBtn.disabled,true);assert.equal(h.fields.email.value,'test@example.test');assert.match(h.messages[0],/unavailable/);h.ctx.fetch=working;await h.continue();assert.equal(h.ctx.activeBookingStep,3);
});
test('a server quoteRevision conflict requires a new review before payment can be retried',async()=>{
 const h=ui();h.ctx.continueBooking();await h.continue();const working=h.ctx.fetch;h.ctx.fetch=async()=>({ok:false,status:409,json:async()=>({error:'Your quote changed. Please get a new quote before reserving.'})});await h.submit('now');assert.equal(h.ctx.activeBookingStep,2);assert.equal(h.ctx.currentQuote,null);assert.equal(h.ctx.payLaterBtn.disabled,true);assert.equal(h.ctx.quoteBtn.disabled,false);h.ctx.fetch=working;h.quote.total=90;h.quote.quoteRevision='b'.repeat(64);await h.continue();assert.equal(h.ctx.currentQuote.total,90);assert.equal(h.ctx.activeBookingStep,3);assert.equal(h.ctx.payBtn.disabled,false);assert.equal(h.ctx.payLaterBtn.disabled,false);
});
test('Back/Edit, viewport-independent navigation and browser restoration require a fresh review',async()=>{
 const h=ui();h.ctx.continueBooking();await h.continue();h.fields.bookingEditTrip.click();assert.equal(h.ctx.activeBookingStep,1);assert.equal(h.ctx.currentQuote,null);assert.equal(h.fields.email.value,'test@example.test');h.ctx.continueBooking();await h.continue();h.events.pageshow({persisted:true});assert.equal(h.ctx.activeBookingStep,2);assert.equal(h.ctx.currentQuote,null);assert.equal(h.ctx.payLaterBtn.disabled,true);assert.equal(h.fields.notes.value,'Keep these notes');
});
test('a promo preview cannot unlock payment; continuing always obtains another fresh quote',async()=>{
 const h=ui();h.ctx.continueBooking();await h.ctx.requestQuote();assert.equal(h.ctx.activeBookingStep,2);assert.equal(h.ctx.payBtn.disabled,true);await h.continue();assert.equal(h.requests.length,2);assert.equal(h.ctx.activeBookingStep,3);
});

for(const status of ['absorbed','unknown','review_required'])test('an unavailable toll payload cannot unlock Step 3 or either payment action: '+status,async()=>{
 const h=ui();h.quote.tolls={status,amountCents:null};h.ctx.continueBooking();assert.equal(await h.continue(),null);
 assert.equal(h.ctx.activeBookingStep,2);assert.equal(h.ctx.currentQuote,null);assert.equal(h.ctx.payBtn.disabled,true);assert.equal(h.ctx.payLaterBtn.disabled,true);assert.equal(h.fields.notes.value,'Keep these notes');assert.match(h.messages.at(-1),/Toll estimate unavailable/);
 await h.submit('now');await h.submit('later');assert.equal(h.requests.filter(r=>r.url==='/api/checkout').length,0);
});


test('a replacement quote stays in Trip Summary and only the next explicit payment choice submits it', async () => {
  const h = ui();
  h.ctx.continueBooking();
  await h.continue();
  const originalFetch = h.ctx.fetch;
  let prevented = false;
  const multiClick = {detail: 2, preventDefault() {prevented = true;}};
  h.ctx.payBtn.click(multiClick);
  assert.equal(prevented, false);
  let calls = 0;
  h.ctx.fetch = async (url, options) => {
    calls++;
    assert.equal(JSON.parse(options.body).quoteApproval, h.quote.quoteApproval);
    return {ok: false, status: 409, json: async () => ({
      code: 'QUOTE_CHANGED', reason: 'route', quote: {...h.quote, total: 92.5, minutes: 30, quoteApproval: 'updated-review-token'}
    })};
  };
  await h.submit('now');
  assert.equal(calls, 1);
  assert.equal(h.ctx.window.location.href, undefined);
  assert.equal(h.ctx.activeBookingStep, 3);
  assert.equal(h.ctx.sumTotal.textContent, '$92.50');
  assert.match(h.messages.at(-1), /Your trip price has changed/);
  h.ctx.payBtn.click(multiClick);
  assert.equal(prevented, true);
  h.ctx.fetch = originalFetch;
  await h.submit('later');
  const sent = h.requests.filter(request => request.url === '/api/checkout').at(-1);
  assert.equal(sent.body.quoteApproval, 'updated-review-token');
  assert.equal(sent.body.paymentChoice, 'later');
});
