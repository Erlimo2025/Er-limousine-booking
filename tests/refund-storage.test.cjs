const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Pool}=require('pg');
const {createStore}=require('../storage/postgres');
const {prepareRefund}=require('../storage/refunds');
const enabled=!!process.env.ER_TEST_DATABASE_URL,now=Date.parse('2026-10-01T16:00:00Z');
async function database(t){
 const url=new URL(process.env.ER_TEST_DATABASE_URL);assert.ok(['localhost','127.0.0.1'].includes(url.hostname));assert.ok(url.pathname.startsWith('/er_test_'));
 const admin=new Pool({connectionString:url.toString()}),schema='refund_storage_'+crypto.randomBytes(8).toString('hex');await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:url.toString(),options:'-c search_path='+schema}),otherPool=new Pool({connectionString:url.toString(),options:'-c search_path='+schema});
 const store=createStore({},pool),other=createStore({},otherPool);t.after(async()=>{await store.close();await other.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});await store.migrate();
 const auth={id:crypto.randomUUID(),sessionHash:crypto.randomBytes(32).toString('hex')};
 await store.registerCustomer({id:auth.id,full_name:'Refund Owner',normalized_email:'refund-owner@example.test',display_email:'refund-owner@example.test',normalized_phone:'+12025550171',display_phone:'2025550171',password_hash:'synthetic-password-hash'}, {hash:auth.sessionHash,created:new Date(now),expires:new Date(now+2*86400000)});
 const record={id:crypto.randomUUID(),createdAt:new Date(now).toISOString(),status:'cancelled',paymentStatus:'paid',paidAt:new Date(now).toISOString(),stripeSessionId:'cs_test_refund_capture',customer:{firstName:'Refund',lastName:'Owner',email:'refund-owner@example.test',phone:'2025550171'},trip:{pickup:'EWR',dropoff:'Manhattan',date:'2026-11-10',time:'12:00',vehicle:'suv',tripType:'oneway',passengers:2},quote:{total:150,currency:'usd',vehicle:'Luxury SUV',vehicleKey:'suv'},dispatch:{driver:'',driverPhone:'',vehicle:'',plate:''}};
 await store.createWithBudget(record,()=>{}, {customerId:auth.id,sessionHash:auth.sessionHash,now,start:new Date('2026-11-10T17:00:00Z'),end:new Date('2026-11-10T17:00:00Z')});
 const source={sessionId:record.stripeSessionId,paymentIntentId:'pi_test_refund_capture',chargeId:'ch_test_refund_capture',amountCents:15000,currency:'usd'},key='reservation:'+record.id;
 async function prepare(sourceOverride=source){
  const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1)',[730903]);await client.query('SELECT id FROM er_reservations WHERE id=$1 FOR UPDATE',[record.id]);
   const event=(await client.query("INSERT INTO er_customer_trip_events(id,booking_id,customer_id,request_id,kind,old_start_at,new_start_at,old_end_at,new_end_at,details,created_at) VALUES($1,$2,$3,$4,'customer_cancelled',$5,$5,$5,$5,$6::jsonb,$7) RETURNING *",[crypto.randomUUID(),record.id,auth.id,crypto.randomUUID(),new Date('2026-11-10T17:00:00Z'),JSON.stringify({oldDate:record.trip.date,oldTime:record.trip.time}),new Date(now)])).rows[0];
   const copy=structuredClone(record),refund=await prepareRefund(client,copy,auth,event,sourceOverride,now);await client.query('UPDATE er_reservations SET record=$2::jsonb WHERE id=$1',[record.id,JSON.stringify(copy)]);await client.query('COMMIT');return {refund,event};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 const event=refund=>({attemptId:refund.id,bookingId:record.id,eventId:'evt_test_'+crypto.randomBytes(8).toString('hex'),refundId:'re_test_refund_capture',paymentIntentId:source.paymentIntentId,chargeId:source.chargeId,amountCents:source.amountCents,currency:source.currency,status:'succeeded'});
 return {pool,store,other,auth,record,source,key,prepare,event};
}

test('PostgreSQL refunds: server ledger source, immutable authority/evidence and migration restart',{skip:!enabled},async t=>{
 const d=await database(t),{refund}=await d.prepare();assert.equal(refund.amount_cents,15000);assert.equal(refund.idempotency_key,'er-refund-'+refund.id);assert.equal((await d.store.get(d.record.id)).refundStatus,'processing');
 await assert.rejects(d.pool.query('UPDATE er_reservation_refunds SET amount_cents=1 WHERE id=$1',[refund.id]),/immutable/);
 await assert.rejects(d.pool.query("UPDATE er_reservation_refunds SET charge_id='ch_foreign' WHERE id=$1",[refund.id]),/immutable/);
 await assert.rejects(d.pool.query("UPDATE er_reservation_refund_events SET evidence='submitted' WHERE refund_id=$1",[refund.id]),/immutable/);
 await assert.rejects(d.pool.query('DELETE FROM er_reservation_refund_events WHERE refund_id=$1',[refund.id]),/immutable/);
 await Promise.all([d.store.migrate(),d.other.migrate()]);assert.equal((await d.store.refundForBooking(d.record.id)).id,refund.id);assert.equal((await d.store.capturedPayment(d.record.id)).amount_cents,'15000');
 await assert.rejects(d.store.startRefundSubmission(refund.id,now),error=>error.status===409);
});

test('PostgreSQL refunds: lost submission survives workers with one durable key and unknown 23-hour cutoff',{skip:!enabled},async t=>{
 const d=await database(t),{refund}=await d.prepare();
 const first=await d.store.withActionLock(d.key,()=>d.store.startRefundSubmission(refund.id,now));assert.equal(first.state,'submitted_unknown');assert.equal(first.submission_count,1);
 const afterError=await d.other.withActionLock(d.key,()=>d.other.recordRefundOutcome(refund.id,{state:'submitted_unknown',evidence:'ambiguous_provider_error'},now+1000));assert.equal(afterError.state,'submitted_unknown');assert.equal(afterError.idempotency_key,first.idempotency_key);
 const retry=await d.other.withActionLock(d.key,()=>d.other.startRefundSubmission(refund.id,now+2000));assert.equal(retry.id,first.id);assert.equal(retry.idempotency_key,first.idempotency_key);assert.equal(retry.first_submitted_at.getTime(),now);assert.equal(retry.submission_count,2);
 const retired=await d.store.withActionLock(d.key,()=>d.store.startRefundSubmission(refund.id,now+23*3600000));assert.equal(retired.state,'review_required');assert.equal(retired.submission_count,2);assert.equal((await d.store.get(d.record.id)).refundStatus,'review_required');
 const again=await d.other.withActionLock(d.key,()=>d.other.startRefundSubmission(refund.id,now+24*3600000));assert.equal(again.state,'review_required');assert.equal(again.id,refund.id);assert.equal(again.submission_count,2);assert.equal((await d.store.refundCandidates(now+24*3600000)).length,0);
});

test('PostgreSQL refunds: API provider success remains processing, known IDs survive errors and signed success is sole confirmation',{skip:!enabled},async t=>{
 const d=await database(t),{refund}=await d.prepare();await d.store.withActionLock(d.key,()=>d.store.startRefundSubmission(refund.id,now));
 await d.store.withActionLock(d.key,()=>d.store.recordRefundOutcome(refund.id,{state:'provider_identified',refundId:'re_test_refund_capture',evidence:'provider_succeeded_awaiting_webhook'},now+1000));assert.equal((await d.store.get(d.record.id)).refundStatus,'processing');
 const error=await d.other.withActionLock(d.key,()=>d.other.recordRefundOutcome(refund.id,{state:'submitted_unknown',evidence:'ambiguous_provider_error'},now+2000));assert.equal(error.state,'provider_identified');assert.equal(error.stripe_refund_id,'re_test_refund_capture');
 const late=await d.other.withActionLock(d.key,()=>d.other.startRefundSubmission(refund.id,now+24*3600000));assert.equal(late.state,'provider_identified');assert.equal(late.idempotency_key,refund.idempotency_key);assert.equal((await d.store.refundCandidates(now+24*3600000)).length,1);
 const wire=d.event(refund);for(const patch of [{amountCents:1},{bookingId:crypto.randomUUID()},{chargeId:'ch_other'},{paymentIntentId:'pi_other'},{currency:'eur'},{refundId:'re_other'}])assert.equal(await d.store.confirmRefundWebhook({...wire,...patch},now+24*3600000),false);
 assert.deepEqual(await Promise.all([d.store.confirmRefundWebhook(wire,now+24*3600000),d.other.confirmRefundWebhook(wire,now+24*3600000)]),[true,true]);
 const paid=await d.store.get(d.record.id);assert.equal(paid.status,'cancelled');assert.equal(paid.paymentStatus,'paid');assert.equal(paid.refundStatus,'confirmed');assert.equal(paid.quote.total,150);
 assert.equal((await d.pool.query("SELECT count(*) FROM er_booking_email_outbox WHERE kind IN ('customer_refund_confirmed','admin_refund_confirmed')")).rows[0].count,'2');
 await d.store.withActionLock(d.key,()=>d.store.recordRefundOutcome(refund.id,{state:'submitted_unknown',evidence:'ambiguous_provider_error'},now+25*3600000));assert.equal((await d.store.refundForBooking(d.record.id)).state,'confirmed');
 await assert.rejects(d.pool.query("UPDATE er_reservation_refunds SET state='review_required',confirmed_at=NULL WHERE id=$1",[refund.id]),/immutable/);
 await d.store.migrate();assert.equal((await d.store.get(d.record.id)).refundStatus,'confirmed');
});

test('PostgreSQL refunds: signed failed then succeeded is monotonic and duplicate/out-of-order events cannot double-email',{skip:!enabled},async t=>{
 const d=await database(t),{refund}=await d.prepare(),failed={...d.event(refund),status:'failed'};await d.store.withActionLock(d.key,()=>d.store.startRefundSubmission(refund.id,now));
 assert.equal(await d.store.confirmRefundWebhook(failed,now+1000),true);assert.equal((await d.store.refundForBooking(d.record.id)).state,'failed');assert.equal((await d.store.get(d.record.id)).refundStatus,'review_required');assert.equal((await d.store.refundCandidates(now+1000)).length,0);
 const succeeded={...failed,status:'succeeded',eventId:'evt_test_success'};assert.equal(await d.other.confirmRefundWebhook(succeeded,now+2000),true);assert.equal((await d.store.get(d.record.id)).refundStatus,'confirmed');
 assert.equal(await d.store.confirmRefundWebhook({...failed,eventId:'evt_test_late_fail'},now+3000),true);assert.equal((await d.store.refundForBooking(d.record.id)).state,'confirmed');
 assert.equal((await d.pool.query('SELECT count(*) FROM er_reservation_refund_events WHERE stripe_event_id IS NOT NULL')).rows[0].count,'2');assert.equal((await d.pool.query("SELECT count(*) FROM er_booking_email_outbox WHERE kind IN ('customer_refund_confirmed','admin_refund_confirmed')")).rows[0].count,'2');
});

test('PostgreSQL refunds: authoritative ledger mismatch rolls back audit/refund preparation together',{skip:!enabled},async t=>{
 const d=await database(t);for(const patch of [{amountCents:14999},{sessionId:'cs_foreign'},{currency:'eur'}])await assert.rejects(d.prepare({...d.source,...patch}),error=>error.status===409);
 assert.equal((await d.pool.query('SELECT count(*) FROM er_customer_trip_events')).rows[0].count,'0');assert.equal((await d.pool.query('SELECT count(*) FROM er_reservation_refunds')).rows[0].count,'0');assert.equal((await d.pool.query('SELECT count(*) FROM er_reservation_refund_events')).rows[0].count,'0');assert.equal((await d.store.get(d.record.id)).refundStatus,undefined);
 await d.pool.query('UPDATE er_payment_ledger SET amount_cents=14000 WHERE booking_id=$1',[d.record.id]);await assert.rejects(d.prepare(),error=>error.status===409);assert.equal((await d.pool.query('SELECT count(*) FROM er_customer_trip_events')).rows[0].count,'0');
});

test('PostgreSQL refunds: signed pending identifies a lost response without confirming, survives retry window and ignores stale pending after failure',{skip:!enabled},async t=>{
 const d=await database(t),{refund}=await d.prepare();await d.store.withActionLock(d.key,()=>d.store.startRefundSubmission(refund.id,now));
 const pending={...d.event(refund),status:'pending'};assert.equal(await d.other.confirmRefundWebhook(pending,now+1000),true);
 let row=await d.store.refundForBooking(d.record.id);assert.equal(row.state,'provider_identified');assert.equal(row.stripe_refund_id,pending.refundId);assert.equal(row.confirmed_at,null);assert.equal((await d.store.get(d.record.id)).refundStatus,'processing');
 assert.equal((await d.pool.query("SELECT count(*) FROM er_booking_email_outbox WHERE kind IN ('customer_refund_confirmed','admin_refund_confirmed')")).rows[0].count,'0');
 await d.store.withActionLock(d.key,()=>d.store.recordRefundOutcome(refund.id,{state:'submitted_unknown',evidence:'ambiguous_provider_error'},now+2000));
 row=await d.other.withActionLock(d.key,()=>d.other.startRefundSubmission(refund.id,now+24*3600000));assert.equal(row.state,'provider_identified');assert.equal(row.stripe_refund_id,pending.refundId);assert.equal(row.idempotency_key,refund.idempotency_key);
 const requiresAction={...pending,eventId:'evt_test_requires_action',status:'requires_action'};assert.equal(await d.store.confirmRefundWebhook(requiresAction,now+24*3600000+1000),true);assert.equal((await d.store.get(d.record.id)).refundStatus,'processing');
 const failed={...pending,eventId:'evt_test_pending_failed',status:'failed'};assert.equal(await d.other.confirmRefundWebhook(failed,now+24*3600000+2000),true);
 assert.equal(await d.store.confirmRefundWebhook({...pending,eventId:'evt_test_stale_pending'},now+24*3600000+3000),true);assert.equal((await d.store.refundForBooking(d.record.id)).state,'failed');assert.equal((await d.store.get(d.record.id)).refundStatus,'review_required');
 const succeeded={...pending,eventId:'evt_test_pending_succeeded',status:'succeeded'};assert.equal(await d.store.confirmRefundWebhook(succeeded,now+24*3600000+4000),true);assert.equal((await d.store.get(d.record.id)).refundStatus,'confirmed');
 assert.equal(await d.other.confirmRefundWebhook(succeeded,now+24*3600000+5000),true);assert.equal((await d.pool.query("SELECT count(*) FROM er_booking_email_outbox WHERE kind IN ('customer_refund_confirmed','admin_refund_confirmed')")).rows[0].count,'2');
 await d.store.migrate();assert.equal((await d.store.refundForBooking(d.record.id)).state,'confirmed');
});

test('PostgreSQL refunds: current-provider-verified signed bank failure reverses current confirmation but preserves history and cannot double-email',{skip:!enabled},async t=>{
 const d=await database(t),{refund}=await d.prepare();await d.store.withActionLock(d.key,()=>d.store.startRefundSubmission(refund.id,now));
 const succeeded=d.event(refund);assert.equal(await d.store.confirmRefundWebhook(succeeded,now+1000),true);
 const initial=await d.store.refundForBooking(d.record.id),confirmedAt=initial.confirmed_at.toISOString();assert.equal((await d.store.get(d.record.id)).refundStatus,'confirmed');
 const failed={...succeeded,eventId:'evt_test_bank_returned',status:'failed'};
 assert.equal(await d.store.confirmRefundWebhook(failed,now+2000),true);assert.equal((await d.store.get(d.record.id)).refundStatus,'confirmed');
 await assert.rejects(d.store.confirmRefundWebhook({...failed,providerVerified:true},now+2000),error=>error.status===409);
 assert.equal(await d.other.withActionLock(d.key,()=>d.other.confirmRefundWebhook({...failed,providerVerified:true},now+3000)),true);
 const returned=await d.store.refundForBooking(d.record.id),record=await d.store.get(d.record.id);assert.equal(returned.state,'failed');assert.equal(returned.confirmed_at.toISOString(),confirmedAt);assert.equal(record.status,'cancelled');assert.equal(record.paymentStatus,'paid');assert.equal(record.refundStatus,'review_required');assert.equal(record.refundConfirmedAt,undefined);assert.equal(record.paymentReviewRequired,true);assert.equal(record.quote.total,150);
 assert.equal((await d.pool.query('SELECT count(*) FROM er_reservation_refund_events WHERE stripe_event_id IS NOT NULL')).rows[0].count,'2');assert.equal((await d.pool.query("SELECT count(*) FROM er_booking_email_outbox WHERE kind IN ('customer_refund_confirmed','admin_refund_confirmed')")).rows[0].count,'2');
 const suppressed=(await d.pool.query("SELECT state,payload,lease_until,claim_token FROM er_booking_email_outbox WHERE kind IN ('customer_refund_confirmed','admin_refund_confirmed')")).rows;assert.equal(suppressed.length,2);for(const job of suppressed){assert.equal(job.state,'review_required');assert.equal(job.payload,null);assert.equal(job.lease_until,null);assert.equal(job.claim_token,null);}
 assert.equal((await d.pool.query("SELECT count(*) FROM er_booking_email_outbox WHERE kind IN ('customer_refund_review','admin_refund_review')")).rows[0].count,'2');
 assert.equal(await d.other.withActionLock(d.key,()=>d.other.confirmRefundWebhook({...failed,providerVerified:true},now+3500)),true);assert.equal((await d.pool.query("SELECT count(*) FROM er_booking_email_outbox WHERE kind IN ('customer_refund_review','admin_refund_review')")).rows[0].count,'2');
 await d.store.withActionLock(d.key,()=>d.store.recordRefundOutcome(refund.id,{state:'provider_identified',refundId:succeeded.refundId,evidence:'provider_succeeded_awaiting_webhook'},now+4000));assert.equal((await d.store.refundForBooking(d.record.id)).state,'failed');
 const restored={...succeeded,eventId:'evt_test_bank_recovered',providerVerified:true};assert.equal(await d.store.withActionLock(d.key,()=>d.store.confirmRefundWebhook(restored,now+5000)),true);
 assert.equal((await d.store.get(d.record.id)).refundStatus,'confirmed');assert.equal((await d.store.refundForBooking(d.record.id)).confirmed_at.toISOString(),confirmedAt);assert.equal((await d.pool.query("SELECT count(*) FROM er_booking_email_outbox WHERE kind IN ('customer_refund_confirmed','admin_refund_confirmed')")).rows[0].count,'2');
 await d.store.migrate();assert.equal((await d.store.refundForBooking(d.record.id)).confirmed_at.toISOString(),confirmedAt);
});
