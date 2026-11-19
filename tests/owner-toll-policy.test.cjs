'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {harness, guestBooking, setup, cookie} = require('./helpers/reservation-management.cjs');
const {places, place, requested, fixture: stopFixture, providerRoute, trip: stopTrip} = require('./helpers/booking-stops.cjs');
const {create, cases} = require('./helpers/booking-browser.cjs');
const fare = require('../services/route-tolls');

const nj = {id:'policy_jersey',address:'80 Columbus Drive, Jersey City, NJ 07302',state:'NJ',county:'Hudson County',lat:40.72,lng:-74.04};
const woodbury = {id:'policy_outlets',address:'498 Red Apple Court, Central Valley, NY 10917',state:'NY',county:'Orange County',lat:41.32,lng:-74.13};
const albany = {id:'policy_albany',address:'10 Sample Avenue, Albany, NY 12207',state:'NY',county:'Albany County',lat:42.65,lng:-73.75};
const pa = {id:'policy_pa',address:'100 Sample Avenue, Philadelphia, PA 19107',state:'PA',county:'Philadelphia County',lat:39.95,lng:-75.16};
const trenton = {id:'policy_trenton',address:'200 Sample Avenue, Trenton, NJ 08608',state:'NJ',county:'Mercer County',lat:40.22,lng:-74.77};
const boroughs = [
  ['Manhattan','New York County'],['Brooklyn','Kings County'],['Queens','Queens County'],
  ['Bronx','Bronx County'],['Staten Island','Richmond County']
].map(([name,county], index)=>({
  id:'policy_borough_'+index,address:'10 Sample Avenue, '+name+', NY',state:'NY',county,lat:40.72+index/100,lng:-73.98
}));
const enabled = {ROUTE_TOLLS_ENABLED:'true',ROUTE_TOLLS_MODE:'estimate'};
const amountCents = 1865;
const selectedRoute = {distanceMeters:59000,duration:'3000s',travelAdvisory:{tollInfo:{
  estimatedPrice:[{currencyCode:'USD',units:'18',nanos:650000000}]
}}};
const withoutTollAdvisory = {distanceMeters:59000,duration:'3000s'};

function configure(h, from, to) {
  h.state.searchResults = {[from.address]:[place(from)],[to.address]:[place(to)]};
  h.state.routeResult = request=>request.extraComputations ? selectedRoute : withoutTollAdvisory;
  const trip = {...guestBooking,pickup:from.address,dropoff:to.address,promoCode:'',vehicle:'suv'};
  delete trip.pickupPlaceId;
  return trip;
}

function requestFor(h, index, from, to, chargeable) {
  const request = h.state.routes[index];
  assert.deepEqual(request.origin,{placeId:from.id});
  assert.deepEqual(request.destination,{placeId:to.id});
  assert.deepEqual(request.extraComputations,chargeable?['TOLLS']:undefined);
  assert.deepEqual(request.routeModifiers?.tollPasses,chargeable?['US_NJ_EZPASSNJ']:undefined);
  assert.equal(h.state.routeHeaders[index]['X-Goog-FieldMask'].includes('travelAdvisory.tollInfo'),chargeable);
}

async function quoteFor(h, trip, tollsCents, auth) {
  const result = await h.request('/api/quote',trip,auth);
  assert.equal(result.status,200,JSON.stringify(result.body));
  const quote = result.body;
  assert.equal(quote.pricingBreakdown.tollsCents,tollsCents);
  assert.equal(quote.totalCents,Math.round(quote.discountedFare*100)+Math.round(quote.gratuity*100)+tollsCents);
  return quote;
}

async function bookAndPay(h, trip, quote, paymentChoice) {
  const result = await h.request('/api/checkout',{...trip,paymentChoice,quoteRevision:quote.quoteRevision});
  assert.equal(result.status,200,JSON.stringify(result.body));
  const [record] = h.records();
  assert.equal(record.quote.totalCents,quote.totalCents);
  assert.ok(fare.validQuote(record.quote));
  assert.equal(h.state.creates.length,paymentChoice==='now'?1:0);
  const routes = h.state.routes.length;
  h.state.routeResult = ()=>{throw Error('Saved fare must not use a new Route estimate');};
  const access = result.headers.getSetCookie().find(value=>value.startsWith('er_booking_access_')).split(';')[0];
  const paid = await h.request('/api/booking/'+record.id+'/checkout',{},{
    origin:'http://localhost:3000','sec-fetch-site':'same-origin',cookie:access
  });
  assert.equal(paid.status,200,JSON.stringify(paid.body));
  assert.equal(h.state.routes.length,routes);
  assert.equal(h.state.creates.length,1);
  assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,quote.totalCents);
  assert.deepEqual(h.records()[0].quote,record.quote);
  return record.quote;
}

for (const to of boroughs) {
  for (const [vehicle,paymentChoice] of [['suv','now'],['escalade','later']]) {
    test('NJ to '+to.county+' uses one validated amount for '+vehicle+' '+paymentChoice,async t=>{
      const h = await harness(t,enabled);
      const trip = {...configure(h,nj,to),vehicle};
      const quote = await quoteFor(h,trip,amountCents);
      requestFor(h,0,nj,to,true);
      const saved = await bookAndPay(h,trip,quote,paymentChoice);
      assert.equal(saved.tolls.legs.length,1);
      assert.equal(saved.tolls.legs[0].googleRouteCents,amountCents);
    });
  }
}

for (const [label,from,to] of [
  ['NYC to NJ',boroughs[0],nj],['Woodbury to Jersey City',woodbury,nj],['Jersey City to Woodbury',nj,woodbury],
  ['Pennsylvania to NJ',pa,nj],['NJ to Pennsylvania',nj,pa],['upstate NY to NJ',albany,nj],
  ['NJ to NJ',nj,trenton],['NY to NY',boroughs[1],boroughs[2]],['Pennsylvania to NYC',pa,boroughs[0]]
]) {
  test(label+' has zero customer tolls even without a usable toll response',async t=>{
    const h = await harness(t,enabled);
    const trip = configure(h,from,to);
    // Toll-only provider error, if called. The ordinary route is still valid.
    h.state.routeResult = request=>{
      if(request.extraComputations)throw Error('Toll provider unavailable');
      return {...withoutTollAdvisory,travelAdvisory:{tollInfo:{}}};
    };
    const quote = await quoteFor(h,trip,0);
    requestFor(h,0,from,to,false);
    const saved = await bookAndPay(h,trip,quote,from.state==='NY'?'later':'now');
    const sameState = from.state===to.state;
    assert.equal(saved.tolls.reason,sameState?'same_state':undefined);
    assert.equal(saved.tolls.status,sameState?'waived':'none');
    assert.equal(saved.tolls.estimatedRouteCents,sameState?null:0);
    assert.equal(saved.tolls.format,undefined);
    assert.ok(h.state.routes.every(request=>request.extraComputations===undefined));
  });
}

for (const [from,to,tolled] of [[nj,boroughs[0],0],[boroughs[0],nj,1],[nj,woodbury,-1]]) {
  test('round trip '+from.state+' to '+to.county+' prices only its NJ-to-NYC direction',async t=>{
    const h = await harness(t,enabled);
    const trip = {...configure(h,from,to),tripType:'roundtrip',returnDate:'2026-11-12',returnTime:'18:00'};
    const quote = await quoteFor(h,trip,tolled<0?0:amountCents);
    requestFor(h,0,from,to,tolled===0);
    requestFor(h,1,to,from,tolled===1);
    const saved = await bookAndPay(h,trip,quote,'now');
    assert.ok(saved.roundTrip.outbound && saved.roundTrip.return);
    assert.equal(saved.tolls.legs.length,tolled<0?2:1);
    if(tolled>=0)assert.equal(saved.tolls.eligibility.pickupState,'NJ');
  });
}

test('ordinary toll-priced trips keep the FIRST15 discount on the fare and exclude tolls from its base',async t=>{
  const h = await harness(t,enabled);
  const trip = {...configure(h,nj,boroughs[0]),promoCode:'FIRST15'};
  const quote = await quoteFor(h,trip,amountCents);
  assert.equal(quote.promotion.code,'FIRST15');
  assert.equal(quote.discount,Math.round(quote.baseTotal*15)/100);
  await bookAndPay(h,trip,quote,'now');
});

test('the EWR special remains $150, includes tolls and excludes FIRST15 and Escalade',async t=>{
  const f = await create(t,cases.find(value=>value.id==='ewr_special'));
  const trip = {...f.input,vehicle:'suv',promoCode:'FIRST15',offerCode:'EWR_MANHATTAN_SUV'};
  const result = await f.h.request('/api/quote',trip);
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.totalCents,15000);
  assert.equal(result.body.pricingBreakdown.tollsIncluded,true);
  assert.equal(result.body.promotion,null);
  assert.equal((await f.h.request('/api/quote',{...trip,vehicle:'escalade'})).status,400);
  const accepted = await f.h.request('/api/checkout',{...trip,paymentChoice:'now',quoteRevision:result.body.quoteRevision});
  assert.equal(accepted.status,200,JSON.stringify(accepted.body));
  assert.equal(f.h.state.creates[0].params.line_items[0].price_data.unit_amount,15000);
});

test('a stop across the border does not make an excluded endpoint pair chargeable',async t=>{
  const h = await stopFixture(t);
  const trip = {...stopTrip,dropoff:places.local.address,stops:[requested('third',10)]};
  h.state.routeResult = request=>{
    const result = providerRoute(request);
    delete result.travelAdvisory;
    return result;
  };
  const quote = await quoteFor(h,trip,0);
  requestFor(h,0,places.pickup,places.local,false);
  assert.deepEqual(h.state.routes[0].intermediates,[{placeId:places.third.id}]);
  assert.equal(quote.stopSummary.chargeCents,750);
  await bookAndPay(h,trip,quote,'later');
});

for (const [label,alter,addressFailure] of [
  ['missing county',list=>list[0].addressComponents.splice(2,1)],
  ['ambiguous county',list=>list[0].addressComponents.push({types:['administrative_area_level_2'],longText:'Orange County'})],
  ['unknown county',list=>{list[0].addressComponents[2].longText='Unverified County';}],
  ['unverified state',list=>{list[0].addressComponents[1].shortText='invalid';},true],
  ['ambiguous resolution',list=>list.push({...list[0],id:'policy_other_result'}),true]
]) {
  test(label+' cannot authorize a charge or waiver',async t=>{
    const h = await harness(t,enabled);
    const trip = configure(h,nj,boroughs[0]);
    alter(h.state.searchResults[trip.dropoff]);
    const response = await h.request('/api/quote',{...trip,dropoffCounty:'New York County',dropoffState:'PA'});
    assert.equal(response.status,addressFailure?400:422);
    assert.equal(response.body.code,addressFailure?'ADDRESS_VERIFICATION_FAILED':'TOLL_ESTIMATE_UNAVAILABLE');
    if(addressFailure)assert.equal(response.body.field,'dropoff');
    assert.equal(response.body.checkoutAllowed,false);
    assert.equal(h.state.routes.length,0);
  });
}

for (const routeFailure of [false,true]) {
  test('eligible trip still requires review on '+(routeFailure?'routing failure':'missing toll price'),async t=>{
    const h = await harness(t,enabled);
    const trip = configure(h,nj,boroughs[0]);
    h.state.routeResult = ()=>{
      if(routeFailure)throw Error('Routes unavailable');
      return {...withoutTollAdvisory,travelAdvisory:{tollInfo:{}}};
    };
    for(const result of [await h.request('/api/quote',trip),await h.request('/api/checkout',{...trip,paymentChoice:'now'})]){
      assert.equal(result.status,422);
      assert.equal(result.body.code,'TOLL_ESTIMATE_UNAVAILABLE');
    }
    assert.equal(h.records().length,0);
    assert.equal(h.state.creates.length,0);
  });
}

test('an excluded route still requires a usable ordinary driving route',async t=>{
  const h = await harness(t,enabled);
  const trip = configure(h,woodbury,nj);
  h.state.routeResult = ()=>{throw Error('Ordinary Routes outage');};
  const response = await h.request('/api/quote',trip);
  assert.notEqual(response.status,200);
  assert.notEqual(response.body.code,'TOLL_ESTIMATE_UNAVAILABLE');
  requestFor(h,0,woodbury,nj,false);
  assert.equal(h.records().length,0);
});

test('strict mode can waive an excluded route without a reviewed tariff profile',async t=>{
  const h = await harness(t,{...enabled,ROUTE_TOLLS_MODE:'verified'});
  const trip = configure(h,nj,woodbury);
  const quote = await quoteFor(h,trip,0);
  requestFor(h,0,nj,woodbury,false);
  await bookAndPay(h,trip,quote,'later');
});

test('isolated PostgreSQL retains an excluded interstate fare and its accepted Stripe amount',
 {skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
  const f = await setup(t,enabled);
  const trip = configure(f.h,woodbury,nj);
  const quote = await quoteFor(f.h,trip,0);
  const result = await f.post('/api/checkout',{...trip,paymentChoice:'later',quoteRevision:quote.quoteRevision});
  assert.equal(result.status,200,JSON.stringify(result.body));
  const saved = await f.store.get(result.body.bookingId);
  assert.equal(saved.quote.tolls.status,'none');
  assert.equal(saved.quote.tolls.reason,undefined);
  assert.equal(saved.quote.tolls.format,undefined);
  assert.equal(saved.quote.tolls.estimatedRouteCents,0);
  assert.equal(saved.quote.totalCents,quote.totalCents);
  const routes = f.h.state.routes.length;
  const access = cookie(result,result.headers.getSetCookie().find(value=>value.startsWith('er_booking_access_')).split('=')[0]);
  const paid = await f.post('/api/booking/'+saved.id+'/checkout',{},access);
  assert.equal(paid.status,200,JSON.stringify(paid.body));
  assert.equal(f.h.state.routes.length,routes);
  assert.equal(f.h.state.creates[0].params.line_items[0].price_data.unit_amount,quote.totalCents);
  assert.deepEqual((await f.store.get(saved.id)).quote,saved.quote);
});
