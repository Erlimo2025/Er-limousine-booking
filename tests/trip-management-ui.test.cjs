const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../public/account.js'),'utf8');
const walk=n=>[n,...n.children.flatMap(walk)];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function ui(overrides={}){
 const state={calls:[],refreshes:0,clears:0,view:null,next:null},elements={dashboardView:{hidden:false},tripsStatus:{textContent:''}};
 const node=tag=>({tag,children:[],textContent:'',hidden:false,disabled:false,events:{},attributes:{},append(...children){this.children.push(...children)},addEventListener(name,handler){this.events[name]=handler},setAttribute(name,value){this.attributes[name]=value},focus(){this.focused=true}});
 const context={document:{createElement:node},Intl,crypto:{randomUUID:()=>crypto.randomUUID()},accountGeneration:1,tripsGeneration:1,el:id=>elements[id],
  api:async(url,body)=>{state.calls.push({url,body:JSON.parse(JSON.stringify(body))});if(state.next){const next=state.next;state.next=null;return next;}return {ok:true};},
  loadTrips:async()=>{state.refreshes++;context.tripsGeneration+=2;return context.tripsGeneration;},clearPrivateAccount:()=>{state.clears++;elements.dashboardView.hidden=true;context.tripsGeneration++;},show:view=>state.view=view};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function tripCard('),source.indexOf('async function loadTrips')),context);
 const trip={reference:crypto.randomUUID(),status:'awaiting_payment',paymentStatus:'unpaid',pickup:'Airport',dropoff:'Manhattan',date:'2026-11-10',time:'12:00',vehicle:'Luxury SUV',total:150,currency:'usd',tripType:'oneway',passengers:3,createdAt:'2026-10-01T16:00:00Z',canBookAgain:true,
  management:{pickupAt:'2026-11-10T17:00:00Z',serverNow:'2026-10-01T16:00:00Z',canChangePickupTime:true,canCancel:true,cancelReason:null,contact:{phone:'(973) 847-4128',email:'bookings@example.test'}},...overrides};
 const card=context.tripCard(trip),nodes=walk(card),find=text=>nodes.find(n=>n.textContent===text),form=nodes.find(n=>n.tag==='form');
 const click=text=>find(text)?.events.click?.(),submit=()=>form.events.submit({preventDefault(){}});
 return {context,state,elements,trip,card,nodes,find,form,click,submit,date:nodes.find(n=>n.type==='date'),time:nodes.find(n=>n.type==='time'),consent:nodes.find(n=>n.type==='checkbox')};
}

test('My Trips management follows only server eligibility; paid/unpaid inside 24 hours can change time',()=>{
 for(const paymentStatus of ['paid','unpaid']){
  const h=ui({paymentStatus,management:{pickupAt:'2026-10-01T17:00:00Z',serverNow:'2026-10-01T16:00:00Z',canChangePickupTime:true,canCancel:false,cancelReason:'within_24_hours',contact:{phone:'(973) 847-4128',email:'bookings@example.test'}}});
  assert.ok(h.find('Change Pickup Time'));assert.ok(!h.find('Cancel Trip'));assert.ok(h.nodes.some(n=>/Online cancellation is unavailable within 24 hours/.test(n.textContent)));
  assert.equal(h.nodes.find(n=>n.href?.startsWith('tel:')).href,'tel:9738474128');assert.equal(h.nodes.find(n=>n.href?.startsWith('mailto:')).href,'mailto:bookings@example.test');
  assert.ok(h.find('Book Again'));assert.equal(!!h.find('Complete Payment'),paymentStatus==='unpaid');
 }
 const inactive=ui({status:'cancelled',management:{canChangePickupTime:false,canCancel:false,cancelReason:'inactive'}});assert.ok(!inactive.find('Change Pickup Time'));assert.ok(!inactive.find('Cancel Trip'));assert.equal(inactive.nodes.find(n=>n.className==='trip-management').hidden,true);
 const paid=ui({paymentStatus:'paid'});assert.ok(paid.find('Cancel Trip'));assert.ok(paid.find('Change Pickup Time'));assert.ok(!paid.find('Complete Payment'));assert.ok(!paid.nodes.some(n=>/Online refunds are not available yet/.test(n.textContent)));assert.ok(!paid.nodes.some(n=>n.textContent==='Refunded'));
});

test('pickup time form is labeled, explicitly confirmed, double-submit guarded and sends only schedule authority',async()=>{
 const h=ui();h.click('Change Pickup Time');assert.equal(h.form.hidden,false);assert.equal(h.date.focused,true);assert.ok(h.nodes.find(n=>n.tag==='label'&&n.htmlFor===h.date.id));assert.ok(h.nodes.find(n=>n.tag==='label'&&n.htmlFor===h.time.id));
 h.submit();await tick();assert.equal(h.state.calls.length,0);assert.match(h.nodes.find(n=>n.className==='trip-management-status').textContent,/confirm the change/);
 let finish;h.state.next=new Promise(resolve=>finish=resolve);h.date.value='2026-11-11';h.time.value='13:30';h.consent.checked=true;h.submit();h.submit();
 assert.equal(h.state.calls.length,1);assert.equal(h.find('Save Pickup Time').disabled,true);assert.equal(h.date.disabled,true);
 const call=h.state.calls[0];assert.equal(call.url,'trips/'+h.trip.reference+'/pickup-time');assert.deepEqual(Object.keys(call.body).sort(),['confirmed','date','expectedPickupAt','requestId','time']);assert.equal(call.body.expectedPickupAt,h.trip.management.pickupAt);assert.equal(call.body.date,'2026-11-11');assert.equal(call.body.time,'13:30');assert.equal(call.body.confirmed,true);assert.match(call.body.requestId,/^[a-f0-9-]{36}$/);
 finish({ok:true});await tick();assert.equal(h.state.refreshes,1);assert.equal(h.elements.tripsStatus.textContent,'Pickup time updated.');assert.ok(h.state.calls.every(c=>!/(checkout|payment|refund)/.test(c.url)));
});

test('same time-change retry retains UUID; changed submission gets a new UUID',async()=>{
 const h=ui();h.consent.checked=true;h.state.next=Promise.reject(Object.assign(new Error('Synthetic failure'),{status:503}));h.submit();await tick();const first=h.state.calls[0].body.requestId;assert.equal(h.find('Save Pickup Time').disabled,false);
 h.state.next=Promise.reject(Object.assign(new Error('Synthetic failure'),{status:503}));h.submit();await tick();assert.equal(h.state.calls[1].body.requestId,first);
 h.date.value='2026-11-12';h.state.next=Promise.reject(Object.assign(new Error('Synthetic failure'),{status:503}));h.submit();await tick();assert.notEqual(h.state.calls[2].body.requestId,first);assert.equal(h.state.refreshes,0);
});

test('cancellation requires a separate deliberate confirmation; retries and conflicts remain safe',async()=>{
 const h=ui();h.click('Cancel Trip');assert.equal(h.state.calls.length,0);assert.equal(h.nodes.find(n=>n.className==='trip-cancel-confirmation').hidden,false);h.click('Keep Trip');assert.equal(h.nodes.find(n=>n.className==='trip-cancel-confirmation').hidden,true);
 h.click('Cancel Trip');let reject;h.state.next=new Promise((_,r)=>reject=r);h.click('Confirm Cancellation');h.click('Confirm Cancellation');assert.equal(h.state.calls.length,1);assert.equal(h.find('Confirm Cancellation').disabled,true);assert.equal(h.state.calls[0].url,'trips/'+h.trip.reference+'/cancel');assert.deepEqual(Object.keys(h.state.calls[0].body).sort(),['confirmed','expectedPickupAt','requestId']);
 reject(Object.assign(new Error('Synthetic failure'),{status:503}));await tick();const first=h.state.calls[0].body.requestId;h.state.next=Promise.reject(Object.assign(new Error('Synthetic conflict'),{status:409}));h.click('Confirm Cancellation');await tick();assert.equal(h.state.calls[1].body.requestId,first);assert.equal(h.state.refreshes,1);assert.match(h.elements.tripsStatus.textContent,/Please review/);
});

for(const action of ['time','cancel'])test(action+' stale success/error/401 cannot mutate a newer My Trips generation',async()=>{
 for(const transition of ['account','trips','both'])for(const status of [null,401,503]){
  const h=ui();let resolve,reject;h.state.next=new Promise((r,j)=>{resolve=r;reject=j;});if(action==='time'){h.consent.checked=true;h.submit();}else{h.click('Cancel Trip');h.click('Confirm Cancellation');}
  if(transition!=='trips')h.context.accountGeneration++;if(transition!=='account')h.context.tripsGeneration++;h.elements.tripsStatus.textContent='New valid session';
  if(status)reject(Object.assign(new Error('Synthetic stale response'),{status}));else resolve({ok:true});await tick();
  assert.equal(h.state.clears,0);assert.equal(h.state.view,null);assert.equal(h.state.refreshes,0);assert.equal(h.elements.dashboardView.hidden,false);assert.equal(h.elements.tripsStatus.textContent,'New valid session');
 }
});

test('stale card clicks and a delayed post-update list refresh cannot overwrite newer trips',async()=>{
 const stale=ui();stale.context.tripsGeneration++;stale.consent.checked=true;stale.submit();stale.click('Cancel Trip');stale.click('Confirm Cancellation');await tick();assert.equal(stale.state.calls.length,0);
 const h=ui();let finish;h.context.loadTrips=async()=>{h.state.refreshes++;const own=h.context.tripsGeneration+=2;await new Promise(resolve=>finish=resolve);return own;};
 h.consent.checked=true;h.submit();await tick();h.context.tripsGeneration++;h.elements.tripsStatus.textContent='Newer authoritative trips';finish();await tick();assert.equal(h.elements.tripsStatus.textContent,'Newer authoritative trips');
});

test('current-generation authentication failure clears private state and uses existing login view',async()=>{
 const h=ui();h.consent.checked=true;h.state.next=Promise.reject(Object.assign(new Error('Synthetic expired session'),{status:401}));h.submit();await tick();assert.equal(h.state.clears,1);assert.equal(h.state.view,'login');assert.equal(h.elements.dashboardView.hidden,true);assert.equal(h.context.accountGeneration,2);
});

test('management contact and provider-derived content are safely rendered and no persistence/payment API is introduced',()=>{
 const h=ui({pickup:'<script>bad()</script>',management:{canChangePickupTime:false,canCancel:false,cancelReason:'within_24_hours',contact:{phone:'javascript:bad()',email:'bad@example.test\nBcc:other@example.test'}}});
 assert.ok(h.nodes.some(n=>n.textContent.includes('<script>bad()</script>')));assert.ok(!h.nodes.some(n=>n.href?.startsWith('javascript:')));assert.ok(!h.nodes.some(n=>n.href?.startsWith('tel:')||n.href?.startsWith('mailto:')));
 const management=source.slice(source.indexOf('function tripManagement('),source.indexOf('async function loadTrips'));
 assert.doesNotMatch(management,/innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|indexedDB|stripe|checkout/i);assert.match(management,/canChangePickupTime===true/);assert.match(management,/canCancel===true/);
 const css=fs.readFileSync(path.join(__dirname,'../public/account.css'),'utf8');assert.match(css,/\.trip-management-button\{min-height:44px/);assert.match(css,/@media\(max-width:350px\).*\.trip-management-actions\{display:grid/);
});

test('paid cancellation clearly requests a full refund and never claims provider completion from the click',async()=>{
 const h=ui({paymentStatus:'paid'});h.click('Cancel Trip');assert.equal(h.state.calls.length,0);assert.ok(h.nodes.some(n=>/Cancel this trip and request a full refund\?/.test(n.textContent)));assert.ok(h.nodes.some(n=>/Refund completion will be confirmed separately/.test(n.textContent)));
 let finish;h.state.next=new Promise(resolve=>finish=resolve);h.click('Confirm Cancellation');h.click('Confirm Cancellation');assert.equal(h.state.calls.length,1);assert.equal(h.find('Confirm Cancellation').disabled,true);
 assert.deepEqual(Object.keys(h.state.calls[0].body).sort(),['confirmed','expectedPickupAt','requestId']);assert.doesNotMatch(JSON.stringify(h.state.calls[0]),/amount|stripe|payment_method|customer_id|refundId/);
 finish({ok:true,trip:{refundStatus:'processing'}});await tick();assert.equal(h.state.refreshes,1);assert.match(h.elements.tripsStatus.textContent,/full refund is processing; it has not been confirmed yet/);assert.doesNotMatch(h.elements.tripsStatus.textContent,/has been confirmed|Refunded/);
});

test('cancelled refund states are fixed, truthful and never offer Complete Payment',()=>{
 for(const refundStatus of ['processing','confirmed','review_required','failed']){
  const h=ui({status:'cancelled',paymentStatus:'paid',refundStatus,refundId:'re_private',paymentIntent:'pi_private',management:{canChangePickupTime:false,canCancel:false,cancelReason:'inactive'}}),text=h.nodes.map(n=>n.textContent).join('\n');
  assert.ok(!h.find('Complete Payment'));assert.ok(!h.find('Cancel Trip'));assert.ok(!h.find('Change Pickup Time'));assert.ok(h.find('Cancelled'));assert.doesNotMatch(text,/re_private|pi_private|Payment is still required|Your trip is confirmed/);
  if(refundStatus==='processing'){assert.ok(h.find('Refund processing'));assert.match(text,/full refund is processing/);assert.match(text,/not been confirmed yet/);assert.ok(!h.find('Refund confirmed'));}
  else if(refundStatus==='confirmed'){assert.ok(h.find('Refund confirmed'));assert.match(text,/full refund has been confirmed/);assert.doesNotMatch(text,/Please contact.*payment review/);}
  else {assert.ok(h.find('Refund review required'));assert.match(text,/refund requires review/);assert.match(text,/no refund has been confirmed/);assert.ok(!h.find('Refund confirmed'));}
 }
 const late=ui({status:'cancelled',paymentStatus:'paid',management:{canChangePickupTime:false,canCancel:false,cancelReason:'inactive'}});assert.ok(late.nodes.some(n=>/Payment received for this cancelled trip/.test(n.textContent)));assert.ok(!late.find('Complete Payment'));
 const untrusted=ui({status:'cancelled',paymentStatus:'paid',refundStatus:'<script>provider-body</script>',management:{canChangePickupTime:false,canCancel:false,cancelReason:'inactive'}});assert.doesNotMatch(untrusted.nodes.map(n=>n.textContent).join('\n'),/provider-body/);
});

test('paid cancellation toast uses only the safe current server refund state',async()=>{
 for(const refundStatus of ['confirmed','review_required','failed']){
  const h=ui({paymentStatus:'paid'});h.state.next=Promise.resolve({ok:true,trip:{refundStatus}});h.click('Confirm Cancellation');await tick();
  assert.equal(h.state.calls.length,1);assert.equal(h.state.refreshes,1);assert.ok(!h.find('Complete Payment'));
  assert.match(h.elements.tripsStatus.textContent,refundStatus==='confirmed'?/full refund has been confirmed/:/refund review/);
 }
});

test('reservation status page renders only server-authorized refund states and ignores URL claims',async()=>{
 const script=fs.readFileSync(path.join(__dirname,'../public/success.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
 const cases=[
  {status:'cancelled',paymentStatus:'paid',refundStatus:'processing',message:/full refund is processing; it has not been confirmed yet/,label:'Refund processing'},
  {status:'cancelled',paymentStatus:'paid',refundStatus:'confirmed',message:/full refund has been confirmed/,label:'Refund confirmed'},
  ...['review_required','failed'].map(refundStatus=>({status:'cancelled',paymentStatus:'paid',refundStatus,message:/refund requires review.*no refund has been confirmed/,label:'Refund review required'})),
  {status:'cancelled',paymentStatus:'paid',message:/cancelled reservation.*payment review/,label:'Paid'},
  {status:'cancelled',paymentStatus:'paid',refundStatus:'<script>provider-body</script>',message:/cancelled reservation.*payment review/,label:'Paid'},
  {status:'awaiting_payment',paymentStatus:'unpaid',message:/Payment is still required/,label:'Payment Pending / Unpaid',payable:true},
  {status:'confirmed',paymentStatus:'paid',message:/Payment received\. Your reservation is confirmed/,label:'Paid'}
 ];
 for(const account of [false,true])for(const c of cases){
  const events={},elements={},calls=[],node=()=>({children:[],textContent:'',hidden:false,append(...children){this.children.push(...children)},replaceChildren(){this.children=[]},addEventListener(name,fn){this[name]=fn}});
  for(const id of ['message','details','completePayment','refreshReservation'])elements[id]=node();
  const trip={pickup:'Airport',dropoff:'Manhattan',date:'2026-11-10',time:'12:00'},quote={vehicle:'Luxury SUV',total:150,currency:'usd'};
  const value=account?{trip:{...c,reference:'11111111-1111-4111-8111-111111111111',...trip,...quote,refundAttempt:{id:'refund_private'},stripeRefundId:'re_private'}}:{...c,id:'11111111-1111-4111-8111-111111111111',trip,quote,refundAttempt:{id:'refund_private'},stripeRefundId:'re_private'};
  const ctx={document:{getElementById:id=>elements[id],createElement:node},URLSearchParams,Intl,window:{addEventListener:(name,fn)=>events[name]=fn},location:{search:'?booking=11111111-1111-4111-8111-111111111111&refundStatus=confirmed&refund=confirmed&paid=true'},fetch:async(url,options)=>{calls.push({url,options});if(account&&url.startsWith('/api/booking/'))return {ok:false,status:401};return {ok:true,status:200,json:async()=>value};}};
  vm.createContext(ctx);vm.runInContext(script,ctx);await events.pageshow();assert.match(elements.message.textContent,c.message);assert.equal(elements.completePayment.hidden,!c.payable);
  const payment=elements.details.children.find(r=>r.children[0].textContent==='Payment');assert.equal(payment.children[1].textContent,c.label);
  const text=elements.message.textContent+'\n'+elements.details.children.map(r=>r.children.map(n=>n.textContent).join(':')).join('\n');assert.doesNotMatch(text,/refund_private|re_private|provider-body/);
  if(c.refundStatus!=='confirmed')assert.doesNotMatch(elements.message.textContent,/full refund has been confirmed/);
  if(c.status==='cancelled')assert.doesNotMatch(elements.message.textContent,/reservation is confirmed|Payment is still required/);
  assert.equal(calls.length,account?2:1);assert.ok(calls.every(call=>!call.options.method));
 }
});
