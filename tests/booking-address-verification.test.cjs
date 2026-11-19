'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, definitions, airportId} = require('./helpers/selected-booking-locations.cjs');

const quote = (h,input) => h.request('/api/quote',input);
const assertOK = result => assert.equal(result.status,200,JSON.stringify(result.body));
function rejected(result, field, unavailable = false) {
  assert.equal(result.status, unavailable ? 503 : 400, JSON.stringify(result.body));
  assert.equal(result.body.code, unavailable ? 'ADDRESS_LOOKUP_UNAVAILABLE' : 'ADDRESS_VERIFICATION_FAILED');
  assert.equal(result.body.field,field);
  assert.equal(result.body.checkoutAllowed,false);
  assert.equal(result.body.tolls,undefined);
  assert.doesNotMatch(result.body.error,/Toll estimate unavailable|synthetic-private|places\.googleapis|mock-google-key/);
  const selectionGuidance = field === 'dropoff' ? /drop[- ]?off location.*address suggestions/i : /pickup location.*address suggestions/i;
  assert.match(result.body.error,unavailable ? /try again|retry/i : selectionGuidance);
}
function noWrites(h) {
  assert.equal(h.records().length,0);
  assert.equal(h.state.creates.length,0);
}

test('selected Newark Penn Station resolves by its ID despite two text matches and retains zero EWR tolls',async t=>{
  const {h,input,places,searches,details}=await fixture(t);
  const result=await quote(h,input);assertOK(result);
  assert.equal(h.state.searchResults[input.pickup].length,2);
  assert.deepEqual(searches,[]);
  assert.ok(details.some(value=>value.id===places.pickup.id));
  assert.ok(details.some(value=>value.id===airportId));
  assert.equal(result.body.verifiedAddresses.pickup,'Newark Penn Station, '+places.pickup.formattedAddress);
  assert.ok(details.find(value=>value.id===places.pickup.id).fieldMask.split(',').includes('displayName'));
  assert.equal(result.body.verifiedAddresses.dropoff,undefined,'existing EWR display semantics preserved');
  assert.equal(result.body.tolls.status,'waived');
  assert.equal(result.body.tolls.amountCents,0);
  assert.equal(result.body.pricingBreakdown.tollsCents,0);
  assert.equal(result.body.pricingBreakdown.interstate,false);
  assert.deepEqual(h.state.routes[0].origin,{placeId:places.pickup.id});
  assert.deepEqual(h.state.routes[0].destination,{placeId:airportId});
  assert.equal(h.state.routes[0].extraComputations,undefined);
  noWrites(h);
});

test('ordinary drop-off selection uses verified NJ identity and canonical address without another text search',async t=>{
  const {h,input,places,searches,details}=await fixture(t,{destination:'ordinary'});
  const result=await quote(h,input);assertOK(result);
  assert.deepEqual(searches,[]);
  assert.ok(details.some(value=>value.id===places.dropoff.id));
  assert.equal(result.body.verifiedAddresses.dropoff,places.dropoff.formattedAddress);
  assert.deepEqual(h.state.routes[0].destination,{placeId:places.dropoff.id});
  assert.equal(result.body.pricingBreakdown.tollsCents,0);noWrites(h);
});

for(const [description,change,expected]of [
  ['missing name',place=>{delete place.displayName;},address=>address],
  ['blank name',place=>{place.displayName={text:'   '};},address=>address],
  ['name already in address',place=>{place.formattedAddress='Newark Penn Station, '+place.formattedAddress;},address=>address],
  ['case and punctuation differences',place=>{place.formattedAddress='NEWARK   PENN-STATION, '+place.formattedAddress;},address=>address],
  ['name equal to address',place=>{place.displayName={text:place.formattedAddress};},address=>address],
  ['name is not a complete word in address',place=>{place.displayName={text:'Park'};place.formattedAddress='1 Parkway, Newark, NJ 07102, USA';},address=>'Park, '+address]
])test('summary and saved reservation preserve the verified location: '+description,async t=>{
  const {h,input,places}=await fixture(t);
  change(places.pickup);
  const display=expected(places.pickup.formattedAddress);
  const reviewed=await quote(h,input);assertOK(reviewed);
  assert.equal(reviewed.body.verifiedAddresses.pickup,display);
  assert.deepEqual(h.state.routes[0].origin,{placeId:places.pickup.id});
  assert.equal(reviewed.body.pricingBreakdown.tollsCents,0);
  const saved=await h.request('/api/checkout',{...input,paymentChoice:'later',quoteRevision:reviewed.body.quoteRevision});assertOK(saved);
  assert.equal(h.records()[0].trip.pickup,display);
  assert.equal(h.records()[0].trip.pickupPlaceId,places.pickup.id);
  assert.equal(h.records()[0].quote.totalCents,reviewed.body.totalCents);assert.equal(h.state.creates.length,0);
});

test('ordinary drop-off name is preserved in both the summary and saved reservation',async t=>{
  const {h,input,places}=await fixture(t,{destination:'ordinary'});
  places.dropoff.displayName={text:'Jersey City Hotel'};
  const display='Jersey City Hotel, '+places.dropoff.formattedAddress;
  const reviewed=await quote(h,input);assertOK(reviewed);
  assert.equal(reviewed.body.verifiedAddresses.dropoff,display);
  assert.deepEqual(h.state.routes[0].destination,{placeId:places.dropoff.id});
  const saved=await h.request('/api/checkout',{...input,paymentChoice:'later',quoteRevision:reviewed.body.quoteRevision});assertOK(saved);
  assert.equal(h.records()[0].trip.dropoff,display);assert.equal(h.state.creates.length,0);
});

test('only the Google-verified place name is used instead of the client display label',async t=>{
  const {h,input,places}=await fixture(t);
  input.pickup='Unverified client station label';
  const display='Newark Penn Station, '+places.pickup.formattedAddress;
  const reviewed=await quote(h,input);assertOK(reviewed);
  assert.equal(reviewed.body.verifiedAddresses.pickup,display);
  const saved=await h.request('/api/checkout',{...input,paymentChoice:'later',quoteRevision:reviewed.body.quoteRevision});assertOK(saved);
  assert.equal(h.records()[0].trip.pickup,display);assert.equal(h.state.creates.length,0);
});

test('selected place names also survive stopped-trip summaries and saved endpoints',async t=>{
  const {h,input,places}=await fixture(t,{destination:'ordinary',stops:true});
  places.dropoff.displayName={text:'Jersey City Hotel'};
  const pickup='Newark Penn Station, '+places.pickup.formattedAddress;
  const dropoff='Jersey City Hotel, '+places.dropoff.formattedAddress;
  const reviewed=await quote(h,input);assertOK(reviewed);
  assert.equal(reviewed.body.stopSummary.pickup,pickup);assert.equal(reviewed.body.stopSummary.dropoff,dropoff);
  assert.deepEqual(h.state.routes[0].origin,{placeId:places.pickup.id});assert.deepEqual(h.state.routes[0].destination,{placeId:places.dropoff.id});
  assert.equal(reviewed.body.pricingBreakdown.tollsCents,0);
  const saved=await h.request('/api/checkout',{...input,paymentChoice:'later',quoteRevision:reviewed.body.quoteRevision});assertOK(saved);
  const record=h.records()[0];
  assert.equal(record.trip.pickup,pickup);assert.equal(record.trip.dropoff,dropoff);
  assert.equal(record.quote.stopPlan.origin.address,pickup);assert.equal(record.quote.stopPlan.destination.address,dropoff);
  assert.equal(record.quote.totalCents,reviewed.body.totalCents);assert.equal(h.state.creates.length,0);
});

for(const field of ['pickup','dropoff'])for(const length of [200,201])test(`a ${length}-character ${field} label preserves the full verified street address`,async t=>{
  const {h,input,places}=await fixture(t,{destination:'ordinary'}),place=places[field];
  place.displayName={text:'N'.repeat(length-place.formattedAddress.length-2)};
  const combined=place.displayName.text+', '+place.formattedAddress;
  assert.equal(combined.length,length);
  const expected=length>200?place.formattedAddress:combined;
  const reviewed=await quote(h,input);assertOK(reviewed);
  assert.equal(reviewed.body.verifiedAddresses[field],expected);
  assert.equal(reviewed.body.pricingBreakdown.tollsCents,0);
  const saved=await h.request('/api/checkout',{...input,paymentChoice:'later',quoteRevision:reviewed.body.quoteRevision});assertOK(saved);
  const record=h.records()[0];
  assert.equal(record.trip[field],expected);assert.equal(record.trip[field+'PlaceId'],place.id);
  assert.equal(record.quote.totalCents,reviewed.body.totalCents);
  assert.ok(h.state.routes.every(route=>route[field==='pickup'?'origin':'destination'].placeId===place.id));
  assert.equal(h.state.creates.length,0);
});

test('an oversized place name uses the full verified address in stopped-trip summaries and saved reservations',async t=>{
  const {h,input,places}=await fixture(t,{destination:'ordinary',stops:true});
  places.pickup.displayName={text:'N'.repeat(180)};
  const expected=places.pickup.formattedAddress;
  const reviewed=await quote(h,input);assertOK(reviewed);
  assert.equal(reviewed.body.stopSummary.pickup,expected);
  assert.equal(reviewed.body.verifiedAddresses.pickup,expected);
  assert.equal(reviewed.body.pricingBreakdown.tollsCents,0);
  const saved=await h.request('/api/checkout',{...input,paymentChoice:'later',quoteRevision:reviewed.body.quoteRevision});assertOK(saved);
  const record=h.records()[0];
  assert.equal(record.trip.pickup,expected);assert.equal(record.quote.stopPlan.origin.address,expected);
  assert.equal(record.quote.totalCents,reviewed.body.totalCents);
  assert.ok(h.state.routes.every(route=>route.origin.placeId===places.pickup.id));
  assert.equal(h.state.creates.length,0);
});

test('selected NY drop-off remains NY and preserves NJ-to-NYC toll calculations',async t=>{
  const {h,input,places,searches}=await fixture(t,{destination:'ny'});
  const result=await quote(h,input);assertOK(result);
  assert.deepEqual(searches,[]);
  assert.equal(result.body.pricingBreakdown.interstate,true);
  assert.equal(result.body.pricingBreakdown.tollsCents,2500);
  assert.deepEqual(h.state.routes[0].destination,{placeId:places.dropoff.id});
  assert.deepEqual(h.state.routes[0].extraComputations,['TOLLS']);noWrites(h);
});

test('selected NY pickup is not mistaken for an EWR NJ proof',async t=>{
  const {h,input,places}=await fixture(t,{pickup:'ny',destination:'ordinary'});
  const result=await quote(h,input);assertOK(result);
  assert.equal(result.body.pricingBreakdown.interstate,true);
  assert.equal(result.body.tolls.status,'none');
  assert.equal(result.body.pricingBreakdown.tollsCents,0);
  assert.deepEqual(h.state.routes[0].origin,{placeId:places.pickup.id});noWrites(h);
});

test('typed pickup without a selected ID retains strict text verification',async t=>{
  const {h,input,places,searches,details}=await fixture(t,{selectedPickup:false,ambiguousPickup:false});
  const result=await quote(h,input);assertOK(result);
  assert.deepEqual(searches,[{textQuery:input.pickup,maxResultCount:3}]);
  assert.ok(!details.some(value=>value.id===places.pickup.id));
  assert.deepEqual(h.state.routes[0].origin,{placeId:places.pickup.id});noWrites(h);
});

test('ambiguous typed pickup receives pickup guidance instead of an unavailable-toll message',async t=>{
  const {h,input}=await fixture(t,{selectedPickup:false});
  rejected(await quote(h,input),'pickup');noWrites(h);
});

test('edited pickup without the discarded ID resolves and routes the newly typed address',async t=>{
  const {h,input,places,searches,details}=await fixture(t);
  const edited='200 Edited Example Road, Newark, NJ';
  const newPlace={...structuredClone(places.pickup),id:'synthetic_edited_pickup',formattedAddress:edited};
  input.pickup=edited;delete input.pickupPlaceId;
  h.state.searchResults[edited]=[newPlace];
  const result=await quote(h,input);assertOK(result);
  assert.deepEqual(searches,[{textQuery:edited,maxResultCount:3}]);
  assert.ok(!details.some(value=>value.id===places.pickup.id));
  assert.deepEqual(h.state.routes[0].origin,{placeId:newPlace.id});noWrites(h);
});

test('selected endpoints drive routing when toll pricing is disabled',async t=>{
  const {h,input,places,searches}=await fixture(t,{destination:'ordinary',tollsEnabled:false});
  const result=await quote(h,input);assertOK(result);
  assert.deepEqual(searches,[]);assert.equal(result.body.tolls,undefined);
  assert.deepEqual(h.state.routes[0].origin,{placeId:places.pickup.id});
  assert.deepEqual(h.state.routes[0].destination,{placeId:places.dropoff.id});noWrites(h);
});

test('selected endpoints remain authoritative for a journey with an intermediate stop',async t=>{
  const {h,input,places,searches}=await fixture(t,{destination:'ordinary',stops:true});
  const result=await quote(h,input);assertOK(result);
  assert.deepEqual(searches,[]);
  assert.deepEqual(h.state.routes[0].origin,{placeId:places.pickup.id});
  assert.deepEqual(h.state.routes[0].destination,{placeId:places.dropoff.id});
  assert.deepEqual(h.state.routes[0].intermediates,[{placeId:places.stop.id}]);noWrites(h);
});

test('hourly selection is verified without inventing route tolls',async t=>{
  const {h,input,details,places}=await fixture(t,{destination:'ordinary',tripType:'hourly'});
  const result=await quote(h,input);assertOK(result);
  assert.ok(details.some(value=>value.id===places.pickup.id));
  assert.equal(h.state.routes.length,0);assert.equal(result.body.tolls,undefined);noWrites(h);
});

for(const field of ['pickup','dropoff'])for(const invalid of ['bad/id',7,'x'.repeat(256)])test(field+' malformed selected ID is rejected without text-search fallback: '+typeof invalid+' '+String(invalid).slice(0,8),async t=>{
  const {h,input,searches}=await fixture(t,{destination:'ordinary'});
  input[field+'PlaceId']=invalid;
  rejected(await quote(h,input),field);assert.deepEqual(searches,[]);noWrites(h);
});

for(const [name,mutate]of [
 ['returned ID mismatch',place=>{place.id='synthetic_different_identity';}],
 ['missing state',place=>{place.addressComponents=place.addressComponents.filter(x=>!x.types.includes('administrative_area_level_1'));}],
 ['duplicate state',place=>{place.addressComponents.push({types:['administrative_area_level_1'],shortText:'NJ'});}],
 ['non-US country',place=>{place.addressComponents.find(x=>x.types.includes('country')).shortText='CA';}],
 ['invalid coordinates',place=>{place.location.latitude=91;}],
 ['missing address',place=>{delete place.formattedAddress;}]
])test('selected pickup rejects '+name,async t=>{
  const {h,input,places,searches}=await fixture(t);mutate(places.pickup);
  rejected(await quote(h,input),'pickup');assert.deepEqual(searches,[]);noWrites(h);
});

for(const status of [400,404,429,500,503])test('selected-place HTTP '+status+' has safe field-specific '+(status<429?'selection':'retry')+' guidance',async t=>{
  const {h,input,places}=await fixture(t,{destination:'ordinary'});
  h.state.selectedPlaceFailures[places.dropoff.id]={status};
  rejected(await quote(h,input),'dropoff',status>=429);
  assert.ok(!JSON.stringify(h.state.logs).includes('synthetic-private-provider-body-marker'));noWrites(h);
});

for(const failure of ['network','timeout'])test('selected-place '+failure+' is retryable without provider or credential disclosure',async t=>{
  const {h,input,places}=await fixture(t);
  h.state.selectedPlaceFailures[places.pickup.id]={[failure]:true};
  rejected(await quote(h,input),'pickup',true);
  assert.doesNotMatch(JSON.stringify(h.state.logs),/synthetic-private-selected-place|mock-google-key/);noWrites(h);
});

test('accepted ordinary addresses remain canonical and frozen Checkout reuse does not need another address lookup',async t=>{
  const {h,input,places,details,searches}=await fixture(t,{destination:'ordinary'});
  const reviewed=await quote(h,input);assertOK(reviewed);
  const first=await h.request('/api/checkout',{...input,paymentChoice:'now',quoteRevision:reviewed.body.quoteRevision});assertOK(first);
  const before=h.records()[0],parameters=structuredClone(before.checkoutAttempt.parameters),key=before.checkoutAttempt.key;
  assert.equal(before.trip.pickup,'Newark Penn Station, '+places.pickup.formattedAddress);assert.equal(before.trip.dropoff,places.dropoff.formattedAddress);
  assert.equal(before.trip.pickupPlaceId,places.pickup.id);assert.equal(before.trip.dropoffPlaceId,places.dropoff.id);
  assert.doesNotMatch(JSON.stringify(before.trip),/undefined,/);
  const detailCount=details.length,searchCount=searches.length;
  h.state.selectedPlaceFailures[places.pickup.id]={network:true};h.state.selectedPlaceFailures[places.dropoff.id]={network:true};
  const retry=await h.request('/api/checkout',{...input,paymentChoice:'now',quoteRevision:reviewed.body.quoteRevision});assertOK(retry);
  assert.equal(retry.body.bookingId,first.body.bookingId);assert.equal(h.records().length,1);assert.equal(h.state.creates.length,1);
  assert.equal(details.length,detailCount);assert.equal(searches.length,searchCount);
  assert.deepEqual(h.records()[0].checkoutAttempt.parameters,parameters);assert.equal(h.records()[0].checkoutAttempt.key,key);
});

for(const [pickup,destination,tolledIndex]of [['nj','ny',0],['ny','ordinary',1]])test('selected round-trip identities remain consistent in '+pickup+' return direction',async t=>{
  const {h,input,places,searches}=await fixture(t,{pickup,destination,tripType:'roundtrip'});
  const result=await quote(h,input);assertOK(result);
  assert.deepEqual(searches,[]);assert.equal(h.state.routes.length,2);
  assert.deepEqual(h.state.routes[0].origin,{placeId:places.pickup.id});
  assert.deepEqual(h.state.routes[0].destination,{placeId:places.dropoff.id});
  assert.deepEqual(h.state.routes[1].origin,{placeId:places.dropoff.id});
  assert.deepEqual(h.state.routes[1].destination,{placeId:places.pickup.id});
  assert.deepEqual(h.state.routes[tolledIndex].extraComputations,['TOLLS']);
  assert.equal(h.state.routes[1-tolledIndex].extraComputations,undefined);
  assert.equal(result.body.pricingBreakdown.tollsCents,2500);noWrites(h);
});

for(const county of ['Hudson County','Queens County'])test('selected '+county+' drop-off cannot obtain the Manhattan special through forged display text',async t=>{
  const {h,input,places,searches}=await fixture(t,{destination:county==='Hudson County'?'ordinary':'ny'});
  if(county==='Queens County')places.dropoff.addressComponents.find(value=>value.types.includes('administrative_area_level_2')).longText=county;
  Object.assign(input,{pickup:'EWR',pickupPlaceId:airportId,pickupTerminal:'general',dropoff:'Manhattan',offerCode:'EWR_MANHATTAN_SUV',promoCode:'FIRST15'});
  const result=await quote(h,input);
  assert.equal(result.status,400,JSON.stringify(result.body));
  assert.match(result.body.error,/available only for trips to Manhattan/);
  assert.equal(result.body.fixedOffer,undefined);assert.deepEqual(searches,[]);noWrites(h);
});

test('selected verified Manhattan drop-off preserves the $150 special and FIRST15 exclusion',async t=>{
  const {h,input,places,searches}=await fixture(t,{destination:'ny'});
  Object.assign(input,{pickup:'EWR',pickupPlaceId:airportId,pickupTerminal:'general',dropoff:'Manhattan',offerCode:'EWR_MANHATTAN_SUV',promoCode:'FIRST15'});
  const result=await quote(h,input);assertOK(result);
  assert.equal(result.body.fixedOffer.code,'EWR_MANHATTAN_SUV');assert.equal(result.body.totalCents,15000);assert.equal(result.body.discount,0);
  assert.deepEqual(h.state.routes[0].origin,{placeId:airportId});assert.deepEqual(h.state.routes[0].destination,{placeId:places.dropoff.id});
  assert.deepEqual(searches,[]);noWrites(h);
});

test('changing a selected identity cannot reuse an approval for the old route even when its text and fare match',async t=>{
  const {h,input,places}=await fixture(t,{destination:'ordinary'});
  const reviewed=await h.requestRaw('/api/quote',input);assertOK(reviewed);
  const credential=reviewed.headers.getSetCookie().find(value=>value.startsWith('er_quote_browser=')).split(';')[0];
  const alternateId='synthetic_other_selected_destination';
  h.state.detailsById[alternateId]={...structuredClone(places.dropoff),id:alternateId};
  const result=await h.requestRaw('/api/checkout',{...input,dropoffPlaceId:alternateId,paymentChoice:'now',quoteApproval:reviewed.body.quoteApproval,quoteRevision:reviewed.body.quoteRevision},{cookie:credential});
  assert.equal(result.status,409,JSON.stringify(result.body));assert.equal(result.body.code,'QUOTE_CHANGED');assert.equal(result.body.reason,'route');noWrites(h);
});
