'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const vm = require('node:vm');
const {hashToken} = require('../auth/customers');
const {cancellationTerms} = require('../services/reservation-self-service');
const {base, guestBooking, harness, initialClock} = require('./helpers/reservation-management.cjs');
const {unavailable, approvedFeature, stoppedBooking, startRollback} = require('./helpers/booking-stops-safe-rollback.cjs');

const pg = {skip:unavailable};
const payment = id => '/api/customer/trips/'+id+'/payment';

test('rollback refuses new stopped quotes and checkout before contacting providers',async t=>{
  const h = await harness(t);
  const booking = {...guestBooking,vehicle:'suv',paymentChoice:'later'};
  const stop = {address:'Example test address',placeId:'synthetic_stop',waitMinutes:10};
  for (const route of ['/api/quote','/api/checkout']) {
    for (const stops of [[stop],null,'invalid',{}]) {
      const response = await h.request(route,{...booking,stops});
      assert.equal(response.status,409);
      assert.match(response.body.error,/Remove the stops and request a new quote/);
    }
  }
  assert.equal(h.state.googleCalls,0);
  assert.equal(h.state.creates.length,0);
  assert.equal(h.records().length,0);
  assert.equal((await h.request('/api/quote',{...booking,stops:[]})).status,200);
  assert.doesNotMatch((await h.request('/')).body,/bookingStopEditor|Add Another Stop/);
  assert.doesNotMatch((await h.request('/manage-reservation.html')).body,/manageStopEditor|Request stop changes/);
  assert.doesNotMatch((await h.request('/booking-stops.js')).body,/createEditor|fetch\(/);
});

function checkStops(summary, accepted) {
  const plan = accepted.quote.stopPlan;
  assert.deepEqual(summary.stops,plan.stops.map(({placeId,...stop})=>stop));
  assert.equal(summary.chargeCents,plan.chargeCents);
  assert.equal(summary.rateCentsPerMinute,plan.rateCentsPerMinute);
  assert.equal(summary.freeMinutes,15);
}

for (const vehicle of ['suv','escalade']) {
  const guest = vehicle==='escalade';
  test('PostgreSQL rollback preserves '+vehicle+' stops, fare and payment access',pg,async t=>{
    const {feature,owner,id,accepted,input,quote} = await stoppedBooking(t,{
      vehicle,guest,paymentChoice:guest?'later':'now',loseResponse:!guest
    });
    const access = guest ? await feature.verify(accepted.bookingReference,input.email) : owner;
    assert.ok(access);
    const rollback = await startRollback(t,feature);
    const {h,store,request} = rollback;
    assert.deepEqual((await store.getForDisplay(id)).quote,accepted.quote);
    await assert.rejects(store.update(id,record=>{record.quote.stopPlan.chargeCents=0;}));

    const detailsPath = guest ? base+'/guest' : '/api/customer/trips/'+id;
    const details = await request(detailsPath,undefined,access);
    assert.equal(details.status,200,JSON.stringify(details.body));
    const shown = guest ? details.body.reservation : details.body.trip;
    checkStops(shown.stopSummary,accepted);
    assert.equal(shown.bookingReference,accepted.bookingReference);
    assert.equal(shown.total,accepted.quote.total);
    if (!guest) {
      const trips = await request('/api/customer/trips?view=upcoming',undefined,access);
      assert.equal(trips.status,200);
      const trip = trips.body.trips.find(item=>item.reference===id);
      checkStops(trip.stopSummary,accepted);
      assert.equal(trip.canBookAgain,false);
      assert.equal((await request('/api/customer/trips/'+id+'/book-again',undefined,access)).status,404);
    }

    const admin = await rollback.adminLogin();
    const dispatch = await request('/api/bookings/search?status=all&timing=all',undefined,admin);
    assert.equal(dispatch.status,200);
    const dispatched = dispatch.body.bookings.find(item=>item.id===id);
    checkStops(dispatched.trip.stopSummary,accepted);
    assert.equal(dispatched.bookingReference,accepted.bookingReference);
    assert.equal(dispatched.quote.total,accepted.quote.total);
    assert.equal((await request('/api/bookings/search?status=all&timing=all',undefined,access)).status,401);

    // A stale stopped request is blocked even for the same authenticated customer.
    const blocked = await request('/api/checkout',{...input,paymentChoice:'later',quoteRevision:quote.quoteRevision},access);
    assert.equal(blocked.status,409);
    const payPath = guest ? '/api/booking/'+id+'/checkout' : payment(id);
    const pay = await request(payPath,{},access);
    assert.equal(pay.status,200,JSON.stringify(pay.body));
    assert.equal(h.state.sessions.size,1);
    assert.equal(h.state.creates.length,1);
    assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,accepted.quote.totalCents);
    if (!guest) {
      assert.equal(accepted.checkoutAttempt.state,'submitted_unknown');
      assert.equal(h.state.creates[0].options.idempotencyKey,feature.h.state.creates[0].options.idempotencyKey);
    }
    assert.equal((await request(payPath,{},access)).status,200);
    assert.equal(h.state.creates.length,1);
    assert.equal(h.state.routes.length,0);

    const session = [...h.state.sessions.values()][0];
    session.status='complete'; session.payment_status='paid';
    assert.equal((await h.webhook(session)).status,200);
    assert.equal((await h.webhook(session)).status,200);
    const paid = await store.getForDisplay(id);
    assert.equal(paid.paymentStatus,'paid');
    assert.deepEqual(paid.quote,accepted.quote);
    assert.equal(paid.bookingReference,accepted.bookingReference);
    const captured = await store.capturedPayment(id);
    assert.equal(Number(captured.amount_cents),accepted.quote.totalCents);
    assert.equal(captured.stripe_session_id,session.id);
    assert.equal((await feature.pool.query('SELECT count(*)::int AS n FROM er_payment_ledger WHERE booking_id=$1',[id])).rows[0].n,1);

    // An ordinary no-stop quote and booking still use the baseline fare.
    approvedFeature().configure(h);
    const {stops: _stops,...ordinary} = input;
    const direct = {...ordinary,date:'2026-11-13'};
    const before = await feature.post('/api/quote',direct,owner);
    const after = await request('/api/quote',direct,owner);
    assert.equal(before.status,200);
    assert.equal(after.status,200);
    assert.equal(after.body.totalCents,before.body.totalCents);
    const reserved = await request('/api/checkout',{...direct,paymentChoice:'later',quoteRevision:after.body.quoteRevision},owner);
    assert.equal(reserved.status,200,JSON.stringify(reserved.body));
    const saved = await store.getForDisplay(reserved.body.bookingId);
    assert.match(saved.bookingReference,/^ER-[0-9]{6}$/);
    assert.equal(saved.quote.stopPlan,undefined);
    assert.equal(saved.quote.totalCents,before.body.totalCents);
  });
}

test('PostgreSQL rollback reconciles an existing stopped-trip refund with both flags off',pg,async t=>{
  const {feature,owner,id,accepted} = await stoppedBooking(t,{paymentChoice:'now'});
  const session = [...feature.h.state.sessions.values()][0];
  session.status='complete'; session.payment_status='paid';
  assert.equal((await feature.h.webhook(session)).status,200);
  const paid = await feature.store.getForDisplay(id);
  const originalLedger = await feature.store.capturedPayment(id);
  const manage = base+'/account/'+id;
  assert.equal((await feature.post(manage+'/cancellation/preview',{},owner)).status,404);

  // Model an obligation that already existed at cutover through the real storage transaction.
  feature.h.context.rollbackPaidRecord=paid;
  const funding = await vm.runInContext('managedCancellationRefundService.capture(rollbackPaidRecord)',feature.h.context);
  const terms = (record,at) => cancellationTerms(record,at,feature.h.context.parseServiceDateTime,funding);
  const revision = terms(paid,initialClock);
  assert.equal(revision.refundCents,accepted.quote.totalCents);
  assert.equal(revision.review,null);
  const action = paid.checkoutFingerprint || 'reservation:'+id;
  const authority = {kind:'account',customerId:await feature.store.reservationOwner(id),
    sessionHash:hashToken(owner.slice(owner.indexOf('=')+1))};
  const prepared = await feature.store.withActionLock(action,()=>feature.store.applyManagedCancellation({
    authority,reference:id,input:{requestId:crypto.randomUUID(),revision:revision.revision},
    proof:{safe:true,sessionId:session.id,refundSource:funding},check:{now:()=>initialClock,terms}
  }));
  assert.equal(prepared.row.state,'prepared');
  feature.h.state.loseRefundResponse=true;
  await feature.store.withActionLock(action,()=>vm.runInContext('managedCancellationRefundService.submit(rollbackPaidRecord.id)',feature.h.context));
  const pending = await feature.store.managedCancellation(id);
  assert.equal(pending.state,'submitted_unknown');
  assert.equal(feature.h.state.refunds.size,1);
  assert.equal(feature.h.state.refundRequests.length,1);

  const {h,store,request} = await startRollback(t,feature);
  h.advance(Math.max(60000,new Date(pending.next_attempt_at).getTime()-initialClock));
  await h.context.runReservationRefunds();
  const result = await store.managedCancellation(id);
  const after = await store.getForDisplay(id);
  assert.equal(result.state,'confirmed');
  assert.equal(Number(result.amount_cents),accepted.quote.totalCents);
  assert.equal(h.state.refundRequests.length,0);
  assert.equal(h.state.refunds.size,1);
  assert.equal(after.status,'cancelled');
  assert.deepEqual(after.quote,accepted.quote);
  assert.equal(after.bookingReference,accepted.bookingReference);
  assert.deepEqual(await store.capturedPayment(id),originalLedger);
  assert.equal((await request(manage+'/cancellation/preview',{},owner)).status,404);
  assert.equal((await request(manage+'/changes/preview',{passengers:3},owner)).status,404);
});

test('a stopped-trip change request does not present a direct-route fare preview',pg,async t=>{
  const {feature,owner,id,accepted} = await stoppedBooking(t);
  const {h,request} = await startRollback(t,feature,{RESERVATION_SELF_SERVICE_ENABLED:'true'});
  const result = await request(base+'/account/'+id+'/changes/preview',{passengers:3},owner);
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.preview.originalCents,accepted.quote.totalCents);
  assert.equal(result.body.preview.newCents,null);
  assert.equal(result.body.preview.pricingReview,'pricing_unavailable');
  assert.equal(h.state.googleCalls,0);
  assert.equal(h.state.creates.length,0);
});
