'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {create, cases} = require('../helpers/booking-browser.cjs');
const playwright = require(process.env.ER_TEST_PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.ER_TEST_BROWSER_ENGINE || 'chromium';
const coordinates = {latitude:40.735657, longitude:-74.172366};
const detected = '1 Market St, Newark, NJ 07102, USA';
const corrected = '123 Corrected Test St, Orange, NJ 07050, USA';
const wrong = '2 Neighbor Street, Newark, NJ 07102, USA';

let browser;
test.before(async () => {
  const executablePath = process.env.ER_TEST_BROWSER_EXECUTABLE;
  browser = await playwright[engine].launch({
    headless:true,
    ...(engine === 'chromium' && executablePath ? {executablePath} : {})
  });
});
test.after(async () => {
  if (browser) await browser.close();
});

async function setup(t, width) {
  const {h, input} = await create(t, {...cases[0], id:'pickup_confirmation', pickup:detected});
  const [originalPlace] = h.state.searchResults[detected];
  h.state.searchResults[corrected] = [{...originalPlace, id:'ChIJ_corrected_server', formattedAddress:corrected}];
  const mobile = width < 650;
  const context = await browser.newContext({
    ...(engine === 'webkit' && mobile ? playwright.devices['iPhone 13'] : {}),
    viewport:{width, height:1000}, isMobile:mobile, hasTouch:mobile
  });
  t.after(() => context.close());

  // All provider traffic is mocked. Geolocation callbacks are synthetic.
  await context.addInitScript(() => {
    const NativeDate = Date;
    const now = Date.parse('2026-10-01T16:00:00Z');
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
    window.cspFailures = [];
    document.addEventListener('securitypolicyviolation', event => window.cspFailures.push(event.effectiveDirective));
    navigator.geolocation.getCurrentPosition = (success, failure) => {
      window.testGps = {success, failure};
    };
  });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url === 'https://checkout.example.test/mock') {
      return route.fulfill({status:200, contentType:'text/html', body:'<!doctype html><title>Test Checkout</title>'});
    }
    return new URL(url).origin === h.url ? route.continue() : route.abort();
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(h.url + '/#book', {waitUntil:'networkidle'});
  await page.locator('#dropoff').fill(input.dropoff);
  await page.locator('#date').fill(input.date);
  await page.locator('#time').fill(input.time);
  await page.locator('#passengers').selectOption('2');
  const press = locator => mobile ? locator.tap() : locator.click();
  const response = path => page.waitForResponse(result => result.url() === h.url + path);
  return {h, input, page, errors, press, response};
}

async function beginLookup({page, press}, withExistingPickup = false) {
  if (withExistingPickup) await page.locator('#pickup').focus();
  await press(page.locator(withExistingPickup ? '#pickupSuggestions .current-location-option' : '#currentLocationBtn'));
  assert.equal(await page.locator('#pickupLocationStatus').innerText(), 'Detecting your location…');
}

async function finishLookup({page, response}, accuracy = 8) {
  const pending = response('/api/reverse-geocode');
  await page.evaluate(coords => window.testGps.success({coords}), {...coordinates, accuracy});
  const result = await pending;
  assert.equal(result.status(), 200);
  assert.deepEqual(result.request().postDataJSON(), coordinates);
}

async function checkLayout({page, errors}) {
  assert.equal(await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth)), 0);
  assert.deepEqual(await page.evaluate(() => window.cspFailures), []);
  assert.deepEqual(errors, []);
}

async function checkProposal(session, proposal, previousPickup) {
  const {page, press} = session;
  const review = page.getByRole('group', {name:'Confirm Your Pickup Location'});
  await review.waitFor();
  assert.equal(await review.locator('#pickupLocationProposed').innerText(), proposal);
  assert.equal(await review.locator('small').innerText(), 'Please verify that this is the correct address where your chauffeur should arrive.');
  assert.equal(await page.locator('#pickup').inputValue(), previousPickup);
  await press(page.locator('#bookingContinue'));
  assert.equal(await page.locator('#book').getAttribute('data-booking-step'), '1');
  await checkLayout(session);
}

async function selectCorrection({page, press}) {
  await page.route('**/api/address-suggestions?*', route => route.fulfill({
    json:{suggestions:[{description:corrected, placeId:'ChIJ_corrected_selection'}]}
  }));
  await page.locator('#pickup').fill('Corrected Test');
  await press(page.locator('#pickupSuggestions .address-suggestion').filter({hasText:corrected}));
  assert.equal(await page.locator('#pickup').inputValue(), corrected);
  assert.equal(await page.locator('#pickup').getAttribute('data-place-id'), 'ChIJ_corrected_selection');
}

async function pressBookingButton({page, press}, selector) {
  const button = page.locator(selector);
  // Settle the form's smooth scrolling before automating the next step in WebKit.
  await button.evaluate(element => {
    document.activeElement?.blur();
    element.scrollIntoView({block:'center', behavior:'instant'});
  });
  await press(button);
}

async function quote(session, pickup) {
  const {page, h, input, press, response} = session;
  await press(page.locator('#bookingContinue'));
  assert.equal(await page.locator('#book').getAttribute('data-booking-step'), '2');
  for (const field of ['firstName', 'lastName', 'email', 'phone']) {
    await page.locator('#' + field).fill(input[field]);
  }
  const pending = response('/api/quote');
  await pressBookingButton(session, '#quoteBtn');
  const result = await pending;
  assert.equal(result.status(), 200);
  assert.equal(result.request().postDataJSON().pickup, pickup);
  const data = await result.json();
  await page.waitForFunction(() => document.getElementById('book').dataset.bookingStep === '3');
  assert.equal(await page.locator('#sumPickup').innerText(), pickup);
  assert.equal(await page.locator('#sumMiles').innerText(), data.miles + ' mi');
  assert.equal(await page.locator('#sumMinutes').innerText(), data.minutes + ' min');
  assert.equal(await page.locator('#sumTotal').innerText(), '$' + data.total.toFixed(2));
  assert.deepEqual(h.state.routes.at(-1).origin, {placeId:h.state.searchResults[pickup][0].id});
  await checkLayout(session);
  return data;
}

async function reserve(session, pickup, quoted, payNow) {
  const {h, page, response} = session;
  assert.equal(await page.locator('#payBtn').isEnabled(),true);
  const pending = response('/api/checkout');
  await pressBookingButton(session, payNow ? '#payBtn' : '#payLaterBtn');
  const result = await pending;
  assert.equal(result.status(), 200);
  assert.equal(result.request().postDataJSON().pickup, pickup);
  const [booking] = h.records();
  assert.equal(h.records().length, 1);
  assert.equal(booking.trip.pickup, pickup);
  assert.equal(booking.quote.total, quoted.total);
  assert.ok(!JSON.stringify(booking).includes('latitude'));
  assert.equal(h.state.creates.length, payNow ? 1 : 0);
  if (payNow) {
    assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount, quoted.totalCents);
  }

  const login = await h.request('/api/admin/login', {token:'local-test-token'});
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const dispatch = await h.request('/api/bookings/search?search=' + encodeURIComponent(booking.id), undefined, {cookie});
  assert.equal(dispatch.status, 200);
  assert.equal(dispatch.body.bookings[0].trip.pickup, pickup);
}

for (const width of [320, 390, 1440]) {
  test(`confirmed GPS pickup reaches summary, Pay Now and dispatch at ${width}px`, {timeout:35000}, async t => {
    const session = await setup(t, width);
    const {page, press} = session;
    await beginLookup(session);
    await finishLookup(session);
    await checkProposal(session, detected, '');
    await press(page.locator('#confirmPickupLocation'));
    assert.equal(await page.locator('#pickup').inputValue(), detected);
    assert.equal(await page.locator('#pickup').getAttribute('data-place-id'), 'ChIJ_reverse_street');
    assert.equal(await page.locator('#pickupLocationReview').isVisible(), false);
    await reserve(session, detected, await quote(session, detected), true);
  });

  test(`wrong street from weak Wi-Fi fix can be corrected with Places at ${width}px`, {timeout:35000}, async t => {
    const session = await setup(t, width);
    const {page, h, press} = session;
    h.state.reverseResult = {status:'OK', results:[{formatted_address:wrong, place_id:'ChIJ_wrong', types:['street_address']}]};
    await page.locator('#pickup').fill(detected);
    await beginLookup(session, true);
    await finishLookup(session, 500);
    await checkProposal(session, wrong, detected);
    await press(page.locator('#editPickupLocation'));
    assert.equal(await page.locator('#pickup').inputValue(), detected);
    await selectCorrection(session);
    assert.equal(await page.locator('#pickupLocationReview').isVisible(), false);
    await reserve(session, corrected, await quote(session, corrected), false);
  });

  test(`repeat detection and manual changes after confirming at ${width}px`, {timeout:35000}, async t => {
    const session = await setup(t, width);
    const {page, press} = session;
    await beginLookup(session);
    await finishLookup(session);
    await press(page.locator('#confirmPickupLocation'));
    await beginLookup(session, true);
    await finishLookup(session);
    assert.equal(await page.locator('#pickupLocationReview').isVisible(), false);
    await page.locator('#pickup').fill(corrected);
    assert.equal(await page.locator('#pickup').getAttribute('data-place-id'), null);
    await quote(session, corrected);
  });

  test(`permission denial allows manual pickup at ${width}px`, {timeout:35000}, async t => {
    const session = await setup(t, width);
    const {page} = session;
    await beginLookup(session);
    await page.evaluate(() => window.testGps.failure({code:1}));
    assert.match(await page.locator('#pickupLocationStatus').innerText(), /Location access was denied/);
    assert.equal(await page.locator('#pickupLocationReview').isVisible(), false);
    await page.locator('#pickup').fill(corrected);
    await quote(session, corrected);
  });

  test(`late GPS callback cannot replace a manual pickup at ${width}px`, {timeout:35000}, async t => {
    const session = await setup(t, width);
    const {page, h} = session;
    await beginLookup(session);
    await page.locator('#pickup').fill(corrected);
    const calls = h.state.googleCalls;
    await page.evaluate(coords => window.testGps.success({coords}), coordinates);
    assert.equal(h.state.googleCalls, calls);
    assert.equal(await page.locator('#pickup').inputValue(), corrected);
    assert.equal(await page.locator('#pickupLocationReview').isVisible(), false);
    await quote(session, corrected);
  });
}
