'use strict';

// Quote-only browser regressions: synthetic locations and mocked providers.
// Run with ER_TEST_BOOKING_ENGINE=chromium or webkit and the existing browser
// executable/module variables. No booking, payment, email, or live provider call.
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

for (const width of [390, 1440]) {
  test(`selected Newark Penn Station reaches a zero-toll EWR summary despite two text matches at ${width}px`, {timeout:35000}, async t => {
    const session = await setup(t, width);
    await customerStep(session);
    const result = await quote(session);
    await successfulSummary(session, result);
    assert.equal(result.sent.pickupPlaceId, session.places.pickup.id);
    assert.deepEqual(session.h.state.routes.at(-1).origin, {placeId:session.places.pickup.id});
    assert.deepEqual(session.h.state.routes.at(-1).destination, {placeId:session.places.ewr.id});
    assert.equal(await session.page.locator('#sumPickup').innerText(), session.places.pickup.formattedAddress);
    assert.equal(session.searches.filter(item => item.textQuery === session.input.pickup).length, 0);
    assert.ok(session.details.some(item => item.id === session.places.pickup.id));
  });
}

test('an ordinary drop-off selection sends its identity and displays the verified destination', {timeout:35000}, async t => {
  const session = await setup(t, 390, {destination:'ordinary'});
  await customerStep(session);
  const result = await quote(session);
  await successfulSummary(session, result);
  assert.equal(result.sent.dropoffPlaceId, session.places.dropoff.id);
  assert.deepEqual(session.h.state.routes.at(-1).destination, {placeId:session.places.dropoff.id});
  assert.equal(await session.page.locator('#sumDestination').innerText(), session.places.dropoff.formattedAddress);
  assert.equal(session.searches.filter(item => item.textQuery === session.input.dropoff).length, 0);
});

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
