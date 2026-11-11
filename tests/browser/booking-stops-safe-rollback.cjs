'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {initialClock} = require('../helpers/reservation-management.cjs');
const {unavailable, stoppedBooking, startRollback} = require('../helpers/booking-stops-safe-rollback.cjs');

const engine = process.env.ER_TEST_STOPS_ENGINE || 'chromium';
const options = {skip:unavailable, timeout:90000};
let browser, devices;

test.before(async () => {
  if (options.skip) return;
  const playwright = require(process.env.ER_TEST_PLAYWRIGHT_MODULE || 'playwright');
  const executablePath = engine === 'webkit' ? process.env.ER_TEST_WEBKIT_EXECUTABLE : process.env.ER_TEST_BROWSER_EXECUTABLE;
  browser = await playwright[engine].launch({headless:true, ...(executablePath && {executablePath})});
  devices = playwright.devices;
});
test.after(async () => { await browser?.close(); });

function assertItinerary(text, accepted) {
  const locations = [accepted.trip.pickup, ...accepted.quote.stopPlan.stops.map(stop => stop.address), accepted.trip.dropoff];
  let previous = -1;
  for (const location of locations) {
    const position = text.indexOf(location);
    assert.ok(position > previous, 'Expected ordered address in itinerary: '+location);
    previous = position;
  }
  assert.match(text, /10 min expected/);
  assert.match(text, /5 min expected/);
  assert.match(text, /15 min expected/);
}

async function assertLayout(page) {
  const {width, contentWidth, csp} = await page.evaluate(() => ({
    width:innerWidth, contentWidth:document.documentElement.scrollWidth, csp:window.rollbackCsp
  }));
  assert.ok(contentWidth <= width + 1, 'Page has horizontal overflow');
  assert.deepEqual(csp, []);
}

for (const width of [320,390,430,1440]) {
  const vehicle = width <= 390 ? 'suv' : 'escalade';
  test(engine+' rollback itinerary / '+vehicle+' / '+width+'px',options,async t => {
    const {feature,owner,id,accepted} = await stoppedBooking(t,{vehicle});
    const rollback = await startRollback(t,feature);
    const origin = rollback.h.url;
    const height = {320:568,390:844,430:932}[width] || 1050;
    const mobile = width < 600;
    const device = devices[engine === 'webkit' ? 'iPhone 13' : 'Pixel 7'];
    const context = await browser.newContext({viewport:{width,height},isMobile:mobile,hasTouch:mobile,
      ...(mobile && {userAgent:device.userAgent})});
    t.after(() => context.close());
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.addInitScript(now => {
      const NativeDate = Date;
      window.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
      };
      window.rollbackCsp = [];
      document.addEventListener('securitypolicyviolation', event => window.rollbackCsp.push(event.effectiveDirective));
    }, initialClock);
    async function signIn(cookie) {
      const equal = cookie.indexOf('=');
      await context.addCookies([{name:cookie.slice(0,equal),value:cookie.slice(equal+1),url:origin}]);
    }

    await signIn(owner);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const total = new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(accepted.quote.totalCents / 100);
    await page.goto(origin+'/account/dashboard');
    const trip = page.locator('.trip-card').filter({hasText:accepted.bookingReference});
    await trip.waitFor();
    assertItinerary(await trip.locator('.trip-route').innerText(),accepted);
    await trip.getByText('View Trip Details',{exact:true}).click();
    const details = await trip.locator('.trip-details').innerText();
    assertItinerary(details,accepted);
    assert.ok(details.includes('$22.50') && details.includes(total));
    assert.equal(await trip.getByText('Book Again',{exact:true}).count(),0);
    await assertLayout(page);

    await page.goto(origin+'/manage-reservation.html?reservation='+id);
    await page.getByText(accepted.bookingReference,{exact:true}).waitFor();
    const management = await page.locator('#manageDetails').innerText();
    assertItinerary(management,accepted);
    assert.ok(management.includes('$22.50') && management.includes(total));
    assert.equal(await page.locator('#manageStopEditor').count(),0);
    await assertLayout(page);

    await page.goto(origin+'/success.html?booking='+id);
    await page.getByText(accepted.bookingReference,{exact:true}).waitFor();
    const receipt = await page.locator('#details').innerText();
    assertItinerary(receipt,accepted);
    assert.ok(receipt.includes('$22.50') && receipt.includes(total));
    assert.equal(await page.locator('#completePayment').isVisible(),true);
    await assertLayout(page);

    await signIn(await rollback.adminLogin());
    await page.goto(origin+'/admin.html');
    const dispatch = page.locator('.dispatch-card').filter({hasText:accepted.bookingReference});
    await dispatch.waitFor();
    const route = await dispatch.locator('.dispatch-route').innerText();
    assertItinerary(route,accepted);
    assert.match(route,/5 min expected · 5 min free · 0 min billable/);
    assert.ok(route.includes('$22.50') && (await dispatch.innerText()).includes(total));
    await assertLayout(page);

    await page.goto(origin+'/#book');
    await page.locator('#bookingForm').waitFor();
    assert.equal(await page.locator('#bookingStopEditor').count(),0);
    assert.equal(await page.getByRole('button',{name:/Add a Stop/}).count(),0);
    await assertLayout(page);
    assert.deepEqual(errors,[]);
  });
}