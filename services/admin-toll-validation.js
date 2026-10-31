const crypto = require('node:crypto');
const {routeTolls, verifiedState} = require('./route-tolls');

const messages = {
  disabled: [404, 'Toll validation is disabled.'],
  input: [400, 'Enter valid US locations, a vehicle fuel type and future New York departure times.'],
  location: [422, 'Use a more specific, unambiguous US address for each location.'],
  unauthorized: [401, 'Unauthorized'],
  busy: [409, 'An estimate is already running. Wait before starting another.'],
  conflict: [409, 'Start a new estimate after changing the route or assumptions.'],
  unavailable: [503, 'Toll validation is temporarily unavailable.'],
  provider: [502, 'Google route validation is temporarily unavailable. Start a new estimate to try again.']
};
class TollValidationError extends Error {
  constructor(code) { super(messages[code][1]); this.status = messages[code][0]; this.code = code; }
}
const fail = code => { throw new TollValidationError(code); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f<>]/.test(value);
const fleet = Object.freeze({vehicle: 'suburban_2025', label: '2025 Chevrolet Suburban', account: 'NJ E-ZPass Business',
  vehicleClass: '2Ax', plateCategory: 'NJ OL', tlcLicensed: false, commercialRatesVerified: false, congestionCoverageVerified: false});
const warnings = Object.freeze([
  'Estimate only. Customer toll charging is disabled for this tool; no fare or reservation is changed.',
  'Google prices are non-commercial estimates. Business account, 2Ax and NJ OL metadata do not establish commercial-rate accuracy.',
  'This Suburban is not TLC licensed. No TLC per-trip congestion pricing is assumed.',
  'Manhattan congestion coverage, previous daily entries and crossing-credit eligibility are unverified. A route total does not reveal all included components.',
  'Under the standard passenger regime, the first entry sets the CRZ toll for that vehicle and New York calendar day. Repeat entries or return legs do not automatically add another daily charge.',
  'Crossing credits depend on eligible peak-period travel and can be missing or delayed. No overnight crossing credit is assumed.',
  'Credits can post later than debits. Compare settled, matching transactions; pending or missing credits make the comparison provisional.',
  'Mid-Tier charges after tag-read or plate-matching issues can differ from a normal pass estimate.',
  'Do not add tunnel, road or congestion charges to Google\u2019s original total, or subtract credits from it a second time.',
  'A requested via point does not independently confirm a tunnel crossing. Inspect the Google-returned route instructions.',
  'Same-state customer toll additions remain waived. The eligible EWR to Manhattan special remains $150 including tolls.'
]);

// This service has no reservation store, Stripe client, price calculator or persistent storage.
function createTollValidation({enabled = false, key, googleJson, lookupPlace, parseServiceDateTime, now = () => Date.now()}) {
  const cache = new Map(), activeActors = new Set(), activeClients = new Set();
  const ttl = 2 * 60 * 1000;
  function prune() { for (const [id, entry] of cache) if (!entry.running && entry.expiresAt <= now()) cache.delete(id); }
  function clear(actorId) { for (const [id, entry] of cache) if (entry.actorId === actorId && !entry.running) cache.delete(id); }
  const config = () => enabled ? {enabled: true, fleet, warnings, retryWindowSeconds: ttl / 1000} : {enabled: false};
  function parse(body) {
    if (!enabled) fail('disabled');
    const keys = ['requestId', 'pickup', 'dropoff', 'via', 'date', 'time', 'directions', 'returnDate', 'returnTime', 'vehicle', 'emissionType'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !keys.includes(k)) ||
        typeof body.requestId !== 'string' || !uuid.test(body.requestId) || body.vehicle !== fleet.vehicle ||
        !['GASOLINE', 'DIESEL'].includes(body.emissionType) || !['outbound', 'both'].includes(body.directions)) fail('input');
    for (const name of ['pickup', 'dropoff']) if (!text(body[name], 200) || body[name].trim().length < 3 || !/\p{L}/u.test(body[name])) fail('input');
    for (const name of ['date', 'time', 'returnDate', 'returnTime']) if (!text(body[name], 10)) fail('input');
    if (!text(body.via, 200) || body.via.trim() && (body.via.trim().length < 3 || !/\p{L}/u.test(body.via))) fail('input');
    let departure, returned;
    try {
      departure = parseServiceDateTime(body.date, body.time, 'pickup');
      if (body.directions === 'both') returned = parseServiceDateTime(body.returnDate, body.returnTime, 'return');
    } catch (_) { fail('input'); }
    if (departure <= now() || (returned !== undefined && returned <= departure) ||
        body.directions === 'outbound' && (body.returnDate || body.returnTime)) fail('input');
    return {...body, pickup: body.pickup.trim(), dropoff: body.dropoff.trim(), via: body.via.trim(),
      departure: new Date(departure).toISOString(), returned: returned === undefined ? null : new Date(returned).toISOString()};
  }
  async function run(input, authority) {
    const authorize = () => { if (!authority?.authorized?.()) fail('unauthorized'); };
    authorize();
    if (!key) fail('unavailable');
    // Resolve each distinct location once. No autocomplete calls are made per keystroke.
    const locations = new Map();
    for (const address of [input.pickup, input.dropoff, ...(input.via ? [input.via] : [])]) {
      if (locations.has(address)) continue;
      authorize();
      const place = await lookupPlace(address, true);
      authorize();
      const state = verifiedState(place);
      if (!state) fail('location');
      locations.set(address, {placeId: place.id, address: place.formattedAddress, state});
    }
    const pickup = locations.get(input.pickup), dropoff = locations.get(input.dropoff), via = locations.get(input.via) || null;
    if (pickup.placeId === dropoff.placeId || via && [pickup.placeId, dropoff.placeId].includes(via.placeId)) fail('location');
    const routes = [];
    for (const [direction, from, to, departure] of [['outbound', pickup, dropoff, input.departure],
      ...(input.returned ? [['return', dropoff, pickup, input.returned]] : [])]) {
      authorize();
      const data = await googleJson('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST', headers: {'Content-Type': 'application/json', 'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'routes.description,routes.distanceMeters,routes.duration,routes.travelAdvisory.tollInfo,routes.legs.steps.navigationInstruction.instructions,routes.warnings'},
        body: JSON.stringify({origin: {placeId: from.placeId}, destination: {placeId: to.placeId},
          ...(via ? {intermediates: [{placeId: via.placeId, via: true}]} : {}), departureTime: departure,
          travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', computeAlternativeRoutes: false,
          extraComputations: ['TOLLS'], routeModifiers: {vehicleInfo: {emissionType: input.emissionType}, tollPasses: ['US_NJ_EZPASSNJ']}})
      });
      authorize();
      const route = data?.routes?.[0];
      if (!route || !Number.isFinite(route.distanceMeters) || route.distanceMeters < 0 ||
          typeof route.duration !== 'string' || !/^\d+(?:\.\d{1,9})?s$/.test(route.duration) || !Number.isFinite(Number(route.duration.slice(0, -1)))) fail('provider');
      const parsed = routeTolls(route);
      // An omitted advisory is not independent proof that the physical route is toll-free.
      const tolls = parsed.status === 'none' ? {status: 'not_reported', amountCents: null} : parsed;
      const instructions = (Array.isArray(route.legs) ? route.legs : []).flatMap(leg => Array.isArray(leg?.steps) ? leg.steps : [])
        .map(step => step?.navigationInstruction?.instructions).filter(value => text(value, 1000));
      routes.push({direction, origin: from, destination: to, via, departureTime: departure, source: 'Google Routes API',
        description: text(route.description, 400) ? route.description : 'Google-returned driving route',
        distanceMeters: route.distanceMeters, durationSeconds: Number(route.duration.slice(0, -1)),
        instructions: instructions.slice(0, 200), instructionsTruncated: instructions.length > 200,
        providerWarnings: (Array.isArray(route.warnings) ? route.warnings : []).filter(value => text(value, 500)).slice(0, 10),
        crossingVerification: 'not_independently_verified', originalGoogleTolls: tolls});
    }
    return {estimateOnly: true, checkoutAllowed: false, capturedAt: new Date(now()).toISOString(),
      fleet, googleAssumptions: {travelMode: 'DRIVE', emissionType: input.emissionType, tollPasses: ['US_NJ_EZPASSNJ']},
      customerTollAdditionCents: 0, warnings, routes};
  }
  async function estimate(body, authority, client) {
    const input = parse(body);
    if (!authority?.authorized?.() || typeof authority.actorId !== 'string') fail('unauthorized');
    prune();
    const id = authority.actorId + ':' + input.requestId;
    const signature = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const previous = cache.get(id);
    if (previous) {
      if (previous.signature !== signature) fail('conflict');
      if (previous.running) fail('busy');
      if (previous.error) fail(previous.error);
      return {...previous.result, reused: true};
    }
    if (activeActors.has(authority.actorId) || activeClients.has(client) || activeActors.size >= 2) fail('busy');
    if (cache.size >= 50) fail('unavailable');
    const entry = {actorId: authority.actorId, signature, running: true};
    cache.set(id, entry); activeActors.add(authority.actorId); activeClients.add(client);
    try {
      entry.result = await run(input, authority);
      return {...entry.result, reused: false};
    } catch (error) {
      entry.error = error instanceof TollValidationError ? error.code : 'provider';
      fail(entry.error);
    } finally {
      entry.running = false; entry.expiresAt = now() + ttl;
      activeActors.delete(authority.actorId); activeClients.delete(client);
      if (!authority.authorized()) cache.delete(id);
    }
  }
  return {config, estimate, prune, clear};
}
module.exports = {createTollValidation, TollValidationError};
