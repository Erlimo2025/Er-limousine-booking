'use strict';

// Selected-address fixtures use synthetic provider records and the existing
// isolated booking harness. No Google, Stripe, email, or database credentials.
const {create, cases, route} = require('./booking-browser.cjs');
const {place, providerRoute} = require('./booking-stops.cjs');

const airportId = 'ChIJ7wzsxeFSwokRhvLXxTe087M';
const definitions = {
  penn: {id:'synthetic_newark_penn_station', text:'Newark Penn Station, NJ', address:'1 Raymond Plaza West, Newark, NJ 07102, USA', state:'NJ', county:'Essex County', lat:40.7347, lng:-74.164},
  local: {id:'synthetic_selected_nj_destination', text:'50 Example Avenue, Jersey City, NJ', address:'50 Example Avenue, Jersey City, NJ 07302, USA', state:'NJ', county:'Hudson County', lat:40.72, lng:-74.04},
  ny: {id:'synthetic_selected_ny_location', text:'100 Example Street, Manhattan, NY', address:'100 Example Street, Manhattan, NY 10001, USA', state:'NY', county:'New York County', lat:40.75, lng:-73.985},
  ewr: {id:airportId, text:'Newark Liberty International Airport (EWR)', address:'3 Brewster Rd, Newark, NJ', state:'NJ', county:'Essex County', lat:40.6895, lng:-74.1745},
  stop: {id:'synthetic_selected_journey_stop', text:'30 Synthetic Street, Newark, NJ', address:'30 Synthetic Street, Newark, NJ 07102, USA', state:'NJ', county:'Essex County', lat:40.75, lng:-74.17}
};

function providerPlace(definition) {
  const value = place(definition);
  value.displayName = {text:definition === definitions.penn ? 'Newark Penn Station' : definition.text};
  if (definition === definitions.penn) value.types = ['train_station','transit_station','establishment'];
  if (definition === definitions.ewr) value.types = ['airport','international_airport'];
  value.primaryType = value.types[0];
  return value;
}

// Options: destination:'ewr' (default), 'ordinary' (NJ), or 'ny'; pickup:'ny';
// selectedPickup/selectedDropoff:false; ambiguousPickup/ambiguousDropoff:false;
// tollsEnabled:false; tripType:'hourly'; stops:true.
async function fixture(t, options = {}) {
  const pickup = options.pickup === 'ny' ? definitions.ny : definitions.penn;
  const dropoff = options.destination === 'ordinary' ? definitions.local : options.destination === 'ny' ? definitions.ny : definitions.ewr;
  const selectedCase = {
    ...cases.find(value => value.id === 'same_state'),
    id:'selected_booking_locations', pickup:pickup.text, dropoff:dropoff.text,
    sameState:pickup.state === dropoff.state,
    direction:pickup.state === 'NJ' ? 'ny_bound' : 'nj_bound',
    nycCounty:'New York County', disabled:options.tollsEnabled === false,
    tripType:options.tripType || 'oneway'
  };
  const {h, input} = await create(t, selectedCase);
  Object.assign(input, {date:'2026-12-10', returnDate:'2026-12-11', time:'12:00', promoCode:'', notes:'Synthetic selected-address regression'});
  delete input.pickupTerminal;
  delete input.dropoffTerminal;
  delete input.pickupPlaceId;
  delete input.dropoffPlaceId;
  if (options.selectedPickup !== false) input.pickupPlaceId = pickup.id;
  if (options.selectedDropoff !== false) {
    input.dropoffPlaceId = dropoff.id;
    if (dropoff === definitions.ewr) input.dropoffTerminal = 'general';
  }

  const places = {pickup:providerPlace(pickup), dropoff:providerPlace(dropoff), ewr:providerPlace(definitions.ewr), stop:providerPlace(definitions.stop)};
  h.state.detailsById = Object.fromEntries(Object.values(places).map(value => [value.id, value]));
  h.state.searchResults = {
    [input.pickup]:[places.pickup, ...(options.ambiguousPickup === false ? [] : [{...places.pickup,id:'synthetic_second_pickup_match'}])],
    [input.dropoff]:[places.dropoff, ...(options.ambiguousDropoff === false ? [] : [{...places.dropoff,id:'synthetic_second_dropoff_match'}])]
  };
  h.state.suggestionsByQuery = {
    [input.pickup]:[{id:pickup.id,address:input.pickup}],
    [input.dropoff]:[{id:dropoff.id,address:input.dropoff}]
  };
  h.state.selectedPlaceFailures = {};
  const searches = [], details = [];
  const originalFetch = h.context.fetch;
  h.context.fetch = async (url, request) => {
    if (String(url).includes('places:searchText')) {
      const body = JSON.parse(request.body);
      searches.push({textQuery:body.textQuery,maxResultCount:body.maxResultCount});
    } else if (String(url).includes('/v1/places/')) {
      const id = decodeURIComponent(String(url).split('/').at(-1));
      details.push({id,fieldMask:request.headers['X-Goog-FieldMask']});
      const failure = h.state.selectedPlaceFailures[id];
      if (failure?.network) throw Error('synthetic-private-selected-place-network-marker');
      if (failure?.timeout) throw Object.assign(Error('synthetic-private-selected-place-timeout-marker'),{name:'TimeoutError'});
      if (failure?.status) return {ok:false,status:failure.status,json:async()=>({error:{status:'UNAVAILABLE',message:'synthetic-private-provider-body-marker'}})};
    }
    return originalFetch(url, request);
  };
  if (options.stops) {
    input.stops = [{placeId:definitions.stop.id,address:definitions.stop.address,waitMinutes:5}];
    h.state.routeResult = request => providerRoute(request, 0);
  } else if (options.tripType === 'roundtrip' && pickup.state !== dropoff.state) {
    h.state.routeResult = request => route({...selectedCase,
      direction:request.origin.placeId === dropoff.id ? (selectedCase.direction === 'ny_bound' ? 'nj_bound' : 'ny_bound') : selectedCase.direction
    },2500);
  } else if (pickup.state === dropoff.state || pickup.state === 'NY' || options.tollsEnabled === false) {
    h.state.routeResult = request => {
      if (request.extraComputations) throw Error('Verified excluded route must not request tolls');
      return {distanceMeters:8500,duration:'900s'};
    };
  }
  return {h,input,places,searches,details};
}

module.exports = {fixture, definitions, airportId};
