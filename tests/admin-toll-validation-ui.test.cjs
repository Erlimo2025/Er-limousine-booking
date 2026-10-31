const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const script=fs.readFileSync(path.join(__dirname,'../public/admin-toll-validation.js'),'utf8');
const fleet={label:'2025 Chevrolet Suburban',account:'NJ E-ZPass Business',vehicleClass:'2Ax',plateCategory:'NJ OL',tlcLicensed:false};
const sample=()=>({estimateOnly:true,checkoutAllowed:false,capturedAt:'2026-10-30T18:00:00Z',reused:false,fleet,
  googleAssumptions:{emissionType:'GASOLINE',tollPasses:['US_NJ_EZPASSNJ']},
  routes:[{direction:'outbound',origin:{address:'Newark'},destination:{address:'Manhattan'},via:null,departureTime:'2026-11-10T17:00:00Z',
    description:'Google route via Lincoln Tunnel',distanceMeters:16093,durationSeconds:1200,instructions:['Use the Google-returned route.'],providerWarnings:[],originalGoogleTolls:{status:'estimated',amountCents:2279}}]});
function ui(){
  class Element{
    constructor(tag='div'){this.tagName=tag;this.children=[];this.listeners={};this.value='';this.hidden=false;this.disabled=false;this.checked=false;this._text='';}
    set textContent(value){this._text=String(value);this.children=[];}
    get textContent(){return this._text+this.children.map(x=>x.textContent).join(' ');}
    append(...items){this.children.push(...items);}
    replaceChildren(...items){this._text='';this.children=[...items];}
    addEventListener(event,fn){this.listeners[event]=fn;}
    reset(){}
  }
  const elements={},events={},requests=[],state={config:{enabled:true,fleet,warnings:['Daily entries and missing credits need review.']},result:sample()};
  for(const [,id]of fs.readFileSync(path.join(__dirname,'../public/admin.html'),'utf8').matchAll(/id="(tv[^"]+)"/g))elements[id]=new Element();
  Object.assign(elements.tvPanel,{hidden:true});Object.assign(elements.tvComparison,{hidden:true});
  for(const [name,value]of Object.entries({Pickup:'Newark Penn Station',Dropoff:'Times Square Manhattan',Via:'',Date:'2026-11-10',Time:'12:00',Vehicle:'suburban_2025',Fuel:'GASOLINE',Directions:'outbound',ReturnDate:'',ReturnTime:''}))elements['tv'+name].value=value;
  elements.tvForm.reset=()=>{for(const key of ['Pickup','Dropoff','Via','Date','Time','Fuel','ReturnDate','ReturnTime'])elements['tv'+key].value='';};
  const context={document:{getElementById:id=>elements[id],createElement:tag=>new Element(tag)},window:{addEventListener:(event,fn)=>events[event]=fn},AbortController,crypto,Intl,Date};
  vm.createContext(context);vm.runInContext(script,context);
  const request=async(url,options={})=>{requests.push({url,options});return url.endsWith('/config')?state.config:state.pending?await state.pending:state.result;};
  return {elements,events,requests,state,controller:context.window.erTollValidation,request,
    login:()=>context.window.erTollValidation.setAuthenticated(true,request),submit:()=>elements.tvForm.listeners.submit({preventDefault(){}})};
}
const lineInput=(h,row,field)=>h.elements.tvRows.children[row].children[field].children[0];
function setLine(h,row,{type='charge',amount,status='settled',description='Synthetic toll'}){
  for(const [index,value,event]of [[0,type,'change'],[1,description,'input'],[2,amount,'input'],[3,status,'change']]){const input=lineInput(h,row,index);input.value=value;input.listeners[event]();}
}

test('panel makes no request before admin authentication, stays hidden when disabled and clears private state at logout/pagehide',async()=>{
  const h=ui();assert.equal(h.requests.length,0);assert.equal(h.elements.tvPanel.hidden,true);
  h.state.config.enabled=false;await h.login();assert.equal(h.elements.tvPanel.hidden,true);assert.equal(h.requests.length,1);
  await h.controller.setAuthenticated(false);h.state.config.enabled=true;await h.login();assert.equal(h.elements.tvPanel.hidden,false);assert.match(h.elements.tvFleet.textContent,/Not TLC/);
  await h.submit();assert.match(h.elements.tvResults.textContent,/\$22.79/);h.elements.tvAdd.listeners.click();setLine(h,0,{amount:'16.79'});
  h.events.pagehide();assert.equal(h.elements.tvPanel.hidden,true);assert.equal(h.elements.tvComparison.hidden,true);assert.equal(h.elements.tvRows.children.length,0);assert.equal(h.elements.tvSummary.value,'');assert.equal(h.elements.tvPickup.value,'');
});

test('settled charges and credits compare against the untouched original Google aggregate; pending and invalid entries remain provisional',async()=>{
  const h=ui();await h.login();await h.submit();const requests=h.requests.length;
  for(let i=0;i<4;i++)h.elements.tvAdd.listeners.click();
  setLine(h,0,{amount:'16.79',description:'Lincoln Tunnel'});setLine(h,1,{amount:'9.00',description:'CRZ'});
  setLine(h,2,{type:'credit',amount:'3',description:'CRZ credit'});setLine(h,3,{amount:'2.25',description:'Union Ramp'});
  assert.match(h.elements.tvTotals.textContent,/\$25.04/);assert.match(h.elements.tvTotals.textContent,/\+\$2.25/);assert.match(h.elements.tvResults.textContent,/\$22.79/);
  setLine(h,2,{type:'credit',amount:'3',status:'pending'});assert.match(h.elements.tvTotals.textContent,/\$28.04/);assert.match(h.elements.tvReview.textContent,/Pending amounts are excluded/);
  setLine(h,3,{amount:'2.255'});assert.match(h.elements.tvTotals.textContent,/Difference unavailable/);assert.match(h.elements.tvReview.textContent,/two decimal/);
  assert.equal(h.requests.length,requests);assert.doesNotMatch(JSON.stringify(h.requests),/Union Ramp|CRZ credit/);
});

test('unknown Google amounts have no numeric variance and a same-day history observation never rewrites the provider total',async()=>{
  const h=ui();h.state.result.routes[0].originalGoogleTolls={status:'unknown',amountCents:null};await h.login();await h.submit();
  const details=h.elements.tvResults.children[1].children.find(x=>x.tagName==='dl'),label=details.children.findIndex(x=>x.textContent==='Original Google toll total');
  assert.match(details.children[label+1].textContent,/Unknown \/ invalid toll estimate/);assert.doesNotMatch(details.children[label+1].textContent,/\$0/);
  h.elements.tvAdd.listeners.click();setLine(h,0,{amount:'19.55'});assert.match(h.elements.tvTotals.textContent,/Difference unavailable/);
  h.elements.tvDaily.value='paid';h.elements.tvDaily.listeners.change();assert.match(h.elements.tvReview.textContent,/already in Google/);
  assert.equal(h.state.result.routes[0].originalGoogleTolls.amountCents,null);
});

test('late configuration/estimate responses cannot redisplay data after logout or overwrite an edited route',async()=>{
  const h=ui();await h.login();let resolve;h.state.pending=new Promise(done=>resolve=done);const first=h.submit();assert.equal(h.elements.tvEstimate.disabled,true);
  h.elements.tvPickup.value='Changed pickup';h.elements.tvForm.listeners.input();resolve(sample());await first;
  assert.equal(h.elements.tvResults.children.length,0);assert.equal(h.elements.tvSummary.value,'');assert.equal(h.elements.tvComparison.hidden,true);
  h.state.pending=new Promise(done=>resolve=done);const second=h.submit();h.controller.setAuthenticated(false);resolve(sample());await second;
  assert.equal(h.elements.tvPanel.hidden,true);assert.equal(h.elements.tvResults.children.length,0);
  const delayed=ui();let finish;const waiting=delayed.controller.setAuthenticated(true,()=>new Promise(done=>finish=done));delayed.controller.setAuthenticated(false);finish(delayed.state.config);await waiting;assert.equal(delayed.elements.tvPanel.hidden,true);
});

test('direction comparison rows remain separate and repeated estimate submissions preserve their request ID until an explicit new estimate',async()=>{
  const h=ui();const returned=structuredClone(h.state.result.routes[0]);Object.assign(returned,{direction:'return',originalGoogleTolls:{status:'estimated',amountCents:250},departureTime:'2026-11-12T17:00:00Z'});h.state.result.routes.push(returned);
  await h.login();await h.submit();const id=JSON.parse(h.requests.at(-1).options.body).requestId;
  h.elements.tvAdd.listeners.click();setLine(h,0,{amount:'22.79'});
  h.elements.tvCompareDirection.value='1';h.elements.tvCompareDirection.listeners.change();assert.equal(h.elements.tvRows.children.length,0);
  h.elements.tvAdd.listeners.click();setLine(h,0,{amount:'2.50'});assert.match(h.elements.tvTotals.textContent,/\$2.50/);
  h.elements.tvCompareDirection.value='0';h.elements.tvCompareDirection.listeners.change();assert.match(h.elements.tvTotals.textContent,/\$22.79/);
  const before=h.requests.length;await h.submit();assert.equal(h.requests.length,before);assert.equal(JSON.parse(h.requests.at(-1).options.body).requestId,id);
  h.elements.tvNew.listeners.click();assert.equal(h.elements.tvRows.children.length,0);await h.submit();assert.notEqual(JSON.parse(h.requests.at(-1).options.body).requestId,id);
});

test('decimal parsing is strict cents; negative inputs, exponent notation and excess precision cannot enter settled totals',()=>{
  const context={};vm.createContext(context);vm.runInContext(script.slice(script.indexOf('function amountCents'),script.indexOf('  const panel')),context);
  for(const [value,expected]of [['0',0],['16.79',1679],['3',300],['2.5',250]])assert.equal(context.amountCents(value),expected);
  for(const value of ['-3','1e2','1.001','NaN','Infinity','','01.50','1,000.00'])assert.equal(context.amountCents(value),null);
  const totals=context.settledTotals([{type:'charge',amount:'9',status:'settled'},{type:'credit',amount:'3',status:'settled'},{type:'charge',amount:'16.79',status:'pending'}]);
  assert.equal(totals.net,600);assert.equal(totals.pending,true);assert.equal(totals.invalid,false);
});
