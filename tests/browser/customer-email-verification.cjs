'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const {setTimeout: delay} = require('node:timers/promises');
const {harness} = require('../helpers/reservation-management.cjs');

const engine = process.env.ER_TEST_ENROLLMENT_ENGINE || 'chromium';
const account = {
  firstName: 'Zoë',
  lastName: 'O’Neill',
  email: 'enrollment-browser@example.test',
  phone: '2015550187',
  password: 'Synthetic enrollment browser password'
};
let browser;

test.before(async () => {
  const playwright = require(process.env.ER_TEST_PLAYWRIGHT_MODULE || 'playwright');
  assert.ok(['chromium', 'webkit'].includes(engine));
  const executablePath = engine === 'webkit'
    ? process.env.ER_TEST_WEBKIT_EXECUTABLE : process.env.ER_TEST_BROWSER_EXECUTABLE;
  browser = await playwright[engine].launch({headless: true, ...(executablePath && {executablePath})});
});

test.after(async () => {
  await browser?.close();
});

async function start(t) {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return harness(t, {PORT: String(port), SITE_URL: 'http://127.0.0.1:' + port, BOOKING_EMAILS_ENABLED: 'true'});
}

async function contextFor(t, h, width) {
  const mobile = width < 500;
  const context = await browser.newContext({viewport: {width, height: 900}, isMobile: mobile, hasTouch: mobile});
  t.after(() => context.close());
  await context.route('**/*', route => new URL(route.request().url()).origin === h.url ? route.continue() : route.abort());
  return context;
}

async function sent(h, index = 0) {
  for (let attempt = 0; attempt < 100 && !h.state.enrollmentMessages[index]; attempt++) await delay(20);
  const message = h.state.enrollmentMessages[index];
  assert.ok(message, 'Expected a synthetic enrollment email');
  assert.match(message.token, /^[A-Za-z0-9_-]{43}$/);
  return message;
}

async function checkLayout(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
}

async function register(page) {
  await page.locator('#registerFirstName').fill(account.firstName);
  await page.locator('#registerLastName').fill(account.lastName);
  await page.locator('#registerEmail').fill(account.email);
  await page.locator('#phone').fill(account.phone);
  await page.locator('#registerPassword').fill(account.password);
  await checkLayout(page);
  const [response] = await Promise.all([
    page.waitForResponse(result => new URL(result.url()).pathname === '/api/customer/register'),
    page.locator('#registerForm button[type=submit]').click()
  ]);
  assert.equal(response.status(), 202);
  await page.locator('#enrollmentPending').waitFor();
  assert.equal(new URL(page.url()).hash, '#check-email');
  return response;
}

async function confirm(page, h, message) {
  await page.goto(h.url + '/verify-customer-email.html#' + (message.existing ? 'verify-profile=' : 'token=') + message.token);
  await page.locator('#emailVerificationSubmit').waitFor();
  assert.equal(new URL(page.url()).hash, '');
  await checkLayout(page);
}

for (const width of [320, 375, 390, 430, 1440]) {
  test(engine + ' ' + width + 'px customer verifies a new account before it becomes active', async t => {
    const h = await start(t);
    const first = await contextFor(t, h, width);
    const tab = await first.newPage();
    const errors = [];
    tab.on('pageerror', error => errors.push(error.message));
    await tab.goto(h.url + '/account.html#create');
    const registration = await register(tab);
    const enrollmentCookie = (await registration.headersArray()).find(
      header => header.name.toLowerCase() === 'set-cookie' && /^er_customer_enrollment=/.test(header.value)
    );
    assert.match(enrollmentCookie?.value || '', /; HttpOnly; SameSite=Strict$/i);
    assert.equal(await tab.locator('#registerPassword').inputValue(), '');
    assert.equal((await first.cookies()).some(cookie => cookie.name.endsWith('er_customer_session')), false);
    await tab.reload();
    await tab.locator('#enrollmentPending').waitFor();
    await checkLayout(tab);

    let message = await sent(h);
    assert.equal(message.email, account.email);
    assert.equal(message.existing, false);
    if (width === 320) {
      h.advance(61000);
      await tab.locator('#enrollmentResend').click();
      await tab.getByText('If verification can proceed, an email with a new link will be sent.').waitFor();
      const resent = await sent(h, 1);
      assert.notEqual(resent.token, message.token);
      message = resent;
    }

    const second = width === 390 ? await contextFor(t, h, width) : first;
    const verify = await second.newPage();
    verify.on('pageerror', error => errors.push(error.message));
    await confirm(verify, h, message);
    assert.equal((await second.cookies()).some(cookie => cookie.name.endsWith('er_customer_session')), false);
    const confirmResponse = () => verify.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/customer/enrollment/confirm');
    const submit = () => verify.locator('#emailVerificationSubmit').click();
    let [confirmation] = await Promise.all([confirmResponse(), submit()]);
    if (second !== first) {
      assert.equal(confirmation.status(), 400);
      await verify.locator('#emailVerificationPassword').fill(account.password);
      [confirmation] = await Promise.all([confirmResponse(), submit()]);
    }
    assert.equal(confirmation.status(), 201);
    const sessionCookie = (await confirmation.headersArray()).find(
      header => header.name.toLowerCase() === 'set-cookie' && /^er_customer_session=/.test(header.value)
    );
    assert.match(sessionCookie?.value || '', /; HttpOnly; SameSite=Strict$/i);
    await verify.waitForURL(h.url + '/account/dashboard');
    await verify.getByText(account.firstName + ' ' + account.lastName, {exact: true}).waitFor();
    assert.equal(await verify.locator('#emailVerificationReminder').isVisible(), false);
    const session = (await second.cookies()).find(cookie => cookie.name.endsWith('er_customer_session'));
    assert.equal(session?.httpOnly, true);
    assert.deepEqual(errors, []);
    await checkLayout(verify);
  });
}

test(engine + ' an expired enrollment link leaves the account inactive and allows a fresh registration', async t => {
  const h = await start(t);
  const context = await contextFor(t, h, 390);
  const page = await context.newPage();
  await page.goto(h.url + '/account.html#create');
  await register(page);
  const expired = await sent(h);
  h.advance(31 * 60000);
  await confirm(page, h, expired);
  const [rejection] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/customer/enrollment/confirm'),
    page.locator('#emailVerificationSubmit').click()
  ]);
  assert.equal(rejection.status(), 400);
  const restart = page.locator('#emailVerificationRestart');
  await restart.waitFor();
  assert.match(await page.locator('#emailVerificationStatus').textContent(), /invalid, expired, or has already been used/);
  assert.equal(await page.locator('#emailVerificationForm').isVisible(), false);
  assert.equal((await context.cookies()).some(cookie => cookie.name.endsWith('er_customer_session')), false);
  assert.equal((await context.request.get(h.url + '/api/customer/profile')).status(), 401);
  await restart.click();
  await page.waitForURL(h.url + '/account.html#create');
  await register(page);
  const fresh = await sent(h, 1);
  assert.equal(fresh.email, expired.email);
  assert.notEqual(fresh.token, expired.token);
  await confirm(page, h, fresh);
  await page.locator('#emailVerificationSubmit').click();
  await page.waitForURL(h.url + '/account/dashboard');
  await page.getByText(account.firstName + ' ' + account.lastName, {exact: true}).waitFor();
});

test(engine + ' existing account can verify email from its dashboard without replacing its session', async t => {
  const h = await start(t);
  const context = await contextFor(t, h, 390);
  const legacy = {fullName: 'Existing Member', email: account.email, phone: account.phone, password: account.password};
  assert.equal((await h.seedCustomer(legacy)).status, 201);
  assert.equal((await context.request.post(h.url + '/api/customer/login', {
    data: {email: legacy.email, password: legacy.password}
  })).status(), 200);
  const page = await context.newPage();
  await page.goto(h.url + '/account/dashboard');
  await page.locator('#emailVerificationReminder').waitFor();
  const session = (await context.cookies()).find(cookie => cookie.name.endsWith('er_customer_session'));
  await page.locator('#requestEmailVerification').click();
  const message = await sent(h);
  assert.equal(message.existing, true);
  await confirm(page, h, message);
  await page.locator('#emailVerificationSubmit').click();
  await page.waitForURL(h.url + '/account/dashboard');
  await page.getByText(legacy.fullName, {exact: true}).waitFor();
  assert.equal(await page.locator('#emailVerificationReminder').isVisible(), false);
  const refreshed = (await context.cookies()).find(cookie => cookie.name.endsWith('er_customer_session'));
  assert.equal(refreshed.value, session.value);
});
