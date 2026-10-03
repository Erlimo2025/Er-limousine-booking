const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {Pool}=require('pg');
const {createRequire}=require('node:module');
const {createStore,StorageError,validateRecords,connectionOptions}=require('../storage/postgres');
function fixture(overrides={}) {return {id:crypto.randomUUID(),createdAt:'2026-10-01T16:00:00Z',status:'awaiting_payment',paymentStatus:'unpaid',stripeSessionId:null,
 customer:{firstName:'Test',lastName:'Customer',email:'test@example.test',phone:'2015550199'},
 trip:{pickup:'EWR',dropoff:'Manhattan',date:'2026-11-10',time:'12:00',vehicle:'escalade',tripType:'oneway',passengers:6},
 quote:{total:100,currency:'usd',vehicle:'Cadillac Escalade ESV',vehicleKey:'escalade'},
 dispatch:{driver:'',driverPhone:'',vehicle:'',plate:''},...overrides};}
const generic=error=>error instanceof StorageError && error.status===503 && !error.message.includes('private-detail');
test('production missing/invalid DATABASE_URL fails closed, without reading JSON',()=>{
 for(const env of [{NODE_ENV:'production'},{RENDER:'true'},{}])assert.throws(()=>createStore(env),generic);
 for(const value of ['not-a-url','https://invalid.example.test','postgresql://localhost/test?sslmode=disable'])assert.throws(()=>createStore({NODE_ENV:'production',DATABASE_URL:value}),generic);
 const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 assert.doesNotMatch(source,/bookings\.json|writeBookings|ensureDataFile/);
 assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),/DATABASE_URL/);
});
test('Render internal policy is narrowly scoped; external TLS remains verified',()=>{
 const internal='postgresql://synthetic_user@dpg-synthetic123-a/er_test_connection';
 for(const host of ['dpg-synthetic123','dpg-synthetic123-a','dpg-synthetic123.internal','dpg-synthetic123-a.internal']) {
   const databaseURL='postgresql://synthetic_user@'+host+'/er_test_connection';
   assert.equal(connectionOptions({RENDER:'true',DATABASE_URL:databaseURL}).ssl,false);
   assert.equal(connectionOptions({RENDER:'true',DATABASE_URL:databaseURL+'?sslmode=require'}).ssl.rejectUnauthorized,false);
   assert.equal(connectionOptions({RENDER:'true',DATABASE_URL:databaseURL+'?sslmode=verify-full'}).ssl.rejectUnauthorized,true);
   for(const render of [undefined,'false','TRUE'])assert.equal(connectionOptions({RENDER:render,DATABASE_URL:databaseURL}).ssl.rejectUnauthorized,true);
 }
 assert.equal(connectionOptions({RENDER:'true',DATABASE_URL:internal}).ssl,false);
 assert.equal(connectionOptions({RENDER:'true',DATABASE_URL:internal+'?sslmode=disable'}).ssl,false);
 assert.equal(connectionOptions({RENDER:'true',DATABASE_URL:internal+'?sslmode=require'}).ssl.rejectUnauthorized,false);
 for(const mode of ['verify-ca','verify-full'])assert.equal(connectionOptions({RENDER:'true',DATABASE_URL:internal+'?sslmode='+mode}).ssl.rejectUnauthorized,true);
 for(const host of ['public.example.test','dpg-synthetic123-a.virginia-postgres.render.com','dpg-synthetic123-a.attacker.test','dpg-synthetic123-a.internal.attacker.test','dpg-synthetic123-a.attacker.internal','anything.internal','internal','dpg-synthetic123-a.internal.','127.0.0.1']) {
   for(const mode of ['', '?sslmode=require','?sslmode=verify-full'])assert.equal(connectionOptions({RENDER:'true',DATABASE_URL:'postgresql://synthetic_user@'+host+'/er_test_connection'+mode}).ssl.rejectUnauthorized,true);
   assert.throws(()=>connectionOptions({RENDER:'true',DATABASE_URL:'postgresql://synthetic_user@'+host+'/er_test_connection?sslmode=disable'}),generic);
 }
 assert.equal(connectionOptions({DATABASE_URL:internal}).ssl.rejectUnauthorized,true);
 for(const value of [undefined,'not-a-url','postgresql://synthetic_user@/db','postgresql://synthetic_user@host/',internal+'?sslmode=prefer',internal+'?ssl=0',internal+'?sslmode=require&sslmode=disable',internal+'?host=public.example.test','postgresql://bad%ZZ@host/db'])assert.throws(()=>connectionOptions({RENDER:'true',DATABASE_URL:value}),generic);
 const source=fs.readFileSync(path.join(__dirname,'../storage/postgres.js'),'utf8');
 assert.doesNotMatch(source,/NODE_TLS_REJECT_UNAUTHORIZED|console\.(?:log|error)\([^)]*(?:DATABASE_URL|connectionString)/);
 const before=process.env.NODE_TLS_REJECT_UNAUTHORIZED;connectionOptions({RENDER:'true',DATABASE_URL:internal});assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED,before);
});

test('database connection and read errors are sanitized, never empty arrays',async()=>{
 const connection=createStore({}, {connect:async()=>{throw new Error('private-detail');},query:async()=>{throw new Error('private-detail');}});
 await assert.rejects(connection.migrate(),generic);await assert.rejects(connection.list(),generic);await assert.rejects(connection.hasPaidRide('test@example.test','2015550199'),generic);
});
test('malformed database rows and legacy imports fail explicitly',async()=>{
 for(const record of [null,[],{},fixture({quote:{total:0}}),fixture({customerAccess:{tokenHash:'bad',expiresAt:0}}),fixture({trip:{vehicle:'sedan'}})]) {
   assert.throws(()=>validateRecords([record]),generic);
 }
 const valid=fixture();assert.throws(()=>validateRecords([valid,valid]),generic);
 assert.throws(()=>validateRecords({}),generic);
 const storage=createStore({}, {query:async()=>({rows:[{id:valid.id,record:{...valid,quote:{total:'invalid'}}}]})});
 await assert.rejects(storage.list(),generic);
});
test('failed transactional writes rollback and discard a connection if rollback fails',async()=>{
 for(const rollbackFailure of [false,true]) {
  const queries=[];let discarded;
  const client={query:async(sql,values)=>{queries.push({sql,values});if(sql.startsWith('INSERT INTO er_reservations') || (rollbackFailure && sql==='ROLLBACK'))throw new Error('private-detail');return {rows:[],rowCount:0};},release:value=>{discarded=value;}};
  const storage=createStore({}, {connect:async()=>client});
  await assert.rejects(storage.createWithBudget(fixture(),()=>{}),generic);
  assert.ok(queries.some(q=>q.sql==='BEGIN'));assert.ok(queries.some(q=>q.sql==='ROLLBACK'));assert.ok(!queries.some(q=>q.sql==='COMMIT'));assert.equal(discarded,rollbackFailure);
  const insert=queries.find(q=>q.sql.startsWith('INSERT INTO er_reservations'));assert.ok(insert.sql.includes('$1'));assert.equal(insert.values.length,3);
 }
});
test('versioned immutable FIRST15 parameters reject corrupted payment amounts',()=>{
 const r=fixture(),quote={...r.quote,total:85,discount:15,promotion:{code:'FIRST15'}};
 r.checkoutAttempt={key:crypto.randomUUID(),version:1,correlationId:crypto.randomUUID(),expiresAt:1790956800,quote,
   state:'submitted_unknown',firstSubmittedAt:1790870400000,lastReconciledAt:null,submissionCount:1};
 r.checkoutAttempt.parameters={mode:'payment',expires_at:r.checkoutAttempt.expiresAt,customer_email:r.customer.email,
   line_items:[{quantity:1,price_data:{unit_amount:1,currency:'usd'}}],
   metadata:{bookingId:r.id,attemptReference:r.checkoutAttempt.correlationId,promoCode:'FIRST15',discount:'15'}};
 assert.throws(()=>validateRecords([r]),generic);
 r.checkoutAttempt.parameters.line_items[0].price_data.unit_amount=8500;
 assert.doesNotThrow(()=>validateRecords([r]));
});

test('import validation rejects all input before acquiring a database connection',async()=>{
 let connects=0;const storage=createStore({}, {connect:async()=>{connects++;throw new Error();}});
 await assert.rejects(storage.importLegacy([fixture(),{}]),generic);assert.equal(connects,0);
});
const url=process.env.ER_TEST_DATABASE_URL;
test('isolated PostgreSQL integration: transactions, concurrent workers, import and secure booking flow',{skip:!url},async t=>{
 const parsed=new URL(url);if(!parsed.pathname.slice(1).startsWith('er_test_'))throw new Error('Integration requires an isolated test database.');
 const pool=new Pool({connectionString:url,max:10});const secondPool=new Pool({connectionString:url,max:10});
 const store=createStore({},pool),second=createStore({},secondPool);
 t.after(async()=>{await store.close();await second.close();});
 await Promise.all([store.migrate(),second.migrate()]);
 await pool.query('TRUNCATE er_first_ride_claims, er_reservations, er_storage_audit, er_payment_ledger, er_paid_ride_eligibility');
 await t.test('creation commits a valid reservation; budget rejection creates nothing',async()=>{
  const r=fixture();await store.createWithBudget(r,records=>assert.equal(records.length,0));assert.equal((await store.get(r.id)).id,r.id);
  await assert.rejects(store.createWithBudget(fixture(),()=>{throw Object.assign(new Error('budget'),{status:429});}),e=>e.status===429);
  assert.equal((await store.list()).length,1);
 });
 await t.test('concurrent connections preserve every row update',async()=>{
  const r=(await store.list())[0];await store.update(r.id,x=>{x.testCount=0;});
  await Promise.all(Array.from({length:24},(_,i)=>(i%2?store:second).update(r.id,async x=>{const before=x.testCount;await new Promise(r=>setTimeout(r,2));x.testCount=before+1;})));
  assert.equal((await store.get(r.id)).testCount,24);
 });
 await t.test('import skips existing IDs, never overwrites and preserves paid metadata',async()=>{
  const old=(await store.list())[0];const paid=fixture({paymentStatus:'paid',status:'confirmed',paidAt:'2026-10-01T16:00:00Z',stripeSessionId:'cs_test_import'});
  const result=await store.importLegacy([{...old,status:'cancelled'},paid]);assert.deepEqual(result,{inserted:1,skipped:1});assert.equal((await store.get(old.id)).status,'awaiting_payment');
  assert.equal(await store.hasPaidRide('test@example.test',''),true);
  const ledger=(await pool.query('SELECT retain_until > paid_at AS retained FROM er_payment_ledger WHERE booking_id=$1',[paid.id])).rows[0];assert.equal(ledger.retained,true);
  assert.deepEqual(await store.importLegacy([paid]),{inserted:0,skipped:1});
 });
 await t.test('import SQL failure rolls back prior inserts and audit event',async()=>{
  const first=fixture(),last=fixture();let inserts=0;
  const wrapped={connect:async()=>{const client=await pool.connect();return {query:async(sql,args)=>{if(sql.startsWith('INSERT INTO er_reservations') && ++inserts===2)throw new Error('private-detail');return client.query(sql,args);},release:x=>client.release(x)};}};
  const failing=createStore({},wrapped);const count=(await pool.query('SELECT count(*)::integer AS n FROM er_storage_audit')).rows[0].n;
  await assert.rejects(failing.importLegacy([first,last]),generic);assert.equal(await store.get(first.id),null);assert.equal(await store.get(last.id),null);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM er_storage_audit')).rows[0].n,count);
 });
 await t.test('malformed stored records fail closed, not as empty data',async()=>{
  const record=(await store.list())[0];await pool.query('UPDATE er_reservations SET record=$2::jsonb WHERE id=$1',[record.id,JSON.stringify({...record,quote:{total:'invalid'}})]);
  await assert.rejects(store.list(),generic);await assert.rejects(store.get(record.id),generic);
  await pool.query('UPDATE er_reservations SET record=$2::jsonb WHERE id=$1',[record.id,JSON.stringify(record)]);
 });
 await pool.query('TRUNCATE er_first_ride_claims, er_reservations, er_storage_audit, er_payment_ledger, er_paid_ride_eligibility');
 const testPath=path.join(__dirname,'security-abuse.test.cjs'),source=fs.readFileSync(testPath,'utf8');
 const factory=new Function('require','__dirname',source.slice(0,source.indexOf('test("approved prices'))+'\nreturn {harness,booking};')(createRequire(testPath),__dirname);
 const h=await factory.harness(t,{},'[]',store),other=await factory.harness(t,{},'[]',second);other.state.sessions=h.state.sessions;
 await t.test('approved pricing and Round Trip FIRST15 work through PostgreSQL',async()=>{
  for(const [body,total] of [
    [factory.booking,100], [{...factory.booking,vehicle:'suv'},80],
    [{...factory.booking,tripType:'airport'},100], [{...factory.booking,tripType:'hourly',hours:3},450],
    [{...factory.booking,vehicle:'suv',offerCode:'EWR_MANHATTAN_SUV',promoCode:'FIRST15'},150],
    [{...factory.booking,tripType:'roundtrip',returnDate:'2026-11-11',returnTime:'14:00',promoCode:'FIRST15'},170]
  ]){const response=await h.request('/api/quote',body);assert.equal(response.status,200);assert.equal(response.body.total,total);}
 });
 await t.test('competing checkout workers create one reservation and one Stripe session',async()=>{
  h.state.createDelay=100;const first=h.request('/api/checkout',factory.booking);
  await new Promise(r=>setTimeout(r,40));const competing=await other.request('/api/checkout',factory.booking);
  const result=await first;assert.equal(result.status,200);assert.equal(competing.status,503);
  assert.equal(h.state.creates.length+other.state.creates.length,1);assert.equal((await store.list()).length,1);
  assert.equal((await other.request('/api/checkout',factory.booking, {cookie:h.checkoutCookies()})).status,200);
  assert.equal(h.state.creates.length+other.state.creates.length,1);
 });
 await t.test('unauthenticated replay and authenticated retry stay isolated across PostgreSQL workers',async()=>{
  const record=(await store.list())[0],before=record.customerAccess.tokenHash;
  const ownerCookie=h.checkoutCookies();
  const statusCookie=ownerCookie.split('; ').find(value=>value.includes(record.id)).replace('er_checkout_access_','er_booking_access_');
  const [owner,attacker]=await Promise.all([
   h.request('/api/checkout',factory.booking,{cookie:ownerCookie}),
   other.request('/api/checkout',factory.booking,{cookie:''})
  ]);
  assert.ok([200,503].includes(owner.status));assert.equal(attacker.status,503);
  assert.equal(attacker.headers.get('set-cookie'),null);
  assert.deepEqual(Object.keys(attacker.body).sort(),['error','referenceId']);
  assert.equal((await store.get(record.id)).customerAccess.tokenHash,before);
  assert.equal((await h.request('/api/booking/'+record.id,undefined,{cookie:statusCookie})).status,200);
  assert.equal((await other.request('/api/checkout',factory.booking,{cookie:ownerCookie})).status,200);
  assert.equal(h.state.creates.length+other.state.creates.length,1);
 });
 await t.test('ambiguous Stripe failure retains a durable attempt for another worker retry',async()=>{
  const body={...factory.booking,email:'retry@example.test',phone:'2015550188'};
  h.state.fail=new Error('mock provider failure');
  assert.equal((await h.request('/api/checkout',body)).status,503);
  const records=await store.list(),pending=records.find(r=>r.customer.email===body.email);assert.ok(pending.checkoutAttempt.key);assert.equal(pending.stripeSessionId,null);
  const failedKey=h.state.creates.at(-1).options.idempotencyKey;
  const retry=await other.request('/api/checkout',body,{cookie:h.checkoutCookies()});assert.equal(retry.status,200);
  assert.equal(other.state.creates.at(-1).options.idempotencyKey,failedKey);
  assert.equal((await store.list()).filter(r=>r.customer.email===body.email).length,1);
 });
 await t.test('FIRST15 claims serialize equivalent identities across workers, independently of trip time',async()=>{
  const firstBody={...factory.booking,email:'atomic@example.test',phone:'2015550111',promoCode:'FIRST15'};
  const secondBody={...firstBody,email:' ATOMIC@EXAMPLE.TEST ',phone:'(201) 555-0111',time:'13:00'};
  h.state.createDelay=100;
  const results=await Promise.all([h.request('/api/checkout',firstBody),other.request('/api/checkout',secondBody)]);
  assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===409).length,1);
  const winner=results.find(r=>r.status===200),record=await store.get(winner.body.bookingId);
  assert.equal(record.quote.discount,15);assert.equal(record.quote.total,85);
  const count=(await pool.query('SELECT count(*)::integer AS n FROM er_first_ride_claims WHERE booking_id=$1',[record.id])).rows[0].n;assert.equal(count,2);
  const retryBody=record.trip.time==='12:00'?firstBody:secondBody;
  const before=h.state.creates.length+other.state.creates.length;
  assert.equal((await other.request('/api/checkout',retryBody,{cookie:(record.trip.time==='12:00'?h:other).checkoutCookies()})).status,200);
  assert.equal(h.state.creates.length+other.state.creates.length,before);
  const paid={id:record.stripeSessionId,metadata:{bookingId:record.id},amount_total:8500,currency:'usd',mode:'payment',payment_status:'paid'};
  assert.equal((await h.webhook(paid)).status,200);assert.equal((await h.webhook(paid)).status,200);
  assert.equal((await other.request('/api/checkout',{...firstBody,time:'15:00'})).status,400);
  assert.equal(await second.hasPaidRide('atomic@example.test','2015550111'),true);
 });
 await t.test('different customer claims proceed independently and hashed claims contain no plaintext',async()=>{
  const bodies=[{...factory.booking,email:'independent-a@example.test',phone:'2015550121',promoCode:'FIRST15'},
    {...factory.booking,email:'independent-b@example.test',phone:'2015550122',promoCode:'FIRST15'}];
  const results=await Promise.all([h.request('/api/checkout',bodies[0]),other.request('/api/checkout',bodies[1])]);assert.ok(results.every(r=>r.status===200));
  const claims=(await pool.query('SELECT identity_hash FROM er_first_ride_claims')).rows;assert.ok(claims.every(r=>/^[a-f0-9]{64}$/.test(r.identity_hash)));
 });
 await t.test('definitive failed Checkout releases FIRST15; ambiguous failure preserves claim and key',async()=>{
  const body={...factory.booking,email:'failure-first@example.test',phone:'2015550131',promoCode:'FIRST15'};
  h.state.fail=Object.assign(new Error('mock definitive failure'),{type:'StripeInvalidRequestError',statusCode:400,code:'parameter_missing'});
  assert.equal((await h.request('/api/checkout',body)).status,503);
  assert.equal((await other.request('/api/checkout',{...body,time:'13:00'})).status,200);
  const ambiguous={...body,email:'ambiguous-first@example.test',phone:'2015550132'};
  h.state.fail=new Error('mock ambiguous failure');assert.equal((await h.request('/api/checkout',ambiguous)).status,503);
  const key=h.state.creates.at(-1).options.idempotencyKey;
  assert.equal((await other.request('/api/checkout',{...ambiguous,time:'13:00'})).status,409);
  assert.equal((await other.request('/api/checkout',ambiguous,{cookie:h.checkoutCookies()})).status,200);
  assert.equal(other.state.creates.at(-1).options.idempotencyKey,key);
 });
 await t.test('expired ambiguous FIRST15 requires reconciliation; a later error cannot release its claim',async()=>{
  h.advance(31*60*1000);other.advance(31*60*1000);
  const body={...factory.booking,email:'old-ambiguous@example.test',phone:'2015550139',promoCode:'FIRST15'};
  h.state.fail=new Error('mock ambiguous creation');assert.equal((await h.request('/api/checkout',body)).status,503);
  const key=h.state.creates.at(-1).options.idempotencyKey;
  h.advance(25*60*60*1000);other.advance(25*60*60*1000);
  assert.equal((await other.request('/api/checkout',body,{cookie:h.checkoutCookies()})).status,503);
  assert.equal(other.state.creates.some(x=>x.options.idempotencyKey===key),false);
  assert.equal((await h.request('/api/checkout',{...body,time:'13:00'})).status,409);
  assert.equal((await store.list()).find(r=>r.customer.email===body.email && r.trip.time==='12:00').checkoutAttempt.state,'review_required');
 });
 await t.test('abandoned open and processing payments retain claims; verified expired/unpaid releases safely',async()=>{
  h.advance(31*60*1000);other.advance(31*60*1000);
  const body={...factory.booking,email:'abandoned-first@example.test',phone:'2015550141',promoCode:'FIRST15'};
  const first=await h.request('/api/checkout',body);assert.equal(first.status,200);const record=await store.get(first.body.bookingId);
  assert.equal((await other.request('/api/checkout',{...body,time:'13:00'})).status,409);
  const session=h.state.sessions.get(record.stripeSessionId);session.status='complete';session.payment_status='unpaid';
  assert.equal((await other.request('/api/checkout',{...body,time:'14:00'})).status,409);
  session.status='expired';session.payment_status='unpaid';
  await h.context.reconcileFirstRide(record.id);
  const replacement=await other.request('/api/checkout',{...body,time:'15:00'});assert.equal(replacement.status,200);
  assert.equal((await store.get(replacement.body.bookingId)).quote.total,85);
  assert.equal((await h.request('/api/quote',body)).status,200);
 });
 await t.test('webhook/admin changes preserve each other, ledgers enforce FIRST15 and customer access remains scoped',async()=>{
  const result=await h.request('/api/checkout',factory.booking); const record=await store.get(result.body.bookingId);const cookie=h.checkoutCookies().split('; ').find(value=>value.includes(record.id)).replace('er_checkout_access_','er_booking_access_');
  assert.equal((await h.request('/api/booking/'+record.id)).status,401);assert.equal((await h.request('/api/booking/'+record.id,undefined,{cookie})).status,200);
  const login=await h.request('/api/admin/login',{token:'local-test-token'}),adminCookie=login.headers.get('set-cookie').split(';')[0];
  const event={id:record.stripeSessionId,metadata:{bookingId:record.id},amount_total:10000,currency:'usd',mode:'payment',payment_status:'paid'};
  const results=await Promise.all([h.webhook(event),h.request('/api/bookings/'+record.id,{status:'assigned',dispatch:{driver:'Test driver',driverPhone:'2015550199',vehicle:'SUV',plate:'TEST'}},{cookie:adminCookie},'PATCH')]);
  assert.ok(results.every(r=>r.status===200));const saved=await store.get(record.id);assert.equal(saved.paymentStatus,'paid');assert.equal(saved.status,'assigned');assert.equal(saved.dispatch.driver,'Test driver');
  assert.equal((await h.request('/api/quote',{...factory.booking,promoCode:'FIRST15'})).status,400);
  for(const change of [{amount_total:1},{currency:'eur'},{id:'cs_wrong'},{mode:'setup'}])assert.equal((await h.webhook({...event,...change})).status,400);
  assert.equal((await h.webhook(event,undefined,true)).status,400);
  for(const [type,payment] of [['checkout.session.completed','paid'],['checkout.session.async_payment_failed','unpaid'],['checkout.session.async_payment_succeeded','paid']])assert.equal((await h.webhook({...event,payment_status:payment},type)).status,200);
  const afterDuplicates=await store.get(record.id);assert.equal(afterDuplicates.status,'assigned');assert.equal(afterDuplicates.paymentStatus,'paid');
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM er_payment_ledger WHERE booking_id=$1',[record.id])).rows[0].n,1);
  const customer=await h.request('/api/booking/'+record.id,undefined,{cookie});assert.equal(customer.body.dispatch.driver,'Test driver');assert.equal(customer.headers.get('cache-control'),'no-store');assert.equal(Object.hasOwn(customer.body,'customer'),false);
  assert.equal((await h.request('/api/bookings',undefined,{cookie:adminCookie})).status,200);
 });
 await t.test('FIRST15 lost response is reconciled after pickup across storage instances without new Stripe creation',async()=>{
  h.advance(31*60*1000);other.advance(31*60*1000);
  const body={...factory.booking,email:'recover-past@example.test',phone:'2015550161',promoCode:'FIRST15'};
  h.state.loseResponse=true;assert.equal((await h.request('/api/checkout',body)).status,503);
  const record=(await store.list()).find(r=>r.customer.email===body.email),session=[...h.state.sessions.values()].find(s=>s.metadata?.bookingId===record.id);
  assert.equal(record.stripeSessionId,null);const before=h.state.creates.length+other.state.creates.length;
  h.advance(42*24*60*60*1000);other.advance(42*24*60*60*1000);session.status='expired';
  await other.context.reconcileFirstRide(record.id);
  const recovered=await store.get(record.id);assert.equal(recovered.stripeSessionId,session.id);assert.equal(recovered.checkoutAttempt.state,'confirmed_unpaid');
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM er_first_ride_claims WHERE booking_id=$1',[record.id])).rows[0].n,0);
  assert.equal(h.state.creates.length+other.state.creates.length,before);
  assert.equal((await h.request('/api/checkout',body)).status,400);
  const future=await h.request('/api/checkout',{...body,date:'2026-12-20'});assert.equal(future.status,200);assert.equal((await store.get(future.body.bookingId)).quote.total,85);
 });
 await t.test('PostgreSQL ambiguous review state survives restart and remains claimed',async()=>{
  const body={...factory.booking,date:'2026-12-20',email:'review-only@example.test',phone:'2015550162',promoCode:'FIRST15'};
  h.state.fail=new Error('mock uncertain submission');assert.equal((await h.request('/api/checkout',body)).status,503);
  const record=(await store.list()).find(r=>r.customer.email===body.email);
  await other.context.reconcileFirstRide(record.id);
  const persisted=await second.get(record.id);assert.equal(persisted.checkoutAttempt.state,'review_required');assert.equal(persisted.checkoutAttempt.evidence,'no_conclusive_evidence');
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM er_first_ride_claims WHERE booking_id=$1',[record.id])).rows[0].n,2);
  const restarted=await factory.harness(t,{},'[]',second);assert.equal((await restarted.testStore.get(record.id)).checkoutAttempt.state,'review_required');
 });
 await t.test('PostgreSQL paid webhook racing with reconciliation cannot erase permanent eligibility',async()=>{
  const body={...factory.booking,date:'2026-12-20',email:'paid-race@example.test',phone:'2015550163',promoCode:'FIRST15'};
  const first=await h.request('/api/checkout',body);assert.equal(first.status,200);
  const record=await store.get(first.body.bookingId),session=h.state.sessions.get(record.stripeSessionId);
  session.status='complete';session.payment_status='paid';
  const event={...session};
  await Promise.all([other.context.reconcileFirstRide(record.id),h.webhook(event)]);
  const saved=await second.get(record.id);assert.equal(saved.paymentStatus,'paid');assert.equal(saved.checkoutAttempt.state,'confirmed_paid');
  assert.equal(await second.hasPaidRide(body.email,body.phone),true);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM er_payment_ledger WHERE booking_id=$1',[record.id])).rows[0].n,1);
  assert.equal(await second.finalizeReconciliation(record,{state:'confirmed_unpaid',evidence:'verified_expired_unpaid',sessionId:session.id,at:Date.now()}),false);
  assert.equal((await h.request('/api/quote',{...body,time:'13:00'})).status,400);
 });
 await t.test('PostgreSQL reconciliation and new FIRST15 claims are atomic across workers',async()=>{
  const body={...factory.booking,date:'2026-12-20',email:'claim-race@example.test',phone:'2015550164',promoCode:'FIRST15'};
  const first=await h.request('/api/checkout',body);assert.equal(first.status,200);
  const record=await store.get(first.body.bookingId);h.state.sessions.get(record.stripeSessionId).status='expired';
  const next={...body,time:'13:00'};
  const [,request]=await Promise.all([h.context.reconcileFirstRide(record.id),other.request('/api/checkout',next)]);
  assert.ok([200,409].includes(request.status));
  const retry=await other.request('/api/checkout',next);assert.equal(retry.status,200);
  assert.equal((await pool.query('SELECT count(DISTINCT booking_id)::integer AS n FROM er_first_ride_claims WHERE identity_hash=$1',[crypto.createHash('sha256').update(body.email).digest('hex')])).rows[0].n,1);
  assert.equal((await store.get(retry.body.bookingId)).quote.total,85);
 });
 await t.test('PostgreSQL reconciliation rollback preserves original reservation and FIRST15 claim',async()=>{
  const body={...factory.booking,date:'2026-12-20',email:'rollback-reconcile@example.test',phone:'2015550165',promoCode:'FIRST15'};
  const first=await h.request('/api/checkout',body);assert.equal(first.status,200);
  const record=await store.get(first.body.bookingId);h.state.sessions.get(record.stripeSessionId).status='expired';
  await pool.query("CREATE OR REPLACE FUNCTION er_test_reconciliation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.record #>> '{checkoutAttempt,state}'='confirmed_unpaid' THEN RAISE EXCEPTION 'synthetic transaction failure'; END IF; RETURN NEW; END $$");
  await pool.query('CREATE TRIGGER er_test_reconciliation_failure BEFORE UPDATE ON er_reservations FOR EACH ROW EXECUTE FUNCTION er_test_reconciliation_failure()');
  try {
   await assert.rejects(other.context.reconcileFirstRide(record.id),e=>e.storageFailure);
   assert.deepEqual(await store.get(record.id),record);
   assert.equal((await pool.query('SELECT count(*)::integer AS n FROM er_first_ride_claims WHERE booking_id=$1',[record.id])).rows[0].n,2);
  } finally {
   await pool.query('DROP TRIGGER er_test_reconciliation_failure ON er_reservations');await pool.query('DROP FUNCTION er_test_reconciliation_failure()');
  }
 });

 await t.test('New audit 3: PostgreSQL persists only verified special pickup; Checkout re-verifies across workers',async()=>{
  await pool.query('TRUNCATE er_first_ride_claims, er_reservations, er_storage_audit, er_payment_ledger, er_paid_ride_eligibility');
  const body={...factory.booking,vehicle:'suv',offerCode:'EWR_MANHATTAN_SUV',promoCode:'FIRST15',email:'ewr-bound@example.test',phone:'2015550188'};
  const fresh=await factory.harness(t,{},'[]',store),retryWorker=await factory.harness(t,{},'[]',second);
  const result=await fresh.request('/api/checkout',body);assert.equal(result.status,200);
  const record=await second.get(result.body.bookingId);
  assert.equal(record.trip.pickupPlaceId,body.pickupPlaceId);
  assert.equal(record.trip.pickup,'Newark Liberty International Airport, 3 Brewster Rd, Newark, NJ');
  assert.equal(record.quote.total,150);assert.equal(record.quote.discount,0);assert.equal(record.quote.promotion,null);
  assert.equal(fresh.state.routes[0].origin.placeId,record.trip.pickupPlaceId);
  retryWorker.state.sessions=fresh.state.sessions;
  retryWorker.state.placeDetails={id:'changed_id',displayName:{text:'Hotel'},formattedAddress:'Nearby street'};
  const denied=await retryWorker.request('/api/checkout',body,{cookie:fresh.checkoutCookies()});
  assert.equal(denied.status,400);assert.equal(retryWorker.state.creates.length,0);
  assert.deepEqual(await store.get(record.id),record);
 });

});
