'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {setup, initialClock} = require('../helpers/reservation-management.cjs');
const {places, configure, trip} = require('../helpers/booking-stops.cjs');

const engine = process.env.ER_TEST_STOPS_ENGINE || 'chromium';
const options = {skip: !process.env.ER_TEST_DATABASE_URL && 'Requires an isolated PostgreSQL database', timeout: 90000};
const mockCheckout = 'https://checkout.example.test/mock';

let browser, devices;
test.before(async () => {
  if (options.skip) return;
  const playwright = require(process.env.ER_TEST_PLAYWRIGHT_MODULE || 'playwright');
  const executablePath = engine === 'webkit' ? process.env.ER_TEST_WEBKIT_EXECUTABLE : process.env.ER_TEST_BROWSER_EXECUTABLE;
  browser = await playwright[engine].launch({headless: true, ...(executablePath && {executablePath})});
  devices = playwright.devices;
});
test.after(async () => { await browser?.close(); });

async function fixture(t, width, {configured, account = false} = {}) {
  const f = await setup(t, {ROUTE_TOLLS_ENABLED:'true', ROUTE_TOLLS_MODE:'estimate',
    ...(configured === undefined ? {} : {BOOKING_STOP_WAITING_RATES_CENTS_JSON:configured})});
  configure(f.h);
  const height = {320:568,390:844,430:932}[width] || 1050;
  const mobile = width < 600;
  const profile = devices[engine === 'webkit' ? 'iPhone 13' : 'Pixel 7'];
  const context = await browser.newContext({viewport:{width,height},isMobile:mobile,hasTouch:mobile,
    ...(mobile && {userAgent:profile.userAgent})});
  t.after(() => context.close());
  await context.addInitScript(now => {
    const NativeDate = Date;
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
    window.stopCsp = [];
    document.addEventListener('securitypolicyviolation', event => window.stopCsp.push(event.effectiveDirective));
  }, initialClock);
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url === mockCheckout) return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Simulated Checkout</title>'});
    return new URL(url).origin === f.h.url ? route.continue() : route.abort();
  });
  async function addCookie(cookie) {
    const equal = cookie.indexOf('=');
    await context.addCookies([{name:cookie.slice(0,equal),value:cookie.slice(equal+1),url:f.h.url}]);
  }
  if (account) await addCookie(await f.register({email:trip.email,phone:trip.phone}));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(f.h.url+'/#book');
  return {...f, context, page, errors, addCookie};
}

async function tripDetails(page, special = false) {
  if (special) {
    await page.locator('#ewrManhattanSpecialBtn').click();
    await page.waitForFunction(() => document.activeElement.id === 'dropoff');
    await page.locator('#dropoff').fill('Manhattan');
    await page.locator('#dropoffSuggestions').getByText(places.destination.address,{exact:true}).click();
  } else {
    await page.locator('#pickup').fill(trip.pickup);
    await page.locator('#dropoff').fill(trip.dropoff);
  }
  await page.locator('#date').fill(trip.date);
  await page.locator('#time').fill(trip.time);
  await page.locator('#passengers').selectOption('2');
}

async function addStop(page, index, place, wait = '5') {
  const editor = page.locator('#bookingStopEditor');
  await editor.getByRole('button',{name:index === 1 ? '+ Add a Stop' : '+ Add Another Stop',exact:true}).click();
  const input = editor.getByLabel('Stop '+index+' address',{exact:true});
  await input.fill(place.address);
  const suggestion = editor.getByRole('button',{name:place.address,exact:true});
  if (page.viewportSize().width < 600) await suggestion.tap();
  else await suggestion.click();
  await editor.getByLabel('Expected waiting time at Stop '+index,{exact:true}).selectOption(wait);
}

async function customerDetails(page) {
  await page.locator('#bookingContinue').click();
  await page.waitForFunction(() => document.getElementById('book').dataset.bookingStep === '2');
  for (const field of ['firstName','lastName','email','phone']) await page.locator('#'+field).fill(trip[field]);
}

async function requestQuote(f, status = 200) {
  const response = f.page.waitForResponse(r => r.url() === f.h.url+'/api/quote' && r.request().method() === 'POST');
  await f.page.locator('#quoteBtn').click();
  const result = await response;
  assert.equal(result.status(),status,JSON.stringify(await result.json()));
  if (status === 200) await f.page.waitForFunction(() => document.getElementById('book').dataset.bookingStep === '3');
  return result.json();
}

const money = cents => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
async function layout(page) {
  const check = await page.evaluate(() => ({
    overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth), csp:window.stopCsp
  }));
  assert.deepEqual(check,{overflow:0,csp:[]});
}
async function screenshot(page, selector, name) {
  const dir = process.env.ER_TEST_STOPS_SCREENSHOTS_DIR;
  if (!dir || engine !== 'chromium') return;
  fs.mkdirSync(dir,{recursive:true});
  const viewport = page.viewportSize();
  const expandDesktop = viewport.width === 1440 && viewport.height < 1400;
  if (expandDesktop) await page.setViewportSize({...viewport,height:1400});
  try {
    const component = page.locator(selector);
    await component.evaluate(element => {
      if (element.contains(document.activeElement)) document.activeElement.blur();
    });
    await component.screenshot({path:path.join(dir,name+'.png'),animations:'disabled',
      // Component captures exclude the sticky page navigation.
      style:'.nav { visibility: hidden !important; }'});
  } finally {
    if (expandDesktop) await page.setViewportSize(viewport);
  }
}

for (const width of [320,390,430,1440]) {
  test(engine+' stop booking, reorder, summary and payment at '+width+'px',options,async t => {
    const useAccount = width === 1440;
    const payLater = width === 390 || width === 430;
    const vehicle = width >= 430 ? 'escalade' : 'suv';
    const f = await fixture(t,width,{account:useAccount});
    const {page,h} = f;
    const editor = page.locator('#bookingStopEditor');
    assert.equal(await editor.locator('fieldset').count(),0);
    await tripDetails(page);
    await page.locator('#vehicle').selectOption(vehicle);
    assert.equal(await page.locator('#payBtn').isVisible(),false);
    await addStop(page,1,places.first);
    assert.equal(await editor.getByLabel('Expected waiting time at Stop 1').inputValue(),'5');
    await addStop(page,2,places.second,'10');
    if (width === 390 || width === 1440) await screenshot(page,'#book','add-stops-'+width);
    await addStop(page,3,places.third,'15');
    assert.equal(await editor.getByRole('button',{name:'+ Add Another Stop',exact:true}).isVisible(),false);
    await editor.getByRole('button',{name:'Move Stop 3 earlier'}).click();
    assert.equal(await editor.getByLabel('Stop 2 address').inputValue(),places.third.address);
    await editor.getByRole('button',{name:'Remove Stop 1'}).click();
    await addStop(page,3,places.first);
    assert.deepEqual(await editor.locator('input').evaluateAll(fields=>fields.map(field=>field.value)),
      [places.third.address,places.second.address,places.first.address]);
    await layout(page);
    await customerDetails(page);
    const quoted = await requestQuote(f);
    const stopRows = page.locator('#summaryStops .booked-stop-row');
    assert.deepEqual(await stopRows.locator('strong').allTextContents(),quoted.stopSummary.stops.map(stop=>stop.address));
    assert.match(await stopRows.first().innerText(),/15 min expected.*5 min free.*10 min billable/s);
    assert.equal(quoted.vehicleKey,vehicle);
    assert.equal(quoted.stopSummary.freeMinutes,15);
    assert.equal(quoted.stopSummary.billableMinutes,15);
    assert.equal(quoted.stopSummary.rateCentsPerMinute,150);
    assert.equal(quoted.stopSummary.chargeCents,2250);
    assert.equal(quoted.tolls.amountCents,2300);
    assert.equal(await page.locator('#sumTotal').innerText(),money(quoted.totalCents));
    const fareRows = await page.locator('#fareBreakdown .fare-breakdown-row').evaluateAll(rows =>
      rows.map(row => [...row.children].map(child => child.textContent)));
    assert.deepEqual(fareRows,[['Trip Fare',money(quoted.totalCents-4550)],['Tolls','$23.00'],['Additional Stop Waiting','$22.50']]);
    assert.match(await page.locator('#summaryStopNotice').innerText(),/15 billable minutes at \$1\.50 per minute/);
    assert.match(await page.locator('#summaryStopNotice').innerText(),/extra waiting charge requires your authorization/);
    assert.equal(await page.locator('.booking-cancellation-note').evaluate(el=>getComputedStyle(el).fontSize),'12px');
    await layout(page);
    if (width === 390 || width === 1440) await screenshot(page,'#book','stop-summary-'+width);

    await page.locator('#bookingEditTrip').click();
    await editor.getByLabel('Expected waiting time at Stop 1').selectOption('20');
    await page.locator('#bookingContinue').click();
    assert.equal(await page.locator('#email').inputValue(),trip.email);
    const revised = await requestQuote(f);
    assert.notEqual(revised.quoteRevision,quoted.quoteRevision);
    assert.equal(revised.totalCents,quoted.totalCents+750);
    const reserving = page.waitForResponse(r => r.url() === h.url+'/api/checkout');
    await page.locator(payLater?'#payLaterBtn':'#payBtn').click();
    const reservation = await reserving;
    assert.equal(reservation.status(),200);
    const {rows} = await f.pool.query('SELECT id FROM er_reservations');
    assert.equal(rows.length,1);
    const {id} = rows[0];
    const accepted = await f.store.getForDisplay(id);
    assert.equal(accepted.quote.totalCents,revised.totalCents);
    assert.equal(accepted.quote.stopPlan.rateCentsPerMinute,150);
    assert.equal(accepted.quote.stopPlan.chargeCents,3000);
    if (payLater) {
      await page.waitForURL(url => url.pathname === '/success.html');
      await page.getByText(accepted.bookingReference,{exact:true}).waitFor();
      assert.match(await page.locator('#details').innerText(),/Stop 1.*20 min expected/s);
      await layout(page);
      assert.equal(h.state.creates.length,0);
      await page.locator('#completePayment').click();
    }
    await page.waitForURL(mockCheckout);
    assert.equal(h.state.creates.length,1);
    assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,revised.totalCents);
    const session = [...h.state.sessions.values()][0];
    session.status = 'complete'; session.payment_status = 'paid';
    assert.equal((await h.webhook(session)).status,200);
    await page.goto(h.url+'/success.html?booking='+id);
    await page.getByText(accepted.bookingReference,{exact:true}).waitFor();
    assert.match(await page.locator('#details').innerText(),/Stop 1.*Stop 2.*Stop 3.*Final destination/s);
    assert.equal(await page.locator('#completePayment').isVisible(),false);
    await layout(page);

    if (useAccount) {
      await page.goto(h.url+'/account/dashboard');
      await page.locator('.trip-card').filter({hasText:accepted.bookingReference}).waitFor();
      const card = page.locator('.trip-card').filter({hasText:accepted.bookingReference});
      await card.getByText('View Trip Details',{exact:true}).click();
      assert.match(await card.locator('.trip-details').innerText(),/Stop 1.*Stop 2.*Stop 3/s);
      await page.goto(h.url+'/manage-reservation.html?reservation='+id);
      await page.getByText(accepted.bookingReference,{exact:true}).waitFor();
      await page.locator('#manageKind').selectOption('locations');
      await page.getByRole('button',{name:'Request stop changes'}).click();
      await page.locator('#manageStopEditor').getByLabel('Expected waiting time at Stop 1').selectOption('5');
      await page.locator('#manageConfirmed').check();
      await page.locator('#manageSubmitRequest').click();
      await page.getByText(/Pending review/).waitFor();
      assert.match(await page.locator('#manageDetails').innerText(),/Stop 1.*20 min expected/s);
      assert.equal((await f.store.get(id)).quote.total,revised.total);

      await f.addCookie(await f.adminLogin());
      await page.goto(h.url+'/admin.html');
      const dispatch = page.locator('.dispatch-card').filter({hasText:accepted.bookingReference});
      await dispatch.waitFor();
      const route = await dispatch.locator('.dispatch-route').innerText();
      assert.match(route,/Pickup.*Stop 1.*Stop 2.*Stop 3.*Final Destination.*Additional Stop Waiting/si);
      assert.match(route,/5 min expected · 5 min free · 0 min billable/);
      assert.match(await dispatch.innerText(),/Manage Dispatch/);
      await layout(page);
    }
    assert.deepEqual(f.errors,[]);
  });
}

test(engine+' malformed rates, invalid autocomplete, unsupported types and EWR stop exclusion',options,async t => {
  const f = await fixture(t,390,{configured:'not JSON'});
  const {page,h} = f;
  const editor = page.locator('#bookingStopEditor');
  for (const type of ['hourly','roundtrip']) {
    await page.locator('[data-trip-type="'+type+'"]').click();
    assert.equal(await editor.isVisible(),false);
    assert.equal(await page.locator('#bookingStopUnsupported').isVisible(),true);
  }
  await tripDetails(page,true);
  assert.equal(await page.locator('#vehicle').isDisabled(),true);
  await editor.getByRole('button',{name:'+ Add a Stop',exact:true}).click();
  assert.equal(await page.locator('#bookingStopOfferNote').isVisible(),true);
  assert.equal(await page.locator('#vehicle').isEnabled(),true);
  const stop = editor.getByLabel('Stop 1 address');
  await stop.fill('Unresolved address');
  await page.locator('#bookingContinue').click();
  assert.equal(await page.locator('#book').getAttribute('data-booking-step'),'1');
  await stop.fill(places.first.address);
  await editor.getByRole('button',{name:places.first.address,exact:true}).click();
  await editor.getByLabel('Expected waiting time at Stop 1').selectOption('10');
  await customerDetails(page);
  const unavailable = await requestQuote(f,422);
  assert.match(unavailable.error,/Only five minutes per stop/);
  assert.equal(await page.locator('#payBtn').isEnabled(),false);
  await page.locator('#bookingBack').click();
  await editor.getByLabel('Expected waiting time at Stop 1').selectOption('5');
  await page.locator('#bookingContinue').click();
  const withStop = await requestQuote(f);
  assert.equal(withStop.nonstopOfferExcluded,true);
  assert.equal(withStop.fixedOffer,null);
  assert.match(await page.locator('#summaryStopNotice').innerText(),/\$150.*nonstop only/);
  await page.locator('#bookingEditTrip').click();
  await editor.getByRole('button',{name:'Remove Stop 1'}).click();
  assert.equal(await page.locator('#vehicle').isDisabled(),true);
  await page.locator('#bookingContinue').click();
  const nonstop = await requestQuote(f);
  assert.equal(nonstop.total,150);
  assert.equal(nonstop.stopSummary,undefined);
  assert.equal(h.state.creates.length,0);
  await layout(page);
  assert.deepEqual(f.errors,[]);
});