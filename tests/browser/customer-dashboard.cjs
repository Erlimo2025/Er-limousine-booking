'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {setup, account} = require('../helpers/reservation-management.cjs');

const engine = process.env.ER_TEST_DASHBOARD_ENGINE || 'chromium';
const pg = {skip: !process.env.ER_TEST_DATABASE_URL && 'Requires an isolated PostgreSQL test database'};
const checkout = 'https://checkout.example.test/mock';
const customer = {...account, fullName: 'Avery Morgan', email: 'avery@example.test'};
const foreignCustomer = {...account, fullName: 'Separate Account', email: 'other@example.test', phone: '2015550184'};
let browser;

test.before(async () => {
  if (pg.skip) return;
  const playwright = require(process.env.ER_TEST_PLAYWRIGHT_MODULE || 'playwright');
  const executablePath = engine === 'webkit' ? process.env.ER_TEST_WEBKIT_EXECUTABLE : process.env.ER_TEST_BROWSER_EXECUTABLE;
  browser = await playwright[engine].launch({headless: true, ...(executablePath && {executablePath})});
});
test.after(async () => { await browser?.close(); });

async function seed(t) {
  const f = await setup(t, {
    RESERVATION_SELF_SERVICE_ENABLED: 'false',
    RESERVATION_AUTO_CANCELLATIONS_ENABLED: 'false'
  });
  const owner = await f.register(customer);
  const reserve = (date, time, pickup, dropoff, vehicle = 'escalade') =>
    f.reserve(owner, {email: customer.email, phone: customer.phone, date, time, pickup, dropoff, vehicle});
  const upcoming = await reserve('2026-11-18', '14:30', 'Newark Liberty International Airport', '350 Fifth Avenue, New York, NY', 'suv');
  const confirmed = await reserve('2026-11-22', '10:15', '140 Broadway, New York, NY', 'Newark Liberty International Airport');
  const past = await reserve('2026-10-02', '14:30', '100 International Boulevard, Elizabeth, NJ', '455 Madison Avenue, New York, NY');
  const cancelled = await reserve('2026-11-09', '09:00', '1 Hotel Road, Newark, NJ', '20 West 34th Street, New York, NY');
  const cancelledPast = await reserve('2026-10-03', '14:30', '2 Penn Plaza, New York, NY', 'Newark Penn Station');
  for (const id of [confirmed, past]) {
    assert.equal((await f.post('/api/customer/trips/' + id + '/payment', {}, owner)).status, 200);
    const record = await f.store.get(id);
    const session = f.h.state.sessions.get(record.stripeSessionId);
    session.status = 'complete';
    session.payment_status = 'paid';
    assert.equal((await f.h.webhook(session)).status, 200);
  }
  await f.store.update(past, record => { record.status = 'completed'; });
  for (const id of [cancelled, cancelledPast]) {
    const record = await f.store.get(id);
    await f.store.withActionLock(record.checkoutFingerprint, () =>
      f.store.update(id, trip => { trip.status = 'cancelled'; })
    );
  }
  const other = await f.register(foreignCustomer);
  const foreign = await f.reserve(other, {email: foreignCustomer.email, phone: foreignCustomer.phone, time: '16:00'});
  const guest = await f.reserve(null, {time: '17:00'});
  f.h.advance(4 * 24 * 60 * 60 * 1000);
  assert.equal((await f.get('/api/customer/trips/' + foreign, owner)).status, 404);
  assert.equal((await f.get('/api/customer/trips/' + guest, owner)).status, 404);
  return {...f, upcoming, confirmed, past, cancelled, cancelledPast, foreign, guest};
}

async function screenshot(page, name, fullPage = true) {
  const directory = process.env.ER_TEST_DASHBOARD_SCREENSHOTS_DIR;
  if (!directory || engine !== 'chromium') return;
  fs.mkdirSync(directory, {recursive: true});
  await page.screenshot({path: path.join(directory, name + '.png'), fullPage, animations: 'disabled'});
}

for (const width of [320, 390, 430, 1440]) {
  test(engine + ' dashboard navigation and private reservation actions at ' + width + 'px', {...pg, timeout: 90000}, async t => {
    const f = await seed(t);
    const mobile = width < 500;
    const context = await browser.newContext({viewport: {width, height: mobile ? 812 : 1000}, isMobile: mobile, hasTouch: mobile});
    t.after(() => context.close());
    await context.addInitScript(() => {
      window.dashboardCspFailures = [];
      Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => {
        if (innerWidth === 320) throw new Error('Clipboard unavailable');
        window.copiedBookingReference = text;
      }}});
      document.addEventListener('securitypolicyviolation', event => window.dashboardCspFailures.push(event.effectiveDirective));
    });
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url === checkout) return route.fulfill({contentType: 'text/html', body: '<title>Isolated checkout</title>'});
      return new URL(url).origin === f.h.url ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const activate = locator => mobile ? locator.tap() : locator.click();
    const layout = async () => {
      assert.deepEqual(await page.evaluate(() => ({
        overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
        csp: window.dashboardCspFailures
      })), {overflow: 0, csp: []});
      assert.deepEqual(errors, []);
    };
    const toggle = page.getByRole('button', {name: 'Customer menu'});
    const menu = page.getByRole('navigation', {name: 'Customer dashboard'});
    const cards = page.locator('#tripsList .trip-card');
    const finished = () => page.waitForFunction(() => document.getElementById('tripsList').getAttribute('aria-busy') === 'false');
    const menuTo = async name => {
      await activate(toggle);
      await activate(menu.getByRole('button', {name, exact: true}));
      await finished();
      assert.equal(await menu.isVisible(), false);
    };

    await page.goto(f.h.url + '/account.html');
    assert.equal(await toggle.isVisible(), false);
    const login = page.locator('#loginForm');
    await login.getByLabel('Email Address', {exact: true}).fill(customer.email);
    await login.getByLabel('Password', {exact: true}).fill(customer.password);
    await activate(login.getByRole('button', {name: 'LOG IN', exact: true}));
    await page.getByRole('heading', {name: 'Welcome, Avery', exact: true}).waitFor();
    await finished();
    assert.equal(await cards.count(), 2);
    assert.equal(await page.getByText('Travel in comfort.', {exact: true}).count(), 0);
    assert.ok(await page.locator('#profile').evaluate(element =>
      !!(document.getElementById('tripsPanel').compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)));
    const first = cards.first();
    assert.match(await first.locator('.trip-date').innerText(), /11\/18\/2026 · 2:30 PM/);
    assert.deepEqual(await first.locator('.trip-address').allTextContents(), [
      'Newark Liberty International Airport', '350 Fifth Avenue, New York, NY'
    ]);
    assert.equal(await first.locator('.trip-vehicle').innerText(), 'Luxury SUV');
    const accepted = await f.store.getForDisplay(f.upcoming);
    assert.equal(await first.locator('.trip-reference-row .booking-reference-value').innerText(), accepted.bookingReference);
    const copy = first.getByRole('button', {name: 'Copy booking reference ' + accepted.bookingReference});
    await activate(copy);
    if (width === 320) {
      await first.getByText(/Use your device/).waitFor();
      assert.equal(await page.evaluate(() => getSelection().toString()), accepted.bookingReference);
    } else {
      await first.getByText('Copied', {exact: true}).waitFor();
      assert.equal(await page.evaluate(() => window.copiedBookingReference), accepted.bookingReference);
    }
    const formattedFare = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(accepted.quote.total);
    assert.equal(await first.locator('.trip-total').innerText(), formattedFare);
    assert.deepEqual(await first.locator('.trip-badge').allTextContents(), ['Payment Pending', 'Unpaid']);
    assert.equal(await cards.nth(1).getByRole('button', {name: 'Complete Payment', exact: true}).count(), 0);
    for (const id of [f.guest, f.foreign, f.past, f.cancelled, f.cancelledPast]) assert.ok(!(await page.content()).includes(id));
    await layout();
    await screenshot(page, 'dashboard-' + width);

    await activate(toggle);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await menu.locator('a,button').allTextContents(), [
      'Dashboard', 'Upcoming Trips', 'Past Trips', 'Cancelled Trips', 'Reservation Requests',
      'Complete Payment', 'My Profile', 'Book a New Ride', 'Log Out'
    ]);
    assert.equal(await menu.getByRole('link', {name: 'Book a New Ride'}).getAttribute('href'), '/#book');
    const menuBox = await menu.boundingBox();
    assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= width);
    assert.ok((await menu.locator('button').first().boundingBox()).height >= 44);
    await screenshot(page, 'menu-' + width, false);
    await page.keyboard.press('Escape');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await toggle.evaluate(element => element === document.activeElement), true);
    await activate(toggle);
    if (mobile) await page.touchscreen.tap(5, 90);
    else await page.mouse.click(5, 90);
    assert.equal(await menu.isVisible(), false);
    await activate(toggle);
    await activate(toggle);
    assert.equal(await menu.isVisible(), false);

    await menuTo('Past Trips');
    assert.equal(await page.locator('#pastTrips').getAttribute('aria-pressed'), 'true');
    assert.equal(await cards.count(), 1);
    assert.equal(await cards.first().getByRole('link', {name: 'Book Again'}).getAttribute('href'), '/?bookAgain=' + f.past + '#book');
    await activate(page.locator('#cancelledTrips'));
    await finished();
    assert.equal(await cards.count(), 2);
    assert.equal(await cards.getByText('Cancelled', {exact: true}).count(), 2);
    assert.equal(await cards.getByRole('button', {name: 'Complete Payment', exact: true}).count(), 0);
    await menuTo('Cancelled Trips');
    assert.equal(await page.locator('#cancelledTrips').getAttribute('aria-pressed'), 'true');
    await menuTo('Upcoming Trips');
    await activate(first.getByText('View Trip Details', {exact: true}));
    const detailReference = first.locator('.trip-details .booking-reference-value');
    await detailReference.waitFor();
    await first.locator('.trip-reference-row').waitFor({state: 'hidden'});
    assert.equal(await detailReference.innerText(), accepted.bookingReference);
    assert.equal(await first.getByRole('button', {name: 'Copy booking reference ' + accepted.bookingReference}).count(), 1);
    assert.equal(await first.getByText(f.upcoming, {exact: true}).isVisible(), false);
    await activate(first.getByText('View Trip Details', {exact: true}));
    await activate(first.getByText('Manage Trip', {exact: true}));
    assert.equal(await first.getByRole('button', {name: 'Change Pickup Time'}).isVisible(), true);
    assert.equal(await first.getByRole('button', {name: 'Cancel Trip', exact: true}).isVisible(), true);
    assert.equal(await first.getByRole('link', {name: 'Manage My Reservation'}).getAttribute('href'),
      '/manage-reservation.html?reservation=' + f.upcoming);

    await menuTo('Reservation Requests');
    await page.getByRole('heading', {name: 'Reservation Requests', exact: true}).waitFor();
    assert.equal(await cards.getByRole('link', {name: 'View Requests'}).count(), 5);
    const requestPath = '/manage-reservation.html?reservation=' + f.upcoming + '#manageRequestsHeading';
    const requestsLink = cards.locator('a[href="' + requestPath + '"]');
    assert.equal(await requestsLink.getAttribute('href'), requestPath);
    await Promise.all([
      page.waitForURL(url => url.pathname === '/manage-reservation.html' && url.searchParams.get('reservation') === f.upcoming,
        {waitUntil: 'domcontentloaded'}).catch(error => {
        throw new Error('Reservation requests navigation ended at ' + page.url(), {cause: error});
      }),
      activate(requestsLink)
    ]);
    await page.getByRole('heading', {name: 'Reservation requests', exact: true}).waitFor();
    assert.equal(await page.locator('#manageDetails').getByText(accepted.bookingReference, {exact: true}).isVisible(), true);
    assert.equal(await page.locator('#manageRequestForm').isVisible(), true);
    assert.equal(await page.locator('#managedActions').isVisible(), false);

    await page.goto(f.h.url + '/account/dashboard');
    await toggle.waitFor();
    await activate(toggle);
    await Promise.all([
      page.waitForURL(url => url.hash === '#profile'),
      activate(menu.getByRole('link', {name: 'My Profile'}))
    ]);
    assert.equal(await menu.isVisible(), false);
    await page.getByRole('heading', {name: 'My Profile'}).waitFor();
    assert.equal(await page.locator('#profileName').innerText(), customer.fullName);
    await activate(page.getByRole('button', {name: 'Edit Profile'}));
    assert.equal(await page.locator('#editEmail').getAttribute('readonly'), '');
    await activate(page.locator('#cancelProfile'));
    await menuTo('Dashboard');
    assert.equal(await page.locator('#upcomingTrips').getAttribute('aria-pressed'), 'true');

    await menuTo('Complete Payment');
    assert.equal(await cards.count(), 1);
    const pay = cards.getByRole('button', {name: 'Complete Payment', exact: true});
    assert.equal(await pay.count(), 1);
    const sessions = f.h.state.creates.length;
    await Promise.all([page.waitForURL(checkout), activate(pay)]);
    assert.equal(f.h.state.creates.length, sessions + 1);
    assert.equal(f.h.state.creates.at(-1).params.line_items[0].price_data.unit_amount, Math.round(accepted.quote.total * 100));
    assert.deepEqual((await f.store.get(f.upcoming)).quote, accepted.quote);

    await page.goto(f.h.url + '/account/dashboard');
    await toggle.waitFor();
    await finished();
    await activate(cards.first().getByText('Manage Trip', {exact: true}));
    await activate(cards.first().getByRole('button', {name: 'Cancel Trip', exact: true}));
    await activate(cards.first().getByRole('button', {name: 'Confirm Cancellation'}));
    await page.getByText('Your trip has been cancelled.', {exact: true}).waitFor();
    assert.equal(await cards.count(), 1);
    await activate(page.locator('#cancelledTrips'));
    await finished();
    assert.equal(await cards.count(), 3);
    assert.equal(await cards.getByRole('button', {name: 'Complete Payment', exact: true}).count(), 0);
    assert.deepEqual((await f.store.get(f.upcoming)).quote, accepted.quote);
    assert.equal(f.h.state.refundRequests.length, 0);

    await activate(toggle);
    await activate(menu.getByRole('button', {name: 'Log Out'}));
    await page.getByRole('heading', {name: 'Welcome Back', exact: true}).waitFor();
    assert.equal(await toggle.isVisible(), false);
    assert.equal(await cards.count(), 0);
    assert.equal((await page.request.get(f.h.url + '/api/customer/trips')).status(), 401);
    await layout();
  });
}
