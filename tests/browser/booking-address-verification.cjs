'use strict';

// Browser regressions: synthetic locations, Pay Later records, mocked providers.
// Run with ER_TEST_BOOKING_ENGINE=chromium or webkit and the existing browser
// executable/module variables. No live booking, payment, email, or provider call.
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture} = require('../helpers/selected-booking-locations.cjs');
const playwright = require(process.env.ER_TEST_PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.ER_TEST_BOOKING_ENGINE || process.env.ER_TEST_BROWSER_ENGINE || 'chromium';
let browser;

test.before(async () => {
  const executablePath = engine === 'webkit' ? process.env.ER_TEST_WEBKIT_EXECUTABLE : process.env.ER_TEST_BROWSER_EXECUTABLE;
  browser = await playwright[engine].launch({headless:true, ...(executablePath ? {executablePath} : {})});
});
test.after(async () => { if (browser) await browser.close(); });

async function setup(t, width = 390, options = {}) {
  const session = await fixture(t, options);
  const mobile = width < 650;
  const context = await browser.newContext({viewport:{width, height:1000}, isMobile:mobile, hasTouch:mobile});
  t.after(() => context.close());
  await context.addInitScript(() => {
    const NativeDate = Date, now = Date.parse('2026-10-01T16:00:00Z');
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
    window.cspFailures = [];
    document.addEventListener('securitypolicyviolation', event => window.cspFailures.push(event.effectiveDirective));
  });
  await context.route('**/*', route => new URL(route.request().url()).origin === session.h.url ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(12000);
  await page.goto(session.h.url + '/#book', {waitUntil:'networkidle'});
  return {...session, page, errors};
}

async function select(session, field) {
  const {page, input} = session;
  await page.locator('#' + field).fill(input[field]);
  await page.locator('#' + field + 'Suggestions button.address-suggestion:not(.current-location-option)')
    .filter({hasText:input[field]}).click();
}

async function customerStep(session, edited = {}) {
  const {page, input} = session;
  await select(session, 'pickup');
  await select(session, 'dropoff');
  for (const [field, value] of Object.entries(edited)) await page.locator('#' + field).fill(value);
  await page.locator('#date').fill(input.date);
  await page.locator('#time').fill(input.time);
  await page.locator('#passengers').selectOption('2');
  await page.locator('#vehicle').selectOption(input.vehicle);
  await page.locator('#bookingContinue').click();
  assert.equal(await page.locator('#book').getAttribute('data-booking-step'), '2');
  for (const field of ['firstName', 'lastName', 'email', 'phone']) await page.locator('#' + field).fill(input[field]);
}

async function quote(session) {
  const {page, h} = session;
  const pending = page.waitForResponse(result => result.url() === h.url + '/api/quote' && result.request().method() === 'POST');
  await page.locator('#quoteBtn').evaluate(element => {
    document.activeElement?.blur();
    element.scrollIntoView({block:'center', behavior:'instant'});
  });
  await page.locator('#quoteBtn').click();
  const response = await pending, body = await response.json();
  await page.waitForFunction(() => !document.getElementById('quoteBtn').disabled);
  return {response, body, sent:response.request().postDataJSON()};
}

async function successfulSummary(session, result) {
  const {page, h, errors} = session;
  assert.equal(result.response.status(), 200, JSON.stringify(result.body));
  await page.waitForFunction(() => document.getElementById('book').dataset.bookingStep === '3');
  assert.equal(result.body.tolls.status, 'waived');
  assert.equal(result.body.pricingBreakdown.tollsCents, 0);
  const tollRow = page.locator('#fareBreakdown .fare-breakdown-row').filter({hasText:'Tolls'});
  assert.equal(await tollRow.locator('strong').innerText(), '$0.00');
  assert.equal(await page.locator('#payBtn').isEnabled(), true);
  assert.equal(await page.locator('#payLaterBtn').isEnabled(), true);
  assert.ok(!(await page.locator('#notice').innerText()).includes('Toll estimate unavailable'));
  assert.equal(await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth)), 0);
  assert.deepEqual(await page.evaluate(() => window.cspFailures), []);
  assert.deepEqual(errors, []);
  assert.equal(h.records().length, 0);
  assert.equal(h.state.creates.length, 0);
}

async function rejectedSummary(session, result, field, unavailable = false) {
  const {page, h} = session;
  assert.equal(result.response.status(), unavailable ? 503 : 400, JSON.stringify(result.body));
  assert.equal(result.body.code, unavailable ? 'ADDRESS_LOOKUP_UNAVAILABLE' : 'ADDRESS_VERIFICATION_FAILED');
  assert.equal(result.body.field, field);
  assert.equal(result.body.checkoutAllowed, false);
  assert.equal(await page.locator('#book').getAttribute('data-booking-step'), '2');
  const notice = await page.locator('#notice').innerText();
  assert.match(notice, field === 'pickup' ? /pickup/i : /drop-off/i);
  assert.match(notice, unavailable ? /temporarily unavailable.*try again/i : /select.*address suggestions.*try again/i);
  assert.doesNotMatch(notice, /Toll estimate unavailable|synthetic-private-provider-marker/);
  assert.equal(await page.locator('#payBtn').isEnabled(), false);
  assert.equal(await page.locator('#payLaterBtn').isEnabled(), false);
  assert.equal(h.records().length, 0);
  assert.equal(h.state.creates.length, 0);
}

async function savePayLater(session, reviewed) {
  const {page, h} = session;
  const pending = page.waitForResponse(response => response.url() === h.url + '/api/checkout' && response.request().method() === 'POST');
  await page.locator('#payLaterBtn').scrollIntoViewIfNeeded();
  await page.locator('#payLaterBtn').click();
  const response = await pending;
  assert.equal(response.status(), 200);
  assert.equal(h.records().length, 1);
  const saved = h.records()[0];
  assert.ok(saved);
  await page.waitForURL(url => url.origin === h.url && url.pathname === '/success.html' && url.searchParams.get('booking') === saved.id);
  assert.equal(saved.paymentStatus, 'unpaid');
  assert.equal(saved.quote.totalCents, reviewed.body.totalCents);
  assert.equal(saved.quote.pricingBreakdown.tollsCents, 0);
  assert.equal(h.state.creates.length, 0);
  return saved;
}

for (const width of [390, 1440]) {
  test(`selected Newark Penn Station retains its verified name in summary and reservation at ${width}px`, {timeout:35000}, async t => {
    const session = await setup(t, width);
    await customerStep(session);
    const result = await quote(session);
    await successfulSummary(session, result);
    assert.equal(result.sent.pickupPlaceId, session.places.pickup.id);
    assert.deepEqual(session.h.state.routes.at(-1).origin, {placeId:session.places.pickup.id});
    assert.deepEqual(session.h.state.routes.at(-1).destination, {placeId:session.places.ewr.id});
    const expected = 'Newark Penn Station, ' + session.places.pickup.formattedAddress;
    assert.equal(await session.page.locator('#sumPickup').innerText(), expected);
    assert.equal(result.body.verifiedAddresses.pickup, expected);
    assert.equal(session.searches.filter(item => item.textQuery === session.input.pickup).length, 0);
    assert.ok(session.details.some(item => item.id === session.places.pickup.id && item.fieldMask.split(',').includes('displayName')));
    const saved = await savePayLater(session, result);
    assert.equal(saved.trip.pickup, expected);
    assert.equal(saved.trip.pickupPlaceId, session.places.pickup.id);
    assert.ok(session.h.state.routes.every(route => route.origin.placeId === session.places.pickup.id && route.destination.placeId === session.places.ewr.id));
  });
}

test('an ordinary drop-off retains its verified place name in summary and reservation', {timeout:35000}, async t => {
  const session = await setup(t, 390, {destination:'ordinary'});
  session.places.dropoff.displayName = {text:'Jersey City Hotel'};
  await customerStep(session);
  const result = await quote(session);
  await successfulSummary(session, result);
  assert.equal(result.sent.dropoffPlaceId, session.places.dropoff.id);
  assert.deepEqual(session.h.state.routes.at(-1).destination, {placeId:session.places.dropoff.id});
  const expected = 'Jersey City Hotel, ' + session.places.dropoff.formattedAddress;
  assert.equal(await session.page.locator('#sumDestination').innerText(), expected);
  assert.equal(session.searches.filter(item => item.textQuery === session.input.dropoff).length, 0);
  const saved = await savePayLater(session, result);
  assert.equal(saved.trip.dropoff, expected);
  assert.equal(saved.trip.dropoffPlaceId, session.places.dropoff.id);
});

for (const mode of ['missing', 'already included', 'oversized']) {
  test(`a ${mode} place name uses the same unduplicated summary and saved address`, {timeout:35000}, async t => {
    const session = await setup(t, 390);
    if (mode === 'missing') delete session.places.pickup.displayName;
    else if (mode === 'oversized') session.places.pickup.displayName = {text:'N'.repeat(180)};
    else session.places.pickup.formattedAddress = 'NEWARK PENN STATION, ' + session.places.pickup.formattedAddress;
    const expected = session.places.pickup.formattedAddress;
    await customerStep(session);
    const result = await quote(session);
    await successfulSummary(session, result);
    assert.equal(await session.page.locator('#sumPickup').innerText(), expected);
    assert.equal(result.body.verifiedAddresses.pickup, expected);
    assert.equal((expected.match(/newark penn station/gi) || []).length, mode === 'already included' ? 1 : 0);
    const saved = await savePayLater(session, result);
    assert.equal(saved.trip.pickup, expected);
    assert.equal(saved.trip.pickupPlaceId, session.places.pickup.id);
  });
}

test('editing selected pickup and drop-off removes both old IDs and uses typed-address verification', {timeout:35000}, async t => {
  const session = await setup(t, 390, {destination:'ordinary'});
  const edited = {pickup:'40 Changed Test Street, Newark, NJ', dropoff:'50 Changed Test Street, Elizabeth, NJ'};
  const pickup = {...session.places.pickup, id:'synthetic_edited_pickup', formattedAddress:edited.pickup};
  const dropoff = {...session.places.dropoff, id:'synthetic_edited_dropoff', formattedAddress:edited.dropoff};
  session.h.state.searchResults[edited.pickup] = [pickup];
  session.h.state.searchResults[edited.dropoff] = [dropoff];
  await customerStep(session, edited);
  assert.equal(await session.page.locator('#pickup').getAttribute('data-place-id'), null);
  assert.equal(await session.page.locator('#dropoff').getAttribute('data-place-id'), null);
  const result = await quote(session);
  await successfulSummary(session, result);
  assert.equal(Object.hasOwn(result.sent, 'pickupPlaceId'), false);
  assert.equal(Object.hasOwn(result.sent, 'dropoffPlaceId'), false);
  assert.deepEqual(session.h.state.routes.at(-1).origin, {placeId:pickup.id});
  assert.deepEqual(session.h.state.routes.at(-1).destination, {placeId:dropoff.id});
  assert.ok(session.searches.some(item => item.textQuery === edited.pickup));
  assert.ok(session.searches.some(item => item.textQuery === edited.dropoff));
  assert.equal(session.details.some(item => item.id === session.places.pickup.id || item.id === session.places.dropoff.id), false);
});

for (const field of ['pickup', 'dropoff']) {
  test(`an invalid selected ${field} identifies the field and keeps payment unavailable`, {timeout:35000}, async t => {
    const session = await setup(t, 390, {destination:'ordinary'});
    const location = session.places[field];
    session.h.state.detailsById[location.id] = {...location, id:'synthetic_wrong_returned_id'};
    await customerStep(session);
    await rejectedSummary(session, await quote(session), field);
    assert.equal(session.h.state.routes.length, 0);
  });
}

test('a temporary drop-off provider failure offers retry and a later valid quote enables payment', {timeout:35000}, async t => {
  const session = await setup(t, 390, {destination:'ordinary'});
  session.h.state.selectedPlaceFailures[session.places.dropoff.id] = {status:503};
  await customerStep(session);
  await rejectedSummary(session, await quote(session), 'dropoff', true);
  assert.equal(session.h.state.routes.length, 0);
  delete session.h.state.selectedPlaceFailures[session.places.dropoff.id];
  await successfulSummary(session, await quote(session));
  assert.equal(await session.page.locator('#sumDestination').innerText(), session.places.dropoff.formattedAddress);
});
