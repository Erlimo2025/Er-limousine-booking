'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {ownerFixture} = require('../helpers/dispatch-owner.cjs');

const engine = process.env.ER_TEST_OWNER_ENGINE || 'chromium';
const pg = {skip: !process.env.ER_TEST_DATABASE_URL && 'Requires isolated PostgreSQL', timeout: 90000};
let browser;
test.before(async () => {
  if (pg.skip) return;
  const playwright = require(process.env.ER_TEST_PLAYWRIGHT_MODULE || 'playwright');
  const executablePath = engine === 'webkit' ? process.env.ER_TEST_WEBKIT_EXECUTABLE : process.env.ER_TEST_BROWSER_EXECUTABLE;
  browser = await playwright[engine].launch({headless: true, ...(executablePath && {executablePath})});
});
test.after(async () => {await browser?.close();});

async function open(t, fixture, width = 1440) {
  const context = await browser.newContext({viewport: {width, height: width < 600 ? 900 : 1050},
    isMobile: width < 600, hasTouch: width < 600});
  t.after(() => context.close());
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.url + '/admin.html');
  await page.getByRole('heading', {name: 'Owner sign in', exact: true}).waitFor({state: 'visible'});
  await page.getByLabel('Login email', {exact: true}).waitFor({state: 'visible'});
  return {page, context, errors};
}
async function password(page, f) {
  await page.getByLabel('Login email', {exact: true}).fill(f.owner.email);
  await page.getByLabel('Password', {exact: true}).fill(f.owner.password);
  await page.getByRole('button', {name: 'Continue', exact: true}).click();
}
async function signIn(page, f) {
  await password(page, f);
  await page.getByLabel('Authenticator code', {exact: true}).fill(f.code());
  await page.getByRole('button', {name: 'Verify and sign in'}).click();
  await page.locator('#ownerNavigation').waitFor({state: 'visible'});
}
async function expectNoOverflow(page) {
  const dimensions = await page.evaluate(() => {
    const main = document.querySelector('main');
    return {page: document.documentElement.scrollWidth - innerWidth,
      main: main.scrollWidth - main.clientWidth};
  });
  assert.ok(dimensions.page <= 1 && dimensions.main <= 1, JSON.stringify(dimensions));
  const clipped = await page.locator('#ownerNavigation button:visible, .owner-surface button:visible, .owner-surface input:visible, .owner-surface select:visible').evaluateAll(elements => elements.flatMap(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.width <= 0 || bounds.height < 43 || element.scrollWidth > element.clientWidth + 2
      ? [{tag: element.tagName, id: element.id, text: element.textContent, width: bounds.width, height: bounds.height}] : [];
  }));
  assert.deepEqual(clipped, []);
}
async function screenshot(page, name) {
  const directory = process.env.ER_TEST_OWNER_SCREENSHOTS_DIR;
  if (!directory) return;
  fs.mkdirSync(directory, {recursive: true});
  await page.screenshot({path: path.join(directory, engine + '-' + name + '.png'), animations: 'disabled'});
}

for (const width of [320, 390, 430, 768, 1440]) test('owner account and Audit Log fit ' + width + 'px with named outcomes', pg, async t => {
  const f = await ownerFixture(t);await f.enroll();
  const {page, errors} = await open(t, f, width);await signIn(page, f);
  assert.equal(await page.getByLabel('Admin credential').isVisible(), false);
  assert.equal(await page.locator('#ownerIdentity').textContent(), 'Synthetic Owner · Owner');
  await page.getByRole('button', {name: 'Owner account', exact: true}).click();
  await page.locator('#ownerSessionList li').first().waitFor();
  assert.equal(await page.getByText('Authenticator MFA enabled', {exact: true}).isVisible(), true);
  assert.ok(await page.locator('#ownerSessionList li').count() >= 2);
  assert.equal(await page.getByRole('button', {name: /Invite staff/}).count(), 0);
  await expectNoOverflow(page);await screenshot(page, 'account-' + width);
  await page.locator('#ownerSecurityForm').scrollIntoViewIfNeeded();
  await screenshot(page, 'account-security-' + width);
  await page.getByRole('button', {name: 'Audit log', exact: true}).click();
  await page.locator('#ownerAuditList tbody tr').first().waitFor();
  assert.ok(await page.locator('#ownerAuditList').getByText('Synthetic Owner', {exact: true}).count() > 0);
  assert.ok(await page.locator('#ownerAuditList').getByText('Succeeded', {exact: true}).count() > 0);
  assert.equal(await page.locator('#ownerAuditList').getByText('Recorded', {exact: true}).count(), 0);
  await expectNoOverflow(page);await screenshot(page, 'audit-' + width);
  await page.locator('#ownerAuditList tbody tr').first().scrollIntoViewIfNeeded();
  await screenshot(page, 'audit-activity-' + width);
  await page.getByLabel('Action', {exact: true}).selectOption('dispatch_sign_in');
  const filtered = page.waitForResponse(response => response.url().includes('/owner/audit?') && response.request().method() === 'GET');
  await page.getByRole('button', {name: 'Apply filters', exact: true}).click();
  assert.equal((await filtered).status(), 200);
  await page.getByText('Activity loaded.', {exact: true}).waitFor();
  const actionCells = await page.locator('#ownerAuditList tbody tr td:nth-child(3) > div').allTextContents();
  assert.ok(actionCells.length > 0);assert.ok(actionCells.every(value => value === 'Dispatch sign-in'));
  assert.deepEqual(errors, []);
});

test('owner enrollment reveals recovery codes once and keyboard sign-out clears sensitive content', pg, async t => {
  const f = await ownerFixture(t), {page, context, errors} = await open(t, f, 390);
  await page.getByLabel('Login email', {exact: true}).focus();
  await page.keyboard.press('Tab');assert.equal(await page.getByLabel('Password', {exact: true}).evaluate(element => element === document.activeElement), true);
  await password(page, f);
  await page.getByRole('heading', {name: 'Set up your authenticator'}).waitFor({state: 'visible'});
  const secret = await page.locator('#ownerSetupKey').textContent();assert.ok(secret.length >= 20);
  assert.equal((await page.request.get(f.url + '/api/protected')).status(), 401);
  await page.getByLabel('New authenticator code', {exact: true}).fill(f.code(secret));
  await page.getByLabel('New authenticator code', {exact: true}).press('Enter');
  await page.getByRole('heading', {name: 'Save your recovery codes', exact: true}).waitFor({state: 'visible'});
  const codes = (await page.locator('#ownerRecoveryCodes').textContent()).trim().split('\n');assert.equal(codes.length, 8);
  assert.equal(await page.locator('#ownerSetupKey').textContent(), '');
  await page.getByRole('button', {name: 'I have saved my recovery codes'}).press('Enter');
  await page.locator('#ownerNavigation').waitFor({state: 'visible'});
  const storage = await page.evaluate(() => JSON.stringify({local: {...localStorage}, session: {...sessionStorage}}));
  assert.ok(!storage.includes(secret));assert.ok(codes.every(code => !storage.includes(code)));
  await page.getByRole('button', {name: 'Audit log', exact: true}).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', {name: 'Sign out', exact: true}).evaluate(element => element === document.activeElement), true);
  const focus = await page.getByRole('button', {name: 'Sign out', exact: true}).evaluate(element => ({outline: getComputedStyle(element).outlineStyle, width: getComputedStyle(element).outlineWidth}));
  assert.notEqual(focus.outline, 'none');assert.notEqual(focus.width, '0px');
  await page.keyboard.press('Enter');
  await page.locator('#ownerLoginForm').waitFor({state: 'visible'});
  assert.equal(await page.locator('#ownerRecoveryCodes').textContent(), '');
  assert.equal(await page.locator('#ownerAuditList').textContent(), '');
  assert.equal((await page.request.get(f.url + '/api/protected')).status(), 401);
  await password(page, f);
  await page.getByLabel('Authenticator code', {exact: true}).waitFor({state: 'visible'});
  const challenge = (await context.cookies(f.url)).find(cookie => cookie.name.endsWith('er_dispatch_challenge'));
  assert.ok(challenge);
  const retained = f.client();retained.jar.set(challenge.name, challenge.value);
  await page.getByRole('button', {name: 'Start again', exact: true}).click();
  await page.locator('#ownerLoginForm').waitFor({state: 'visible'});
  assert.equal((await retained.request('/api/admin/owner/verify', {code: f.code(secret)})).status, 401);
  assert.deepEqual(errors, []);
});

test('lost-authenticator recovery requires replacement enrollment before Dispatch access', pg, async t => {
  const f = await ownerFixture(t), initial = await f.enroll(), {page} = await open(t, f);
  await page.getByRole('button', {name: 'Lost access to your authenticator?'}).click();
  await page.getByLabel('Recovery login email').fill(f.owner.email);
  await page.getByLabel('Account password').fill(f.owner.password);
  await page.getByLabel('Single-use recovery code').fill(initial.recoveryCodes[0]);
  await page.getByRole('button', {name: 'Start recovery', exact: true}).click();
  await page.getByRole('heading', {name: 'Set up your authenticator'}).waitFor({state: 'visible'});
  const replacement = await page.locator('#ownerSetupKey').textContent();assert.notEqual(replacement, initial.seed);
  assert.equal((await page.request.get(f.url + '/api/protected')).status(), 401);
  assert.equal((await initial.client.request('/api/protected')).status, 401);
  await page.getByLabel('New authenticator code').fill(f.code(replacement));
  await page.getByRole('button', {name: 'Confirm authenticator'}).click();
  await page.getByRole('button', {name: 'I have saved my recovery codes'}).click();
  await page.locator('#ownerNavigation').waitFor({state: 'visible'});
  assert.equal((await page.request.get(f.url + '/api/protected')).status(), 200);
});

test('owner can revoke other-instance sessions and replace recovery codes with fresh MFA', pg, async t => {
  const f = await ownerFixture(t), enrolled = await f.enroll(), other = await f.login(1);
  const {page} = await open(t, f);await signIn(page, f);
  await page.getByRole('button', {name: 'Owner account', exact: true}).click();
  await page.locator('#ownerSessionList li').first().waitFor();
  await page.getByLabel('Current password', {exact: true}).fill('Invalid synthetic owner password');
  await page.getByLabel('Fresh authenticator code').fill(f.code());
  await page.getByRole('button', {name: 'Sign out other sessions', exact: true}).click();
  await page.locator('#ownerAccountStatus').getByText('Unable to authenticate. Please try again.', {exact: true}).waitFor();
  assert.equal(await page.locator('#ownerAccountPanel').isVisible(), true);
  assert.equal((await page.request.get(f.url + '/api/protected')).status(), 200);
  await page.getByLabel('Current password', {exact: true}).fill(f.owner.password);
  await page.getByLabel('Fresh authenticator code').fill(f.code());
  await page.getByRole('button', {name: 'Sign out other sessions', exact: true}).click();
  await page.getByText('Other sessions have been signed out. This session remains active.', {exact: true}).waitFor();
  assert.equal((await other.request('/api/protected')).status, 401);
  assert.equal((await page.request.get(f.url + '/api/protected')).status(), 200);
  await page.getByLabel('Current password', {exact: true}).fill(f.owner.password);
  await page.getByLabel('Fresh authenticator code').fill(f.code());
  await page.getByRole('button', {name: 'Replace recovery codes', exact: true}).click();
  await page.locator('#ownerRecoveryCodesPanel').waitFor({state: 'visible'});
  const replacement = (await page.locator('#ownerRecoveryCodes').textContent()).trim().split('\n');
  assert.equal(replacement.length, 8);assert.ok(replacement.every(code => !enrolled.recoveryCodes.includes(code)));
  const denied = await f.client().request('/api/admin/owner/recover', {email: f.owner.email, password: f.owner.password, recoveryCode: enrolled.recoveryCodes[0]});
  assert.equal(denied.status, 401);
  await page.getByRole('button', {name: 'I have saved my recovery codes'}).click();
  await page.getByRole('heading', {name: 'Owner account', exact: true}).waitFor({state: 'visible'});
  assert.equal(await page.locator('#ownerRecoveryCodes').textContent(), '');
});

test('owner Audit Log loads bounded next pages without duplicate events', pg, async t => {
  const f = await ownerFixture(t);await f.enroll();
  const {randomUUID} = require('node:crypto');
  for (let index = 0; index < 30; index++) await f.stores[0].dispatchAppendAudit({
    timestamp: new Date(f.now() - index * 1000).toISOString(), referenceId: randomUUID(),
    operation: 'admin', category: 'dispatch_security', staffId: f.owner.id,
    action: 'reservation_status_update', outcome: 'succeeded', recordId: randomUUID()
  });
  const {page} = await open(t, f);await signIn(page, f);
  await f.flush();
  const expectedIds = (await f.stores[0].dispatchAuditPage({limit: 100})).events.map(entry => entry.id);
  await page.getByRole('button', {name: 'Audit log', exact: true}).click();
  await page.getByText('Activity loaded.', {exact: true}).waitFor();
  assert.equal(await page.locator('#ownerAuditList tbody tr').count(), 25);
  const firstIds = await page.locator('#ownerAuditList tbody tr').evaluateAll(rows => rows.map(row => row.dataset.auditEventId));
  const next = page.waitForResponse(response => response.url().includes('/owner/audit?') && response.url().includes('cursor='));
  await page.getByRole('button', {name: 'Load more activity', exact: true}).click();
  assert.equal((await next).status(), 200);
  await page.getByText('Activity loaded.', {exact: true}).waitFor();
  const allIds = await page.locator('#ownerAuditList tbody tr').evaluateAll(rows => rows.map(row => row.dataset.auditEventId));
  assert.ok(allIds.length > firstIds.length);
  assert.equal(new Set(allIds).size, allIds.length);
  assert.deepEqual(allIds, expectedIds);
});
