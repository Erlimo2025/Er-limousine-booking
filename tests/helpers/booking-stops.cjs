'use strict';

const {harness, guestBooking} = require('./reservation-management.cjs');

const places = {
  pickup: {id:'fixture_origin', address:'20 Sample Avenue, Orange, NJ 07050, USA', state:'NJ', county:'Essex County', lat:40.764, lng:-74.236},
  first: {id:'fixture_stop_newark', address:'42 Example Street, Newark, NJ 07102, USA', state:'NJ', county:'Essex County', lat:40.735, lng:-74.176},
  second: {id:'fixture_stop_jersey', address:'8 Fictional Road, Jersey City, NJ 07302, USA', state:'NJ', county:'Hudson County', lat:40.720, lng:-74.042},
  third: {id:'fixture_stop_brooklyn', address:'15 Test Avenue, Brooklyn, NY 11201, USA', state:'NY', county:'Kings County', lat:40.690, lng:-73.991},
  destination: {id:'fixture_destination', address:'100 Test Avenue, Manhattan, NY 10001, USA', state:'NY', county:'New York County', lat:40.750, lng:-73.985},
  local: {id:'fixture_local', address:'101 Test Avenue, Montclair, NJ 07042, USA', state:'NJ', county:'Essex County', lat:40.825, lng:-74.219}
};

function place(definition) {
  return {
    id:definition.id, formattedAddress:definition.address, types:['street_address'], primaryType:'street_address',
    location:{latitude:definition.lat, longitude:definition.lng},
    addressComponents:[
      {types:['country'],shortText:'US'},
      {types:['administrative_area_level_1'],shortText:definition.state},
      {types:['administrative_area_level_2'],longText:definition.county},
      {types:['street_number'],longText:definition.address.split(' ')[0]},
      {types:['route'],longText:definition.address.split(',')[0]}
    ]
  };
}

function requested(key, waitMinutes = 5) {
  const selected = places[key];
  return {address:selected.address, placeId:selected.id, waitMinutes};
}

function providerRoute(request, amount = 2300) {
  const count = (request.intermediates || []).length + 1;
  const legs = Array.from({length:count}, (_, i) => ({distanceMeters:10000+i*2000, duration:String(600+i*120)+'s'}));
  const distanceMeters = legs.reduce((total,leg)=>total+leg.distanceMeters,0);
  const duration = legs.reduce((total,leg)=>total+Number(leg.duration.slice(0,-1)),0)+'s';
  return {distanceMeters,duration,staticDuration:duration,legs,
    travelAdvisory:{tollInfo:{estimatedPrice:[{currencyCode:'USD',units:String(Math.floor(amount/100)),nanos:amount%100*10000000}]}}};
}

function configure(h) {
  h.state.searchResults = Object.fromEntries(Object.values(places).map(value=>[value.address,[place(value)]]));
  h.state.searchResults.Manhattan = [place(places.destination)];
  h.state.detailsById = Object.fromEntries(Object.values(places).map(value=>[value.id,place(value)]));
  h.state.suggestionsByQuery = Object.fromEntries(Object.values(places).map(value=>[value.address,[value]]));
  h.state.suggestionsByQuery.Manhattan = [places.destination];
  h.state.routeResult = providerRoute;
  return h;
}

const trip = {...guestBooking, pickup:places.pickup.address, dropoff:places.destination.address, vehicle:'suv', passengers:2,
  stops:[requested('first')], promoCode:'', notes:'Synthetic stop booking'};
delete trip.pickupPlaceId;

async function fixture(t, overrides = {}) {
  return configure(await harness(t,{ROUTE_TOLLS_ENABLED:'true',ROUTE_TOLLS_MODE:'estimate',...overrides}));
}

module.exports={places,place,requested,providerRoute,configure,fixture,trip};