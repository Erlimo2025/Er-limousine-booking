const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const harnessPath=path.join(__dirname,'security-abuse.test.cjs'),source=fs.readFileSync(harnessPath,'utf8');
const {harness,booking}=new Function('require','__dirname',source.slice(0,source.indexOf('test("approved prices'))+'\nreturn {harness,booking};')(createRequire(harnessPath),__dirname);
const headers={origin:'http://localhost:3000','sec-fetch-site':'same-origin'},coordinates={latitude:40.735657,longitude:-74.172366};
const reverse=(h,body=coordinates,extra={})=>h.request('/api/reverse-geocode',body,{...headers,...extra});

test('reverse geocoding returns only a readable address and compatible ID, uses server key, retains normal quoting and does not store/log GPS',async t=>{
 const h=await harness(t);let upstream;h.context.probeReverse=url=>{if(url.includes('/maps/api/geocode/json'))upstream=new URL(url);};vm.runInContext('const originalLocationFetch=fetch;fetch=(url,options)=>{probeReverse(url);return originalLocationFetch(url,options);};',h.context);
 const result=await reverse(h);assert.equal(result.status,200);assert.deepEqual(result.body,{description:'1 Market St, Newark, NJ 07102, USA',placeId:'ChIJ_reverse_street'});assert.equal(upstream.hostname,'maps.googleapis.com');assert.equal(upstream.searchParams.get('key'),'mock-google-key');assert.equal(upstream.searchParams.get('latlng'),coordinates.latitude+','+coordinates.longitude);
 assert.equal(h.state.googleCalls,1);assert.equal(h.state.timeoutMs,8000);assert.match(result.headers.get('cache-control'),/no-store/);assert.equal(result.headers.get('referrer-policy'),'no-referrer');
 assert.deepEqual(h.records(),[]);assert.equal(h.state.creates.length,0);assert.equal((await h.request('/api/address-suggestions?q=Market')).status,200);
 const quoted=await h.request('/api/quote',{...booking,pickup:result.body.description,pickupPlaceId:result.body.placeId});assert.equal(quoted.status,200);assert.equal(quoted.body.total,100);assert.equal(quoted.body.fixedOffer,null);assert.equal(h.state.routes.at(-1).origin.address,result.body.description);
 const logs=h.state.logs.join('\n');for(const privateValue of [String(coordinates.latitude),String(coordinates.longitude),'mock-google-key'])assert.ok(!logs.includes(privateValue));
 assert.ok(!JSON.stringify(result.body).includes('geometry'));
});

test('reverse geocoding rejects forged fields, query coordinates, invalid numbers, foreign origins and non-JSON before provider calls',async t=>{
 for(const body of [{},[],null,{latitude:'40',longitude:-74},{latitude:91,longitude:0},{latitude:0,longitude:-181},{latitude:0,longitude:null},{...coordinates,key:'forged'},{...coordinates,url:'https://attacker.example.test'},'not-json']){
  const h=await harness(t),r=await reverse(h,body);assert.equal(r.status,400,JSON.stringify(body));assert.equal(h.state.googleCalls,0);
 }
 const h=await harness(t);for(const extra of [{origin:'https://attacker.example.test'},{origin:''},{'sec-fetch-site':'cross-site'},{'content-type':'text/plain'}])assert.equal((await reverse(h,coordinates,extra)).status,403);
 assert.equal((await h.request('/api/reverse-geocode?latitude=40',coordinates,headers)).status,400);assert.equal((await h.request('/api/reverse-geocode')).status,404);assert.equal(h.state.googleCalls,0);
});

test('zero/malformed results, quota/permission/network errors and missing config fail safely without coordinates or key in logs',async t=>{
 for(const change of [{reverseResult:{status:'ZERO_RESULTS',results:[]}},{reverseResult:{status:'OK',results:[{formatted_address:'New Jersey',types:['administrative_area_level_1']}]}},{reverseResult:{status:'REQUEST_DENIED',error_message:'private-provider-message'}},{providerInvalidJson:true},{providerNetworkFailure:true},{providerStatus:429,googleError:true},{providerTimeout:true}]){
  const h=await harness(t);Object.assign(h.state,change);const r=await reverse(h);assert.ok([404,502].includes(r.status));assert.ok(!JSON.stringify(r.body).includes('private-provider'));assert.deepEqual(h.records(),[]);
  for(const value of [String(coordinates.latitude),String(coordinates.longitude),'mock-google-key','private-provider'])assert.ok(!h.state.logs.join(' ').includes(value));
 }
 const missing=await harness(t,{GOOGLE_MAPS_API_KEY:''});assert.equal((await reverse(missing)).status,503);assert.equal(missing.state.googleCalls,0);
 const noId=await harness(t);noId.state.reverseResult={status:'OK',results:[{formatted_address:'1 Main Street',types:['street_address'],place_id:'invalid/id'}]};assert.equal((await reverse(noId)).body.placeId,'');
});

test('reverse geocoding is rate limited and only booking documents permit same-origin geolocation',async t=>{
 const h=await harness(t);for(let i=0;i<20;i++)assert.equal((await reverse(h)).status,200);assert.equal((await reverse(h)).status,429);assert.equal(h.state.googleCalls,20);
 for(const url of ['/','/index.html'])assert.match((await h.request(url)).headers.get('permissions-policy'),/geolocation=\(self\)/);
 for(const url of ['/admin.html','/account.html','/success.html','/newark-airport-ewr-car-service','/api/public-config'])assert.match((await h.request(url)).headers.get('permissions-policy'),/geolocation=\(\)/);
});

function locationUi(){
 const node=()=>({value:'',dataset:{},hidden:false,disabled:false,textContent:'',children:[],handlers:{},attributes:{},addEventListener(type,handler){(this.handlers[type] ||= []).push(handler);},setAttribute(key,value){this.attributes[key]=value;},appendChild(child){this.children.push(child);}});
 const input=node(),button=node(),status=node(),events={},timers=new Map(),calls=[],selected=[];let timerId=0,gps;
 const ctx={document:{createElement:node},window:{isSecureContext:true,addEventListener:(e,f)=>events[e]=f},navigator:{geolocation:{getCurrentPosition(success,failure,options){gps={success,failure,options};}}},AbortController,Number,JSON,Error,
  setTimeout(fn,delay){const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);},fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({description:'1 Main Street',placeId:'ChIJ_main'})};}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/pickup-location.js'),'utf8'),ctx);
 const controller=ctx.createPickupLocation({input,button,status,beforeStart(){},onSelect(address){selected.push(address);input.value=address.description;input.dataset.placeId=address.placeId;controller.clearOption();}});
 const fire=(el,event)=>Promise.all((el.handlers[event] || []).map(fn=>fn({preventDefault(){}})));
 return {ctx,input,button,status,events,timers,calls,selected,controller,node,fire,get gps(){return gps;}};
}

test('current location starts only on click, announces progress, sends POST coordinates, fills address/ID and adds the option first',async()=>{
 const h=locationUi();assert.equal(h.gps,undefined);const menu=h.node();h.controller.addOption(menu);assert.equal(menu.children[0].type,'button');assert.match(menu.children[0].textContent,/Use My Current Location/);assert.equal(h.button.hidden,true);
 await h.fire(menu.children[0],'click');assert.equal(h.status.textContent,'Detecting your location…');assert.equal(h.input.attributes['aria-busy'],'true');assert.equal(h.button.disabled,true);assert.equal(h.gps.options.enableHighAccuracy,true);assert.equal(h.gps.options.maximumAge,0);assert.equal(h.gps.options.timeout,10000);
 await h.gps.success({coords:coordinates});assert.equal(h.input.value,'1 Main Street');assert.equal(h.input.dataset.placeId,'ChIJ_main');assert.equal(h.button.disabled,false);assert.equal(h.status.hidden,false);assert.match(h.status.textContent,/Please check/);assert.equal(h.calls[0].url,'/api/reverse-geocode');assert.equal(h.calls[0].options.method,'POST');assert.deepEqual(JSON.parse(h.calls[0].options.body),coordinates);assert.equal(h.timers.size,0);
});

test('permission denial, unavailable GPS, timeout, insecure/unsupported devices and reverse failure keep manual pickup usable',async()=>{
 for(const code of [1,2,3]){const h=locationUi();h.input.value='Original manual pickup';h.controller.start();h.gps.failure({code,message:'private device coordinates'});assert.equal(h.input.value,'Original manual pickup');assert.equal(h.button.disabled,false);assert.match(h.status.textContent,/manually/);assert.ok(!h.status.textContent.includes('private'));assert.equal(h.calls.length,0);}
 for(const unsupported of ['insecure','missing']){const h=locationUi();if(unsupported==='insecure')h.ctx.window.isSecureContext=false;else delete h.ctx.navigator.geolocation;h.controller.start();assert.match(h.status.textContent,/manually/);assert.equal(h.calls.length,0);}
 const h=locationUi();h.ctx.fetch=async()=>({ok:false});h.controller.start();await h.gps.success({coords:coordinates});assert.equal(h.input.value,'');assert.match(h.status.textContent,/manually/);assert.equal(h.button.disabled,false);
 const timeout=locationUi();timeout.controller.start();[...timeout.timers.values()].find(t=>t.delay===20000).fn();await timeout.gps.success({coords:coordinates});assert.equal(timeout.calls.length,0);assert.match(timeout.status.textContent,/timed out/);
});

test('typing, selection, resets/navigation and programmatic edits win over slow GPS and reverse responses',async()=>{
 for(const kind of ['input','selected','pagehide','programmatic']){
  const h=locationUi();h.controller.start();const old=h.gps;
  if(kind==='input'){h.input.value='Typed pickup';await h.fire(h.input,'input');}else if(kind==='selected'){h.controller.cancel();h.input.value='Selected pickup';h.input.dataset.placeId='ChIJ_selected';}else if(kind==='pagehide'){h.events.pagehide();}else h.input.value='Programmatic pickup';
  const value=h.input.value;await old.success({coords:coordinates});assert.equal(h.input.value,value);assert.equal(h.calls.length,0);assert.equal(h.button.disabled,false);
 }
 const h=locationUi();let resolve;h.ctx.fetch=async(url,options)=>{h.calls.push({url,options});return await new Promise(r=>resolve=r);};h.controller.start();const pending=h.gps.success({coords:coordinates});assert.equal(h.calls.length,1);h.input.value='New manually typed pickup';await h.fire(h.input,'input');assert.equal(h.calls[0].options.signal.aborted,true);resolve({ok:true,json:async()=>({description:'Old GPS address',placeId:'ChIJ_old'})});await pending;assert.equal(h.input.value,'New manually typed pickup');assert.equal(h.selected.length,0);
});

test('autocomplete ignores delayed suggestions after manual choice or GPS commit; drop-off retains manual selection behavior',async()=>{
 const app=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8').replace(/\r\n/g,'\n'),elements=[],input={value:'Market',dataset:{},events:{},addEventListener(e,f){this.events[e]=f;}},dropoff={...input,dataset:{},events:{}},container={innerHTML:'',appendChild:x=>elements.push(x)},timers=[],results=[];
 const ctx={pickup:input,dropoff,syncPickupTerminal(){},syncDropoffTerminal(){},suggestionTimers:{},clearTimeout(){},setTimeout(fn){timers.push(fn);},specialOfferActive:()=>false,resetQuote(){},document:{createElement:()=>({addEventListener(e,f){this[e]=f;}})},findAddresses:async()=>await new Promise(r=>results.push(r))};
 const start=app.indexOf('function renderSuggestions('),end=app.indexOf('/* =========================================\n   QUOTE',app.indexOf('function enableAddressAutocomplete('));
 assert.ok(start>=0&&end>start,'Autocomplete test source boundaries must exist.');
 vm.createContext(ctx);vm.runInContext(app.slice(start,end),ctx);
 ctx.enableAddressAutocomplete(input,container,'pickup');input.events.input();const pending=timers.shift()();ctx.renderSuggestions(container,input,[{description:'Chosen address',placeId:'ChIJ_chosen'}]);elements.at(-1).mousedown({preventDefault(){}});results.shift()([{description:'Stale address',placeId:'stale'}]);await pending;assert.equal(input.value,'Chosen address');assert.equal(input.dataset.placeId,'ChIJ_chosen');assert.equal(elements.length,1);
 ctx.renderSuggestions(container,dropoff,[{description:'Drop-off selected',placeId:'ChIJ_dropoff'}]);elements.at(-1).mousedown({preventDefault(){}});assert.equal(dropoff.value,'Drop-off selected');assert.equal(dropoff.dataset.placeId,'ChIJ_dropoff');
});
