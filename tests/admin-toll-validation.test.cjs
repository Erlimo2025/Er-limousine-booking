const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{createRequire}=require('node:module');
const harnessPath=path.join(__dirname,'security-abuse.test.cjs'),source=fs.readFileSync(harnessPath,'utf8');
const {harness,booking}=new Function('require','__dirname',source.slice(0,source.indexOf('test("approved prices'))+'\nreturn {harness,booking};')(createRequire(harnessPath),__dirname);
const endpoint='/api/admin/toll-validation/estimate',origin={origin:'http://localhost:3000','sec-fetch-site':'same-origin'};
const input=(extra={})=>({requestId:crypto.randomUUID(),pickup:'Newark Penn Station',dropoff:'Times Square Manhattan',via:'',date:'2026-11-10',time:'12:00',
  directions:'outbound',returnDate:'',returnTime:'',vehicle:'suburban_2025',emissionType:'GASOLINE',...extra});
const place=(id,state,address)=>({id,formattedAddress:address,location:{latitude:40.7,longitude:-74.1},
  addressComponents:[{types:['country'],shortText:'US'},{types:['administrative_area_level_1'],shortText:state}]});
const ids={pickup:'ChIJ_validation_newark',dropoff:'ChIJ_validation_midtown',via:'ChIJ_validation_via',same:'ChIJ_validation_trenton'};
const route=amount=>({description:'I-95 and Lincoln Tunnel',distanceMeters:24140,duration:'2400s',
  ...(amount===undefined?{}:{travelAdvisory:{tollInfo:amount===null?{}:{estimatedPrice:[{currencyCode:'USD',units:String(Math.floor(amount/100)),nanos:amount%100*10000000}]}}}),
  legs:[{steps:[{navigationInstruction:{instructions:'Continue toward Lincoln Tunnel.'}}],travelAdvisory:{tollInfo:{estimatedPrice:[{currencyCode:'USD',units:'99'}]}}}]});
function configure(h){h.state.searchResults={
  'Newark Penn Station':[place(ids.pickup,'NJ','Newark Penn Station, Newark, NJ, USA')],
  'Times Square Manhattan':[place(ids.dropoff,'NY','Times Square, Manhattan, NY, USA')],
  'Holland Tunnel investigation point':[place(ids.via,'NJ','Holland Tunnel investigation point, Jersey City, NJ, USA')],
  'Trenton Transit Center':[place(ids.same,'NJ','Trenton Transit Center, NJ, USA')]};
  h.state.routeResult=request=>route(request.origin.placeId===ids.dropoff?250:1679);return h;
}
const fixture=async(t,env={},store)=>configure(await harness(t,{ROUTE_TOLLS_ENABLED:'false',ADMIN_TOLL_VALIDATION_ENABLED:'true',...env},'[]',store));
const cookie=r=>r.headers.getSetCookie()[0].split(';')[0];
const login=async(h,headers={})=>cookie(await h.request('/api/admin/login',{token:'local-test-token'},headers));
const estimate=(h,c,body=input(),headers={})=>h.request(endpoint,body,{...origin,cookie:c,...headers});

test('admin validation is separately opt-in; absent, false and nonliteral flags fail closed without Google calls',async t=>{
  for(const flag of [undefined,'false','TRUE','1']){
    const h=await fixture(t,{ADMIN_TOLL_VALIDATION_ENABLED:flag}),c=await login(h);
    assert.deepEqual((await h.request('/api/admin/toll-validation/config',undefined,{cookie:c})).body,{enabled:false});
    assert.equal((await estimate(h,c)).status,404);assert.equal(h.state.googleCalls,0);assert.equal(h.records().length,0);
  }
});

test('guests, customer sessions, forged cookies, expired/logout sessions and cross-origin or non-JSON calls cannot request estimates',async t=>{
  const h=await fixture(t),c=await login(h);
  const customer=await h.request('/api/customer/register',{fullName:'Validation Customer',email:'validation-customer@example.test',phone:'2025550124',password:'Synthetic validation account password'});
  for(const denied of ['',cookie(customer),'er_admin_session=forged']){
    assert.equal((await estimate(h,denied)).status,401);
    assert.equal((await h.request('/api/admin/toll-validation/config',undefined,{cookie:denied})).status,401);
  }
  for(const headers of [{origin:''},{origin:'https://attacker.example.test'},{'sec-fetch-site':'same-site'},{'sec-fetch-site':'cross-site'},{'content-type':'text/plain'}])assert.equal((await estimate(h,c,input(),headers)).status,403);
  assert.equal((await h.request(endpoint+'?latitude=40.7',input(),{...origin,cookie:c})).status,400);
  assert.equal(h.state.googleCalls,0);
  h.advance(31*60000);assert.equal((await estimate(h,c)).status,401);
  const fresh=await login(h);await h.request('/api/admin/logout',{}, {...origin,cookie:fresh});assert.equal((await estimate(h,fresh)).status,401);
});

test('future NY times, strict schema, fixed fleet/pass metadata and unique verified US addresses reject bad input before routing',async t=>{
  const h=await fixture(t),c=await login(h);
  const bad=[[],{},input({requestId:'bad'}),input({vehicle:'escalade'}),input({emissionType:'ELECTRIC'}),input({date:'2026-09-30'}),
    input({date:'2026-03-08',time:'02:30'}),input({directions:'both',returnDate:'2026-11-10',returnTime:'11:00'}),
    input({directions:'outbound',returnDate:'2026-11-11'}),input({pickup:'40.7,-74.1'}),input({via:'<script>'}),input({amount:1}),
    input({commercialRatesVerified:true}),input({tollPasses:['US_NY_EZPASSNY']}),input({reservationId:crypto.randomUUID()}),input({googleApiKey:'forged'}),input({tlcLicensed:true}),input({ADMIN_TOLL_VALIDATION_ENABLED:true})];
  for(let i=0;i<bad.length;i++){if(i&&i%4===0)h.advance(61000);assert.equal((await estimate(h,c,bad[i])).status,400);}
  assert.equal(h.state.googleCalls,0);
  const invalid=await fixture(t),ci=await login(invalid);
  invalid.state.searchResults['Newark Penn Station']=[place(ids.pickup,'NJ','Newark'),place('ChIJ_other','NY','Other')];
  assert.equal((await estimate(invalid,ci)).status,422);assert.equal(invalid.state.routes.length,0);
  const foreign=await fixture(t),cf=await login(foreign);foreign.state.searchResults['Newark Penn Station'][0].addressComponents[0].shortText='CA';
  assert.equal((await estimate(foreign,cf)).status,422);assert.equal(foreign.state.routes.length,0);
});

test('both directions and one via resolve once, preserve original route-level cents, and expose Google route evidence separately from assumptions',async t=>{
  const h=await fixture(t),c=await login(h),r=await estimate(h,c,input({directions:'both',returnDate:'2026-11-12',returnTime:'22:31',via:'Holland Tunnel investigation point',emissionType:'DIESEL'}));
  assert.equal(r.status,200);assert.equal(r.body.estimateOnly,true);assert.equal(r.body.checkoutAllowed,false);assert.equal(r.body.customerTollAdditionCents,0);
  assert.equal(r.body.fleet.vehicleClass,'2Ax');assert.equal(r.body.fleet.plateCategory,'NJ OL');assert.equal(r.body.fleet.tlcLicensed,false);
  assert.equal(r.body.fleet.commercialRatesVerified,false);assert.equal(r.body.fleet.congestionCoverageVerified,false);
  assert.equal(h.state.googleCalls,5);assert.equal(h.state.routes.length,2);
  assert.deepEqual(r.body.routes.map(x=>x.originalGoogleTolls.amountCents),[1679,250]);
  assert.equal(h.state.routes[0].departureTime,'2026-11-10T17:00:00.000Z');assert.equal(h.state.routes[1].departureTime,'2026-11-13T03:31:00.000Z');
  assert.deepEqual(h.state.routes[1].origin,{placeId:ids.dropoff});assert.deepEqual(h.state.routes[1].destination,{placeId:ids.pickup});
  for(const request of h.state.routes){assert.deepEqual(request.extraComputations,['TOLLS']);assert.deepEqual(request.intermediates,[{placeId:ids.via,via:true}]);
    assert.deepEqual(request.routeModifiers,{vehicleInfo:{emissionType:'DIESEL'},tollPasses:['US_NJ_EZPASSNJ']});assert.equal(request.computeAlternativeRoutes,false);}
  for(const result of r.body.routes){assert.equal(result.source,'Google Routes API');assert.equal(result.crossingVerification,'not_independently_verified');assert.match(result.instructions[0],/Lincoln/);assert.match(result.via.address,/Holland/);}
  assert.ok(h.state.routeHeaders.every(x=>!x['X-Goog-FieldMask'].includes('legs.travelAdvisory.tollInfo')));
  assert.equal(h.state.timeoutMs,8000);assert.doesNotMatch(JSON.stringify(r.body),/mock-google-key|latitude|longitude|stripe/i);
  assert.match(r.headers.get('cache-control'),/no-store/);assert.match(r.body.warnings.join(' '),/Mid-Tier/);assert.match(r.body.warnings.join(' '),/daily entries/);
  assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);assert.equal(h.state.payments.calls.length,0);
});

test('known zero, unreported, unknown and invalid/non-USD tolls stay distinct and never become invented zero totals',async t=>{
  for(const [provider,status,amount]of [[route(0),'estimated',0],[{distanceMeters:1,duration:'1s'},'not_reported',null],[route(null),'unknown',null],
    [{...route(1500),travelAdvisory:{tollInfo:{estimatedPrice:[{currencyCode:'CAD',units:'15'}]}}},'unknown',null],
    [{...route(1500),travelAdvisory:{tollInfo:{estimatedPrice:[{currencyCode:'USD',units:'-1'}]}}},'unknown',null]]){
    const h=await fixture(t),c=await login(h);h.state.routeResult=()=>provider;const r=await estimate(h,c);assert.equal(r.status,200);
    assert.deepEqual(r.body.routes[0].originalGoogleTolls,{status,amountCents:amount});
  }
});

test('retry IDs reuse bounded in-memory results; conflicting input, simultaneous clicks and failed-provider retries never create duplicate calls',async t=>{
  const h=await fixture(t),c=await login(h),body=input();h.state.googleDelay=15;
  const r=await Promise.all([estimate(h,c,body),estimate(h,c,body),estimate(h,c,input())]);
  assert.equal(r.filter(x=>x.status===200).length,1);assert.equal(r.filter(x=>x.status===409).length,2);assert.equal(h.state.googleCalls,3);
  const retry=await estimate(h,c,body);assert.equal(retry.status,200);assert.equal(retry.body.reused,true);assert.equal(h.state.googleCalls,3);
  assert.equal((await estimate(h,c,{...body,time:'13:00'})).status,409);assert.equal(h.state.googleCalls,3);
  const failed=await fixture(t),fc=await login(failed),request=input();failed.state.googleError=true;
  const first=await estimate(failed,fc,request),second=await estimate(failed,fc,request);assert.equal(first.status,502);assert.equal(second.status,502);assert.equal(failed.state.googleCalls,1);
  assert.doesNotMatch(JSON.stringify([first.body,second.body,failed.state.logs]),/mock-google-key|synthetic-private|Newark Penn/);
});

test('per-minute and process-wide hourly budgets return 429 without provider work, including rotated authenticated sessions/IPs',async t=>{
  const h=await fixture(t),c=await login(h);for(let i=0;i<5;i++)assert.equal((await estimate(h,c)).status,200);
  const calls=h.state.googleCalls,blocked=await estimate(h,c);assert.equal(blocked.status,429);assert.equal(h.state.googleCalls,calls);assert.ok(Number(blocked.headers.get('retry-after'))>0);
  const rotating=await fixture(t,{TRUSTED_PROXY_CIDRS:'loopback'});
  for(let i=0;i<20;i++){const headers={'x-forwarded-for':'203.0.113.'+(i+1)},session=await login(rotating,headers);assert.equal((await estimate(rotating,session,input(),headers)).status,200);}
  const lastHeaders={'x-forwarded-for':'203.0.113.99'},last=await login(rotating,lastHeaders),before=rotating.state.googleCalls;
  assert.equal((await estimate(rotating,last,input(),lastHeaders)).status,429);assert.equal(rotating.state.googleCalls,before);
});

test('retry snapshots are scoped to the admin session, expire in memory, and disappear across server restart',async t=>{
  const h=await fixture(t),first=await login(h),body=input(),r=await estimate(h,first,body);assert.equal(r.status,200);assert.equal(h.state.googleCalls,3);
  const second=await login(h),other=await estimate(h,second,body);assert.equal(other.body.reused,false);assert.equal(h.state.googleCalls,6);
  h.advance(121000);const expired=await estimate(h,second,body);assert.equal(expired.body.reused,false);assert.equal(h.state.googleCalls,9);assert.notEqual(expired.body.capturedAt,r.body.capturedAt);
  const restarted=await fixture(t);assert.equal((await estimate(restarted,second,body)).status,401);assert.equal(restarted.state.googleCalls,0);
  assert.equal((await estimate(restarted,await login(restarted),body)).body.reused,false);assert.equal(restarted.state.googleCalls,3);
});

test('provider failures are generic, lack of credentials fails closed and an admin revoked during a lookup gets no route result',async t=>{
  for(const failure of ['providerTimeout','providerNetworkFailure','providerInvalidJson']){
    const h=await fixture(t),c=await login(h);h.state[failure]=true;const r=await estimate(h,c);
    assert.equal(r.status,502);assert.doesNotMatch(JSON.stringify([r.body,h.state.logs]),/synthetic-private|mock-google-key|Newark Penn/);
  }
  const absent=await fixture(t,{GOOGLE_MAPS_API_KEY:''}),ca=await login(absent);assert.equal((await estimate(absent,ca)).status,503);assert.equal(absent.state.googleCalls,0);
  const revoked=await fixture(t),cr=await login(revoked);revoked.state.onGoogle=()=>require('node:vm').runInContext('adminSessions.clear()',revoked.context);
  assert.equal((await estimate(revoked,cr)).status,401);assert.equal(revoked.state.routes.length,0);
});

test('estimate-only mode leaves normal, same-state, hourly and inclusive EWR quotes unchanged and never rewrites an accepted reservation',async t=>{
  const h=await fixture(t),c=await login(h),normal={...booking,vehicle:'suv',pickup:'Newark Penn Station',dropoff:'Times Square Manhattan'};
  const stored=await h.request('/api/checkout',{...normal,paymentChoice:'later'});assert.equal(stored.status,200);const before=h.records();
  const variants=[normal,{...normal,dropoff:'Trenton Transit Center'},{...normal,tripType:'hourly',hours:3}];
  const expected=[];for(const trip of variants)expected.push((await h.request('/api/quote',trip)).body);
  await estimate(h,c,input({dropoff:'Trenton Transit Center'}));assert.deepEqual(h.records(),before);
  for(let i=0;i<variants.length;i++)assert.deepEqual((await h.request('/api/quote',variants[i])).body,expected[i]);
  assert.ok(expected.every(q=>q.tolls===undefined));assert.equal(expected[2].total,390);
  h.state.searchResults.Manhattan=[{addressComponents:[{types:['administrative_area_level_2'],longText:'New York County'}]}];
  const special=await h.request('/api/quote',{...booking,vehicle:'suv',offerCode:'EWR_MANHATTAN_SUV',promoCode:'FIRST15'});
  assert.equal(special.status,200);assert.equal(special.body.total,150);assert.equal(special.body.totalCents,15000);assert.equal(special.body.discount,0);assert.equal(special.body.pricingBreakdown.tollsIncluded,true);
  assert.equal(h.state.creates.length,0);assert.equal(h.state.payments.calls.length,0);assert.deepEqual(h.records(),before);
});

test('CSP and private headers cover the admin panel without new external scripts, inline handlers, credentials or persistent browser storage',async t=>{
  const h=await fixture(t),page=await h.request('/admin.html');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/connect-src 'self'/);
  assert.match(page.headers.get('x-robots-tag'),/noindex/);assert.match(page.body,/id="tvPanel"[^>]*hidden/);assert.doesNotMatch(page.body,/<script[^>]+src="https?:|\son(?:click|submit)=/);
  const js=fs.readFileSync(path.join(__dirname,'../public/admin-toll-validation.js'),'utf8');assert.doesNotMatch(js,/localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML|GOOGLE_MAPS_API_KEY|api\/checkout|api\/booking\//);
});

test('PostgreSQL validation mode performs no reservation/ownership/payment/audit writes or reads and adds no schema changes',{skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
  const url=new URL(process.env.ER_TEST_DATABASE_URL);if(!['localhost','127.0.0.1'].includes(url.hostname)||!/^er_test_[a-z0-9_]+$/.test(url.pathname.slice(1)))throw Error('Requires an isolated local test database.');
  const {Pool}=require('pg'),schema='er_validation_'+crypto.randomBytes(8).toString('hex'),admin=new Pool({connectionString:url.toString()}),pool=new Pool({connectionString:url.toString(),options:'-c search_path='+schema});
  let created=false; t.after(async()=>{await pool.end();if(created)await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});await admin.query('CREATE SCHEMA '+schema);created=true;
  const store=require('../storage/postgres').createStore({},pool);await store.migrate();
  const now=Date.parse('2026-10-01T16:00:00Z'),customerId=crypto.randomUUID(),hash=crypto.randomBytes(32).toString('hex');
  await store.registerCustomer({id:customerId,full_name:'Validation Owner',normalized_email:'pg-validation@example.test',display_email:'pg-validation@example.test',normalized_phone:'+12025550121',display_phone:'2025550121',password_hash:'synthetic-hash'},{hash,created:new Date(now),expires:new Date(now+86400000)});
  const record={id:crypto.randomUUID(),createdAt:'2026-09-20T12:00:00Z',status:'confirmed',paymentStatus:'paid',paidAt:'2026-09-20T12:00:00Z',stripeSessionId:'cs_test_existing',
    customer:{firstName:'Validation',lastName:'Owner',email:'pg-validation@example.test',phone:'2025550121'},
    trip:{pickup:'Newark',dropoff:'Manhattan',date:'2026-11-10',time:'12:00',tripType:'oneway',vehicle:'suv',passengers:2},quote:{total:150,currency:'usd',vehicle:'Luxury SUV',vehicleKey:'suv'},dispatch:{driver:'Existing chauffeur',driverPhone:'',vehicle:'',plate:''}};
  await store.createWithBudget(record,()=>{},{customerId,sessionHash:hash,now,start:new Date('2026-11-10T17:00:00Z'),end:new Date('2026-11-10T17:00:00Z')});
  const before=(await pool.query('SELECT * FROM er_reservations ORDER BY id')).rows,ledger=(await pool.query('SELECT * FROM er_payment_ledger')).rows;
  let watching=false;const calls=[],monitored=new Proxy(store,{get(target,name){const value=target[name];return typeof value!=='function'?value:(...args)=>{if(watching)calls.push(name);return value.apply(target,args);};}});
  const h=await fixture(t,{},monitored),c=await login(h);await new Promise(resolve=>setImmediate(resolve));watching=true;
  assert.equal((await h.request('/api/admin/toll-validation/config',undefined,{cookie:c})).status,200);
  assert.equal((await estimate(h,c,input({directions:'both',returnDate:'2026-11-12',returnTime:'12:00'}))).status,200);watching=false;
  assert.deepEqual(calls,[]);assert.deepEqual((await pool.query('SELECT * FROM er_reservations ORDER BY id')).rows,before);assert.deepEqual((await pool.query('SELECT * FROM er_payment_ledger')).rows,ledger);
  assert.equal(await store.reservationOwner(record.id),customerId);assert.equal(h.state.creates.length,0);assert.equal(h.state.payments.calls.length,0);
  assert.deepEqual((await admin.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename ILIKE $2',[schema,'%toll%'])).rows,[]);
});
