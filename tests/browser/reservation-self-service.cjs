'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {setup, account, base} = require('../helpers/reservation-management.cjs');
const engine = process.env.ER_TEST_MANAGE_ENGINE || 'chromium';
const pg = {skip: !process.env.ER_TEST_DATABASE_URL && 'Requires an isolated PostgreSQL test database', timeout: 45000};
let browser, devices;

test.before(async () => {
  if (pg.skip) return;
  const playwright = require(process.env.ER_TEST_PLAYWRIGHT_MODULE || 'playwright');
  const executablePath = engine === 'webkit' ? process.env.ER_TEST_WEBKIT_EXECUTABLE : process.env.ER_TEST_BROWSER_EXECUTABLE;
  browser = await playwright[engine].launch({headless: true, ...(executablePath && {executablePath})});
  devices = playwright.devices;
});
test.after(async () => {await browser?.close();});

async function pageFor(t, h, width) {
  const mobile = width < 500;
  const profile = devices[engine === 'webkit' ? 'iPhone 13' : 'Pixel 7'];
  const context = await browser.newContext({viewport: {width, height: 920}, isMobile: mobile, hasTouch: mobile,
    ...(mobile && {userAgent: profile.userAgent})});
  t.after(() => context.close());
  await context.addInitScript(() => {
    window.reservationCspFailures = [];
    document.addEventListener('securitypolicyviolation', event => window.reservationCspFailures.push(event.effectiveDirective));
  });
  await context.route('**/*', route => new URL(route.request().url()).origin === h.url ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  return {page, context};
}

async function layout(page, width) {
  const result = await page.evaluate(() => ({width: document.documentElement.scrollWidth, csp: window.reservationCspFailures}));
  assert.ok(result.width <= width, 'Page overflows at ' + width + 'px');
  assert.deepEqual(result.csp, []);
}

async function paid(f, id, owner) {
  const path = owner && !owner.includes('er_reservation_management=') ? '/api/customer/trips/' + id + '/payment' : '/api/booking/' + id + '/checkout';
  assert.equal((await f.post(path, {}, owner)).status, 200);
  const session = [...f.h.state.sessions.values()].at(-1);
  session.status = 'complete';
  session.payment_status = 'paid';
  assert.equal((await f.h.webhook(session)).status, 200);
}

async function dispatch(t, f, width) {
  const {page} = await pageFor(t, f.h, width);
  await page.goto(f.h.url + '/admin.html');
  await page.getByLabel('Admin credential').fill('local-test-token');
  await page.getByRole('button', {name: 'Admin login'}).click();
  const panel = page.locator('#reservationRequestsPanel');
  await panel.locator('summary').click();
  return {page, panel};
}

for (const width of [320, 390, 1440]) {
  test(engine + ' server-priced change preview and cancellation/refund consent at ' + width + 'px', pg, async t => {
    const f = await setup(t, {RESERVATION_SELF_SERVICE_ENABLED: 'true', RESERVATION_AUTO_CANCELLATIONS_ENABLED: 'true'});
    const owner = await f.register();
    const changeId = await f.reserve(owner, {email: account.email, date: '2026-10-03', time: '12:00'});
    const cancelId = await f.reserve(owner, {email: account.email, date: '2026-10-02', time: '12:00'});
    await paid(f, cancelId, owner);
    const {page, context} = await pageFor(t, f.h, width);
    const at = owner.indexOf('=');
    await context.addCookies([{name: owner.slice(0, at), value: owner.slice(at + 1), url: f.h.url, httpOnly: true}]);
    const address = f.h.url + '/manage-reservation.html?reservation=';
    await page.goto(address + changeId);
    const form = page.locator('#managedChangeForm');
    await form.getByLabel('New vehicle').selectOption('suv');
    await form.getByLabel('New passenger count').fill('3');
    await form.getByLabel('Luggage count').fill('2');
    await form.getByRole('button', {name: 'Preview fare change'}).click();
    await form.getByText('Original fare · $100.00', {exact: true}).waitFor();
    await form.getByText('Proposed fare · $80.00', {exact: true}).waitFor();
    await form.getByText('Difference · -$20.00', {exact: true}).waitFor();
    await form.getByText('Dispatch must verify vehicle availability.').waitFor();
    await layout(page, width);
    const send = form.getByRole('button', {name: 'Send changes to Dispatch'});
    await send.click();
    await page.getByText('Confirm that you reviewed the proposed fare and change details.').waitFor();
    await form.getByLabel('New passenger count').fill('4');
    assert.equal(await send.isVisible(), false, 'An edited form invalidates its preview');
    await form.getByRole('button', {name: 'Preview fare change'}).click();
    await form.getByText('Passengers · 4', {exact: true}).waitFor();
    await form.getByLabel('I reviewed these changes and the proposed fare.').check();
    await send.click();
    await page.getByText('Reservation change · Pending review', {exact: true}).waitFor();
    assert.equal((await f.store.get(changeId)).quote.total, 100);
    assert.equal((await f.store.get(changeId)).trip.vehicle, 'escalade');

    await page.goto(address + cancelId);
    await page.getByRole('button', {name: 'Review cancellation'}).click();
    await page.getByText('Cancellation fee · $0.00', {exact: true}).waitFor();
    await page.getByText('Expected refund · $100.00', {exact: true}).waitFor();
    const cancel = page.getByRole('button', {name: 'Confirm cancellation', exact: true});
    await cancel.click();
    await page.getByText('Confirm cancellation and review the expected refund.').waitFor();
    assert.equal(f.h.state.refundRequests.length, 0);
    await page.getByLabel('I confirm cancellation and the expected refund shown above.').check();
    await cancel.click();
    await page.getByText('Refund processing', {exact: true}).waitFor();
    assert.equal(f.h.state.refundRequests.length, 1);
    const refund = [...f.h.state.refunds.values()][0];
    const payload = JSON.stringify({id: 'evt_browser_managed', type: 'refund.updated', data: {object: refund}});
    const signature = f.h.signatureSdk.webhooks.generateTestHeaderString({payload, secret: 'whsec_local_mock'});
    assert.equal((await f.h.request('/api/stripe-webhook', payload, {'stripe-signature': signature})).status, 200);
    await page.getByRole('button', {name: 'Refresh status'}).click();
    await page.getByText('Refunded · $100.00', {exact: true}).waitFor();
    assert.equal(await page.getByRole('button', {name: 'Complete Payment'}).isVisible(), false);
    await layout(page, width);

    const admin = await dispatch(t, f, width);
    await admin.panel.getByText('Reservation change · pending', {exact: true}).waitFor();
    await admin.panel.getByLabel('Request status').selectOption('settlements');
    await admin.panel.getByText('Cancellation · Refund confirmed', {exact: true}).waitFor();
    await admin.panel.getByText('Refunded · $100.00', {exact: true}).waitFor();
    await layout(admin.page, width);
  });
}

test(engine + ' verified guest requests post-pickup cancellation and owner approval cancels without a refund at 390px', pg, async t => {
  const f = await setup(t, {RESERVATION_SELF_SERVICE_ENABLED: 'true', RESERVATION_AUTO_CANCELLATIONS_ENABLED: 'true'});
  const id = await f.reserve(null, {date: '2026-10-01', time: '12:25'});
  const grant = await f.verify(id);
  await paid(f, id, grant);
  // Stay within the same guest grant while crossing the pickup threshold.
  f.h.advance(25 * 60000);
  const {page, context} = await pageFor(t, f.h, 390);
  const at = grant.indexOf('=');
  await context.addCookies([{name: grant.slice(0, at), value: grant.slice(at + 1), domain: new URL(f.h.url).hostname,
    path: '/api/booking', httpOnly: true, sameSite: 'Strict'}]);
  await page.goto(f.h.url + '/manage-reservation.html');
  await page.getByRole('button', {name: 'Review cancellation'}).click();
  await page.getByText('Cancellation and any refund · Owner review required', {exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: 'Confirm cancellation', exact: true}).isVisible(), false);
  await page.getByLabel('I confirm this request for Dispatch review.').check();
  await page.getByRole('button', {name: 'Request Cancellation', exact: true}).click();
  await page.getByText('Cancellation · Pending review', {exact: true}).waitFor();
  assert.equal(f.h.state.refundRequests.length, 0);
  const {page: admin, panel} = await dispatch(t, f, 390);
  const settle = panel.getByRole('button', {name: 'Approve request'});
  admin.once('dialog', dialog => dialog.dismiss());
  await settle.click();
  assert.equal(f.h.state.refundRequests.length, 0);
  admin.once('dialog', dialog => dialog.accept());
  await settle.click();
  await panel.getByText('Decision recorded.', {exact: true}).waitFor();
  await panel.getByLabel('Request status').selectOption('approved');
  await panel.getByText('Cancellation applied. Any refund requires a separate owner decision.', {exact: true}).waitFor();
  assert.equal(f.h.state.refundRequests.length, 0);
  assert.equal((await f.store.get(id)).status, 'cancelled');
  const guestView = await f.get(base + '/guest', grant);
  assert.equal(guestView.body.requests[0].status, 'approved');
  await layout(admin, 390);
});

test(engine + ' Dispatch can recheck an escalated refund without issuing another at 390px', pg, async t => {
  const f = await setup(t, {RESERVATION_AUTO_CANCELLATIONS_ENABLED: 'true'});
  const owner = await f.register();
  const id = await f.reserve(owner, {email: account.email, date: '2026-10-02', time: '12:00'});
  await paid(f, id, owner);
  f.h.state.refundStatus = 'pending';
  const path = base + '/account/' + id + '/cancellation';
  const preview = await f.post(path + '/preview', {}, owner);
  assert.equal(preview.status, 200);
  const result = await f.post(path + '/confirm', {requestId: crypto.randomUUID(),
    revision: preview.body.terms.revision, confirmed: true, ownerReview: false}, owner);
  assert.equal(result.body.cancellation.state, 'provider_identified');
  f.h.advance(86400000);
  await f.h.context.runReservationRefunds();
  const {page, panel} = await dispatch(t, f, 390);
  const view = panel.getByLabel('Request status');
  await view.selectOption('reconciliation');
  await panel.getByText('Reconciliation · reconciliation deadline', {exact: true}).waitFor();
  await panel.getByText('Last check ·', {exact: false}).waitFor();
  await layout(page, 390);
  [...f.h.state.refunds.values()][0].status = 'succeeded';
  await panel.getByRole('button', {name: 'Recheck Stripe refund'}).click();
  await panel.getByText('Stripe recheck recorded.', {exact: true}).waitFor();
  assert.equal(await panel.getByRole('button', {name: 'Recheck Stripe refund'}).count(), 0);
  await view.selectOption('settlements');
  await panel.getByText('Cancellation · Refund confirmed', {exact: true}).waitFor();
  assert.equal(f.h.state.refundRequests.length, 1);
  await layout(page, 390);
});

test(engine + ' previews remain requests while automatic cancellations are disabled at 390px', pg, async t => {
  const f = await setup(t, {RESERVATION_SELF_SERVICE_ENABLED: 'true', RESERVATION_AUTO_CANCELLATIONS_ENABLED: 'false'});
  const owner = await f.register();
  const id = await f.reserve(owner, {email: account.email, date: '2026-10-02', time: '12:00'});
  await paid(f, id, owner);
  const {page, context} = await pageFor(t, f.h, 390);
  const at = owner.indexOf('=');
  await context.addCookies([{name: owner.slice(0, at), value: owner.slice(at + 1), url: f.h.url, httpOnly: true}]);
  await page.goto(f.h.url + '/manage-reservation.html?reservation=' + id);
  await page.getByRole('button', {name: 'Review cancellation'}).click();
  await page.getByText('Your reservation stays active until the owner approves cancellation. Any refund requires a separate owner decision.', {exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: 'Confirm cancellation', exact: true}).isVisible(), false);
  await page.getByLabel('I confirm this request for Dispatch review.').check();
  await page.getByRole('button', {name: 'Request Cancellation', exact: true}).click();
  await page.getByText('Cancellation · Pending review', {exact: true}).waitFor();
  assert.equal((await f.store.get(id)).status, 'confirmed');
  assert.equal(f.h.state.refundRequests.length, 0);
  const request = (await f.get(base + '/account/' + id, owner)).body.requests[0];
  const admin = await f.adminLogin();
  assert.equal((await f.post('/api/admin/reservation-requests/' + request.id + '/decision',
    {status: 'declined', confirmed: true}, admin)).status, 200);
  await page.getByRole('button', {name: 'Refresh status'}).click();
  await page.getByText('Cancellation · Declined', {exact: true}).waitFor();
  assert.equal((await f.store.get(id)).status, 'confirmed');
  assert.equal(f.h.state.refundRequests.length, 0);
  await layout(page, 390);
});
