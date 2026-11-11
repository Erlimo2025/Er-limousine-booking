'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, base, queue, account, guestBooking} = require('../helpers/reservation-management.cjs');

const engine = process.env.ER_TEST_MANAGE_ENGINE || 'chromium';
const checkoutUrl = 'https://checkout.example.test/mock';
const pg = {skip: !process.env.ER_TEST_DATABASE_URL && 'Requires an isolated PostgreSQL test database'};
let browser, devices;

test.before(async () => {
  if (pg.skip) return;
  const playwright = require(process.env.ER_TEST_PLAYWRIGHT_MODULE || 'playwright');
  const executablePath = engine === 'webkit' ? process.env.ER_TEST_WEBKIT_EXECUTABLE : process.env.ER_TEST_BROWSER_EXECUTABLE;
  browser = await playwright[engine].launch({headless: true, ...(executablePath && {executablePath})});
  devices = playwright.devices;
});

test.after(async () => {
  await browser?.close();
});

async function contextFor(t, h, width) {
  const mobile = width < 500;
  const profile = devices[engine === 'webkit' ? 'iPhone 13' : 'Pixel 7'];
  const context = await browser.newContext({
    viewport: {width, height: 920},
    isMobile: mobile,
    hasTouch: mobile,
    ...(mobile && {userAgent: profile.userAgent})
  });
  t.after(() => context.close());
  await context.addInitScript(() => {
    window.manageCspFailures = [];
    document.addEventListener('securitypolicyviolation', event => window.manageCspFailures.push(event.effectiveDirective));
  });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url === checkoutUrl) return route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Test checkout</title>'});
    return new URL(url).origin === h.url ? route.continue() : route.abort();
  });
  return context;
}

async function layout(page) {
  assert.deepEqual(await page.evaluate(() => ({
    overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    csp: window.manageCspFailures
  })), {overflow: 0, csp: []});
}

for (const width of [320, 390, 1440]) {
  test(engine + ' guest verification, request decisions, payment and Dispatch at ' + width + 'px', pg, async t => {
    const fixture = await setup(t);
    const {h} = fixture;
    const id = await fixture.reserve();
    const initial = await fixture.store.get(id);
    const {bookingReference} = await fixture.store.getForDisplay(id);
    const context = await contextFor(t, h, width);
    let page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(h.url + '/');
    await page.getByRole('link', {name: 'Manage My Reservation'}).click();
    await page.getByRole('heading', {name: 'Manage My Reservation'}).waitFor();
    await layout(page);
    assert.equal(await page.locator('#manageContent').isVisible(), false);
    await page.getByLabel('Reservation reference').fill(bookingReference.toLowerCase());
    await page.getByLabel('Booking email').fill(guestBooking.email);
    await page.getByRole('button', {name: 'Email verification link'}).click();
    await page.getByText(/we’ll email a verification link/).waitFor();
    const {link, token} = await fixture.waitForInvitation();
    if (width === 1440) {
      page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(error.message));
    }
    await page.goto(link.href);
    const verify = page.getByRole('button', {name: 'Verify reservation access'});
    await verify.waitFor();
    assert.equal(new URL(page.url()).hash, '');
    assert.equal((await fixture.pool.query('SELECT used_at FROM er_reservation_management_access')).rows[0].used_at, null);
    assert.equal(await page.locator('#manageContent').isVisible(), false);
    assert.equal(await page.evaluate(() => document.cookie.includes('er_reservation_management')), false);
    const [exchange] = await Promise.all([
      page.waitForResponse(response => response.url() === h.url + base + '/verification/exchange'),
      verify.click()
    ]);
    assert.equal(exchange.status(), 200);
    const grantHeader = (await exchange.headerValues('set-cookie')).join('\n');
    assert.match(grantHeader, /Path=\/api\/booking;\s*Expires=.*;\s*HttpOnly;\s*SameSite=Strict/i);
    await page.getByRole('heading', {name: 'Reservation details'}).waitFor();
    const grant = (await context.cookies()).find(value => value.name === 'er_reservation_management');
    assert.ok(grant?.httpOnly);
    assert.equal(grant.path, '/api/booking');
    assert.equal(await page.evaluate(() => document.cookie.includes('er_reservation_management')), false);
    const display = page.locator('#manageDetails');
    await display.getByText(bookingReference, {exact: true}).waitFor();
    assert.equal(await display.getByRole('button', {name: 'Copy booking reference ' + bookingReference}).isVisible(), true);
    await display.getByText('11/10/2026 · 1:00 PM (New York time)', {exact: true}).waitFor();
    await display.getByText('Unpaid', {exact: true}).waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes(guestBooking.email));
    assert.ok(!(await page.content()).includes(token));
    await layout(page);

    await page.getByLabel('Request type').selectOption('locations');
    const requested = '500 Example Road, Newark, NJ';
    await page.getByLabel('Requested pickup (optional)').fill(requested);
    await page.getByLabel('I confirm that I’m sending this request for review.').check();
    await page.getByRole('button', {name: 'Send request'}).click();
    await page.getByText('A request is awaiting owner review.').waitFor();
    assert.equal(await page.locator('#manageRequestForm').isVisible(), false);

    const adminContext = await contextFor(t, h, width);
    const dispatch = await adminContext.newPage();
    dispatch.on('pageerror', error => errors.push(error.message));
    await dispatch.goto(h.url + '/admin.html');
    const panel = dispatch.locator('#reservationRequestsPanel');
    assert.equal(await panel.isVisible(), false);
    await dispatch.getByLabel('Admin credential').fill('local-test-token');
    await dispatch.getByRole('button', {name: 'Admin login'}).click();
    await dispatch.getByLabel('Search reservations').fill(bookingReference.toLowerCase());
    const [search] = await Promise.all([
      dispatch.waitForResponse(response => new URL(response.url()).searchParams.get('search') === bookingReference.toLowerCase()),
      dispatch.getByRole('button', {name: 'Search / Apply Filters'}).click()
    ]);
    assert.equal(search.status(), 200);
    const card = dispatch.locator('#bookings .dispatch-card');
    await card.getByText(bookingReference, {exact: false}).waitFor();
    assert.equal(await card.getAttribute('data-id'), id);
    await panel.locator('summary').click();
    await panel.getByText('Reservation ' + bookingReference + ' · guest', {exact: true}).waitFor();
    await panel.getByText('Requested pickup: ' + requested, {exact: true}).waitFor();
    await layout(dispatch);
    dispatch.once('dialog', dialog => dialog.dismiss());
    await panel.getByRole('button', {name: 'Approve request'}).click();
    assert.equal((await fixture.pool.query('SELECT status FROM er_reservation_management_requests')).rows[0].status, 'pending');
    dispatch.once('dialog', dialog => dialog.accept());
    await panel.getByRole('button', {name: 'Approve request'}).click();
    await panel.getByText('Decision recorded.', {exact: true}).waitFor();
    await panel.getByLabel('Request status').selectOption('approved');
    await panel.getByText(/Decision recorded.*Admin/).waitFor();
    await dispatch.getByRole('button', {name: 'Admin logout'}).click();
    await panel.waitFor({state: 'hidden'});
    assert.equal(await panel.locator('article').count(), 0);
    assert.deepEqual(await fixture.store.get(id), initial);

    await page.getByRole('button', {name: 'Refresh status'}).click();
    await page.getByText('Pickup or destination change · Approved', {exact: true}).waitFor();
    assert.ok(!(await display.innerText()).includes(requested));
    const pay = page.getByRole('button', {name: 'Complete Payment'});
    await Promise.all([page.waitForURL(checkoutUrl), pay.click()]);
    assert.equal(h.state.creates.length, 1);
    const session = [...h.state.sessions.values()][0];
    assert.equal(session.amount_total, Math.round(initial.quote.total * 100));
    session.status = 'complete';
    session.payment_status = 'paid';
    assert.equal((await h.webhook(session)).status, 200);
    await page.goto(h.url + '/manage-reservation.html');
    await display.getByText('Paid', {exact: true}).waitFor();
    assert.equal(await pay.isVisible(), false);
    await page.getByRole('button', {name: 'End guest access'}).click();
    await page.getByText('Guest access ended.').waitFor();
    assert.equal(await page.locator('#manageContent').isVisible(), false);
    assert.ok(!(await page.content()).includes(id));
    assert.deepEqual(errors, []);
    await layout(page);
  });
}

test(engine + ' signed-in customer opens the new page from My Trips without changing the existing actions', pg, async t => {
  const fixture = await setup(t);
  const owner = await fixture.register();
  const id = await fixture.reserve(owner, {email: account.email});
  const context = await contextFor(t, fixture.h, 390);
  const page = await context.newPage();
  await page.goto(fixture.h.url + '/account.html');
  const login = page.locator('#loginForm');
  await login.getByLabel('Email Address', {exact: true}).fill(account.email);
  await login.getByLabel('Password', {exact: true}).fill(account.password);
  await login.getByRole('button', {name: 'LOG IN', exact: true}).click();
  const trip = page.locator('#tripsList');
  await trip.getByText('Manage Trip', {exact: true}).click();
  await trip.getByRole('link', {name: 'Manage My Reservation'}).click();
  assert.equal(new URL(page.url()).searchParams.get('reservation'), id);
  const {bookingReference} = await fixture.store.getForDisplay(id);
  await page.locator('#manageDetails').getByText(bookingReference, {exact: true}).waitFor();
  assert.equal(await page.locator('#manageSignOut').isVisible(), false);
  await page.getByLabel('Request type').selectOption('pickup_schedule');
  await page.getByLabel('Pickup date', {exact: true}).fill('2026-11-11');
  await page.getByLabel('Pickup time (New York)').fill('15:00');
  await page.getByLabel('I confirm that I’m sending this request for review.').check();
  await page.getByRole('button', {name: 'Send request'}).click();
  await page.getByText('Pickup date or time change · Pending review', {exact: true}).waitFor();
  const [{id: requestId}] = (await fixture.pool.query('SELECT id FROM er_reservation_management_requests')).rows;
  const admin = await fixture.adminLogin();
  assert.equal((await fixture.post(queue + '/' + requestId + '/decision', {status: 'declined', confirmed: true}, admin)).status, 200);
  await page.getByRole('button', {name: 'Refresh status'}).click();
  await page.getByText('Pickup date or time change · Declined', {exact: true}).waitFor();
  assert.equal((await fixture.store.get(id)).trip.date, '2026-11-10');
  assert.equal(fixture.h.state.creates.length, 0);
  await layout(page);
  assert.equal((await fixture.get(base + '/account/' + id)).status, 401);
});
