'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {setup, account, guestBooking} = require('../helpers/reservation-management.cjs');

const engine = process.env.ER_TEST_ACCOUNT_RESERVATION_ENGINE || process.env.ER_TEST_MANAGE_ENGINE || 'chromium';
const pg = {skip: !process.env.ER_TEST_DATABASE_URL && 'Requires an isolated PostgreSQL test database'};
const checkoutUrl = 'https://checkout.example.test/mock';
const otherAccount = {
  ...account, fullName: 'Second Test Owner', email: 'manage-other@example.test', phone: '2015550183'
};
let browser;

test.before(async () => {
  if (pg.skip) return;
  assert.ok(['chromium', 'webkit'].includes(engine));
  const playwright = require(process.env.ER_TEST_PLAYWRIGHT_MODULE || 'playwright');
  const executablePath = engine === 'webkit'
    ? process.env.ER_TEST_WEBKIT_EXECUTABLE : process.env.ER_TEST_BROWSER_EXECUTABLE;
  browser = await playwright[engine].launch({headless: true, ...(executablePath && {executablePath})});
});

test.after(async () => {
  await browser?.close();
});

async function contextFor(t, origin, width) {
  const mobile = width < 500;
  const context = await browser.newContext({
    viewport: {width, height: 920}, isMobile: mobile, hasTouch: mobile
  });
  t.after(() => context.close());
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url === checkoutUrl) {
      return route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Mock Checkout</title>'});
    }
    return new URL(url).origin === origin ? route.continue() : route.abort();
  });
  return context;
}

async function signIn(page, credentials) {
  await page.locator('#loginEmail').fill(credentials.email);
  await page.locator('#loginPassword').fill(credentials.password);
  const [response] = await Promise.all([
    page.waitForResponse(result => new URL(result.url()).pathname === '/api/customer/login'),
    page.locator('#loginForm button[type="submit"]').click()
  ]);
  assert.equal(response.status(), 200);
  await page.locator('#dashboardView').waitFor();
  assert.equal(new URL(page.url()).pathname, '/account/dashboard');
}

async function signOut(page) {
  await page.getByRole('button', {name: 'Customer menu'}).click();
  const [response] = await Promise.all([
    page.waitForResponse(result => new URL(result.url()).pathname === '/api/customer/logout'),
    page.getByRole('button', {name: 'Log Out'}).click()
  ]);
  assert.equal(response.status(), 200);
  await page.locator('#loginView').waitFor();
}

async function reserveUsingBrowser(page, booking) {
  // Create a genuine reservation-scoped browser cookie through isolated HTTP.
  const {quoteStatus, status, result} = await page.evaluate(async input => {
    const post = (path, body) => fetch(path, {
      method: 'POST', credentials: 'same-origin',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
    });
    const quoteResponse = await post('/api/quote', input);
    if (!quoteResponse.ok) return {quoteStatus: quoteResponse.status};
    const {quoteApproval, quoteRevision} = await quoteResponse.json();
    const response = await post('/api/checkout', {...input, quoteApproval, quoteRevision, paymentChoice: 'later'});
    return {quoteStatus: quoteResponse.status, status: response.status, result: await response.json()};
  }, booking);
  assert.equal(quoteStatus, 200);
  assert.equal(status, 200);
  assert.match(result.bookingId, /^[a-f0-9-]{36}$/);
  return result;
}

async function showConfirmation(page, bookingReference) {
  const details = page.locator('#details');
  await details.getByText(bookingReference, {exact: true}).waitFor();
  await details.getByText(guestBooking.pickup, {exact: true}).waitFor();
  assert.ok(await page.locator('#completePayment').isVisible());
}

async function denyConfirmation(page) {
  await page.getByText('Unable to load this reservation. Please retry.', {exact: true}).waitFor();
  assert.equal(await page.locator('#details').innerText(), '');
  assert.equal(await page.locator('#completePayment').isVisible(), false);
}

for (const width of [390, 1440]) {
  test(engine + ' owner confirmation follows logout, account switch and relogin across tabs at ' + width + 'px', pg, async t => {
    const fixture = await setup(t);
    await fixture.register();
    await fixture.register(otherAccount);
    const context = await contextFor(t, fixture.h.url, width);
    const accountTab = await context.newPage();
    const confirmationTab = await context.newPage();

    await accountTab.goto(fixture.h.url + '/account.html');
    await signIn(accountTab, account);
    const result = await reserveUsingBrowser(accountTab, {...guestBooking, email: account.email, phone: account.phone});
    const id = result.bookingId;
    const owner = await fixture.store.customerByEmail(account.email);
    assert.equal(await fixture.store.reservationOwner(id), owner.id);
    const {bookingReference, quote} = await fixture.store.getForDisplay(id);
    const bookingCookie = async () => (await context.cookies()).find(cookie => cookie.name === 'er_booking_access_' + id);
    const original = await bookingCookie();
    assert.ok(original?.httpOnly);
    const confirmationUrl = fixture.h.url + '/success.html?booking=' + id;

    await confirmationTab.goto(confirmationUrl);
    await showConfirmation(confirmationTab, bookingReference);

    await signOut(accountTab);
    assert.ok((await bookingCookie())?.value === original.value, 'The reservation cookie remains after logout');
    assert.ok((await context.cookies()).every(cookie => cookie.name !== 'er_customer_session'));
    await confirmationTab.reload();
    await denyConfirmation(confirmationTab);

    await signIn(accountTab, otherAccount);
    await confirmationTab.locator('#refreshReservation').click();
    await denyConfirmation(confirmationTab);

    await signOut(accountTab);
    await signIn(accountTab, account);
    await confirmationTab.locator('#refreshReservation').click();
    await showConfirmation(confirmationTab, bookingReference);
    if (width === 1440) {
      await context.clearCookies({name: original.name});
      await confirmationTab.reload();
      await showConfirmation(confirmationTab, bookingReference);
    }
    assert.equal(fixture.h.state.creates.length, 0);

    await Promise.all([
      confirmationTab.waitForURL(checkoutUrl),
      confirmationTab.locator('#completePayment').click()
    ]);
    assert.equal(fixture.h.state.creates.length, 1);
    assert.equal(fixture.h.state.creates[0].params.line_items[0].price_data.unit_amount,
      Math.round(quote.total * 100));
  });
}

test(engine + ' guest confirmation accepts the booking cookie or the booking-scoped email grant', pg, async t => {
  const fixture = await setup(t);
  const browserContext = await contextFor(t, fixture.h.url, 390);
  const original = await browserContext.newPage();
  await original.goto(fixture.h.url + '/account.html');
  const result = await reserveUsingBrowser(original, guestBooking);
  assert.equal(await fixture.store.reservationOwner(result.bookingId), null);
  const {bookingReference, quote} = await fixture.store.getForDisplay(result.bookingId);
  const confirmationUrl = fixture.h.url + '/success.html?booking=' + result.bookingId;
  await original.goto(confirmationUrl);
  await showConfirmation(original, bookingReference);

  const freshContext = await contextFor(t, fixture.h.url, 390);
  const fresh = await freshContext.newPage();
  await fresh.goto(confirmationUrl);
  await denyConfirmation(fresh);
  await fixture.requestVerification(bookingReference);
  const {link} = await fixture.waitForInvitation();
  await fresh.goto(link.href);
  await fresh.getByRole('button', {name: 'Verify reservation access'}).click();
  await fresh.getByRole('heading', {name: 'Reservation details'}).waitFor();
  await fresh.goto(confirmationUrl);
  await showConfirmation(fresh, bookingReference);
  assert.ok((await freshContext.cookies()).every(cookie => cookie.name !== 'er_customer_session'));

  await Promise.all([fresh.waitForURL(checkoutUrl), fresh.locator('#completePayment').click()]);
  assert.equal(fixture.h.state.creates.length, 1);
  assert.equal(fixture.h.state.creates[0].params.line_items[0].price_data.unit_amount,
    Math.round(quote.total * 100));
});
