'use strict';

// Sequential Playwright checks against the local booking server and synthetic
// providers. ER_TEST_CONTACT_ENGINE may be chromium or webkit.
const test = require('node:test');
const assert = require('node:assert/strict');
const {create, cases} = require('../helpers/booking-browser.cjs');

const engine = process.env.ER_TEST_CONTACT_ENGINE || 'chromium';
const storageKey = 'er_booking_contact_v1';
const contact = {
  firstName: 'Zoë',
  lastName: "O'Neill",
  email: 'returning-guest@example.test',
  phone: '+1 (201) 555-0199'
};
const editedContact = {...contact, email: 'updated-guest@example.test'};
const tokens = {firstName: 'given-name', lastName: 'family-name', email: 'email', phone: 'tel'};
const blank = {firstName: '', lastName: '', email: '', phone: ''};
let browser;
let devices;

test.before(async () => {
  const playwright = require(process.env.ER_TEST_PLAYWRIGHT_MODULE || 'playwright');
  assert.ok(['chromium', 'webkit'].includes(engine));
  const executablePath = engine === 'webkit' ? process.env.ER_TEST_WEBKIT_EXECUTABLE : process.env.ER_TEST_BROWSER_EXECUTABLE;
  devices = playwright.devices;
  browser = await playwright[engine].launch({headless: true, ...(executablePath && {executablePath})});
});

test.after(async () => {
  await browser?.close();
});

async function contextFor(t, h, width, storage) {
  const mobile = width < 500;
  const profile = mobile && devices[engine === 'webkit' ? 'iPhone 13' : 'Pixel 7'];
  const context = await browser.newContext({
    viewport: {width, height: 920},
    isMobile: mobile,
    hasTouch: mobile,
    ...(profile && {userAgent: profile.userAgent})
  });
  t.after(() => context.close());
  await context.addInitScript(({storage, key}) => {
    const NativeDate = Date;
    const fixed = Date.parse('2026-10-01T16:00:00Z');
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [fixed])); }
      static now() { return fixed; }
    };
    window.contactCspFailures = [];
    document.addEventListener('securitypolicyviolation', e => window.contactCspFailures.push(e.effectiveDirective));
    if (storage === 'blocked') {
      Object.defineProperty(window, 'localStorage', {get() {
        throw new DOMException('Storage is disabled', 'SecurityError');
      }});
    }
    if (storage === 'quota') {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(name, value) {
        if (name === key) throw new DOMException('Storage is full', 'QuotaExceededError');
        return original.call(this, name, value);
      };
    }
  }, {storage, key: storageKey});
  await context.route('**/*', route => new URL(route.request().url()).origin === h.url ? route.continue() : route.abort());
  return context;
}

async function open(context, h) {
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.goto(h.url + '/#book', {waitUntil: 'networkidle'});
  return page;
}

async function setup(t, width = 390, storage) {
  const {h, input} = await create(t, cases.find(s => s.id === 'same_state'));
  const context = await contextFor(t, h, width, storage);
  const page = await open(context, h);
  return {h, input, context, page};
}

async function customerStep(page, input) {
  await page.locator('#pickup').fill(input.pickup);
  await page.locator('#dropoff').fill(input.dropoff);
  await page.locator('#date').fill(input.date);
  await page.locator('#time').fill(input.time);
  await page.locator('#vehicle').selectOption(input.vehicle);
  await page.locator('#passengers').selectOption('2');
  await page.locator('#bookingContinue').click();
  assert.equal(await step(page), '2');
}

const step = page => page.locator('#book').getAttribute('data-booking-step');
const optIn = page => page.getByRole('checkbox', {name: 'Remember my information on this device.'});
const forget = page => page.getByRole('button', {name: 'Forget my details'});
const fields = page => page.evaluate(ids => Object.fromEntries(ids.map(id => [id, document.getElementById(id).value])), Object.keys(contact));
const saved = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
const seed = (page, data = contact) => page.evaluate(([key, value]) => localStorage.setItem(key, value), [storageKey, JSON.stringify(data)]);
const requestTo = (response, path) => new URL(response.url()).pathname === path;
const gateResponse = page => page.waitForResponse(response => requestTo(response, '/api/customer/booking-contact'));
async function fill(page, values) {
  for (const [id, value] of Object.entries(values)) await page.locator('#' + id).fill(value);
}
async function waitForContact(page) {
  await page.waitForFunction(values => Object.entries(values).every(([id, value]) => document.getElementById(id).value === value), contact);
}
async function quote(page) {
  const pending = page.waitForResponse(response => requestTo(response, '/api/quote'));
  const button = page.locator('#quoteBtn');
  if (page.viewportSize().width < 500) await button.tap();
  else await button.click();
  return pending;
}
async function continueToSummary(page) {
  const response = await quote(page);
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => document.getElementById('book').dataset.bookingStep === '3');
  return response.request().postDataJSON();
}

for (const width of [320, 390, 1440]) {
  test(engine + ' consent, reload and Step 2 layout at ' + width + 'px', {timeout: 35000}, async t => {
    const {h, input, page, context} = await setup(t, width);
    await customerStep(page, input);
    assert.deepEqual(await fields(page), blank);
    assert.equal(await optIn(page).isChecked(), false);
    assert.equal(await forget(page).isVisible(), false);
    for (const [id, token] of Object.entries(tokens)) {
      assert.equal(await page.locator('#' + id).getAttribute('autocomplete'), token);
    }

    await fill(page, contact);
    await page.locator('#notes').fill('Synthetic notes that must stay out of local storage.');
    if (width < 500) {
      await page.locator('.booking-contact-opt-in').tap();
    } else {
      await optIn(page).focus();
      await page.keyboard.press('Space');
    }
    assert.equal(await optIn(page).isChecked(), true);
    assert.equal(await saved(page), null);
    const payload = await continueToSummary(page);
    assert.equal(Object.hasOwn(payload, 'rememberBookingContact'), false);
    assert.equal(Object.hasOwn(payload, 'forgetBookingContact'), false);
    assert.deepEqual(await saved(page), contact);
    assert.equal(h.records().length, 0);

    const returning = await open(context, h);
    await customerStep(returning, input);
    await waitForContact(returning);
    assert.equal(await optIn(returning).isChecked(), false);
    assert.equal(await forget(returning).isVisible(), true);
    assert.equal(await returning.locator('#notes').inputValue(), '');
    const layout = await returning.locator('.booking-contact-preferences').evaluate(element => {
      const box = element.getBoundingClientRect();
      const label = element.querySelector('label').getBoundingClientRect();
      const action = element.querySelector('button').getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        controlsFit: [label, action].every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1),
        usableTargets: label.height >= 44 && action.height >= 44,
        cspFailures: window.contactCspFailures
      };
    });
    assert.ok(layout.overflow <= 0);
    assert.equal(layout.controlsFit, true);
    assert.equal(layout.usableTargets, true);
    assert.deepEqual(layout.cspFailures, []);
    if (process.env.ER_TEST_CONTACT_SCREENSHOTS_DIR) {
      const path = require('node:path');
      await returning.locator('#book').screenshot({path: path.join(process.env.ER_TEST_CONTACT_SCREENSHOTS_DIR, engine + '-' + width + '.png')});
    }

    await fill(returning, {email: editedContact.email});
    const edited = await continueToSummary(returning);
    assert.equal(edited.email, editedContact.email);
    assert.deepEqual(await saved(returning), contact);
    await returning.locator('#bookingBack').click();
    await optIn(returning).check();
    await continueToSummary(returning);
    assert.deepEqual(await saved(returning), editedContact);
  });
}

test(engine + ' saves only after valid Continue and respects opting out', {timeout: 35000}, async t => {
  const {page, input} = await setup(t);
  await customerStep(page, input);
  await fill(page, {...contact, phone: 'not a phone'});
  await optIn(page).check();
  const rejected = await quote(page);
  assert.equal(rejected.status(), 400);
  await page.waitForFunction(() => !document.getElementById('quoteBtn').disabled);
  assert.equal(await step(page), '2');
  assert.equal(await saved(page), null);

  await fill(page, {phone: contact.phone});
  await page.locator('#promoCode').fill('FIRST15');
  const preview = page.waitForResponse(response => requestTo(response, '/api/quote'));
  await page.locator('#applyPromoBtn').click();
  assert.equal((await preview).status(), 200);
  await page.waitForFunction(() => !document.getElementById('applyPromoBtn').disabled);
  assert.equal(await step(page), '2');
  assert.equal(await saved(page), null);

  await optIn(page).uncheck();
  await continueToSummary(page);
  assert.equal(await saved(page), null);
});

test(engine + ' Forget removes the saved copy and keeps edited fields', {timeout: 35000}, async t => {
  const {h, input, page, context} = await setup(t);
  await seed(page);
  await customerStep(page, input);
  await waitForContact(page);
  await fill(page, {firstName: 'Taylor'});
  await page.locator('#notes').fill('Keep this note');
  await forget(page).click();
  assert.equal(await saved(page), null);
  assert.deepEqual(await fields(page), {...blank, firstName: 'Taylor'});
  assert.equal(await page.locator('#notes').inputValue(), 'Keep this note');
  assert.equal(await forget(page).isVisible(), false);
  assert.match(await page.locator('#rememberBookingStatus').innerText(), /removed/);
  const next = await open(context, h);
  await customerStep(next, input);
  assert.deepEqual(await fields(next), blank);
});

test(engine + ' a signed-in customer never inherits device contact from another booking', {timeout: 35000}, async t => {
  const {h, input, page, context} = await setup(t);
  await seed(page);
  const account = {fullName: 'Account Owner', email: 'signed-in@example.test', phone: '2025550188', password: 'Synthetic browser password'};
  const registration = await context.request.post(h.url + '/api/customer/register', {
    data: account, headers: {Origin: h.url, 'Sec-Fetch-Site': 'same-origin'}
  });
  assert.equal(registration.status(), 201);
  const pending = gateResponse(page);
  await customerStep(page, input);
  assert.deepEqual(await (await pending).json(), {allowRememberedContact: false});
  await page.waitForLoadState('networkidle');
  assert.deepEqual(await fields(page), blank);
  assert.equal(await forget(page).isVisible(), true);
  await fill(page, {firstName: 'Account', lastName: 'Owner', email: account.email, phone: account.phone});
  const payload = await continueToSummary(page);
  assert.equal(payload.email, account.email);
  assert.equal((await context.request.get(h.url + '/api/customer/profile')).status(), 200);
  assert.deepEqual(await saved(page), contact);
});

test(engine + ' contact already supplied by the browser stays intact', {timeout: 35000}, async t => {
  const {page, input} = await setup(t);
  await seed(page);
  await page.locator('#email').evaluate(field => { field.value = 'browser-profile@example.test'; });
  await customerStep(page, input);
  await page.waitForLoadState('networkidle');
  assert.deepEqual(await fields(page), {...blank, email: 'browser-profile@example.test'});
  assert.equal(await forget(page).isVisible(), true);
});

test(engine + ' a slow session check cannot replace a customer edit', {timeout: 35000}, async t => {
  const {page, input} = await setup(t);
  await seed(page);
  let release;
  let started;
  const deferred = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  await page.route('**/api/customer/booking-contact', async route => {
    started();
    await deferred;
    await route.continue();
  });
  const pending = gateResponse(page);
  await customerStep(page, input);
  await requested;
  await page.locator('#firstName').fill('Taylor');
  await page.locator('#firstName').fill('');
  release();
  assert.deepEqual(await (await pending).json(), {allowRememberedContact: true});
  await page.waitForLoadState('networkidle');
  assert.deepEqual(await fields(page), blank);
});

test(engine + ' blocked storage leaves the booking usable', {timeout: 35000}, async t => {
  const {page, input} = await setup(t, 390, 'blocked');
  await customerStep(page, input);
  assert.equal(await optIn(page).isEnabled(), false);
  assert.match(await page.locator('#rememberBookingStatus').innerText(), /continue booking/);
  assert.deepEqual(await fields(page), blank);
  await fill(page, contact);
  assert.equal((await continueToSummary(page)).email, contact.email);
});

test(engine + ' a storage write failure does not block the quote', {timeout: 35000}, async t => {
  const {page, input} = await setup(t, 390, 'quota');
  await customerStep(page, input);
  await fill(page, contact);
  await optIn(page).check();
  await continueToSummary(page);
  assert.equal(await saved(page), null);
  await page.locator('#bookingBack').click();
  assert.match(await page.locator('#rememberBookingStatus').innerText(), /could not save/);
});

test(engine + ' separate private browser contexts do not share remembered contacts', {timeout: 35000}, async t => {
  const {h, input, page, context} = await setup(t);
  await customerStep(page, input);
  await fill(page, contact);
  await optIn(page).check();
  await continueToSummary(page);
  assert.deepEqual(await saved(page), contact);
  await context.close();
  const privateContext = await contextFor(t, h, 390);
  const next = await open(privateContext, h);
  await customerStep(next, input);
  assert.deepEqual(await fields(next), blank);
  assert.equal(await saved(next), null);
});

test(engine + ' Pay Later keeps the remembered record limited to contact fields', {timeout: 35000}, async t => {
  const {page, input, h} = await setup(t);
  await customerStep(page, input);
  await fill(page, contact);
  await optIn(page).check();
  await continueToSummary(page);
  const acceptance = page.locator('#cancelPolicyAccepted');
  const acceptanceLabel = page.locator('.booking-policy-accept');
  assert.equal(await acceptance.isChecked(), false);
  assert.equal(await page.locator('#payLaterBtn').isEnabled(), false);
  await acceptanceLabel.tap();
  assert.equal(await acceptance.isChecked(), true);
  assert.equal(await page.locator('#payLaterBtn').isEnabled(), true);
  await acceptanceLabel.tap();
  assert.equal(await acceptance.isChecked(), false);
  assert.equal(await page.locator('#payLaterBtn').isEnabled(), false);
  assert.equal(await step(page), '3');
  await acceptanceLabel.tap();
  const pending = page.waitForResponse(response => requestTo(response, '/api/checkout'));
  await page.locator('#payLaterBtn').tap();
  const reservation = await pending;
  assert.equal(reservation.status(), 200);
  await page.waitForURL(url => url.pathname === '/success.html');
  assert.equal(h.records().length, 1);
  assert.equal(h.state.creates.length, 0);
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), [storageKey]);
  assert.deepEqual(await page.evaluate(() => Object.keys(sessionStorage)), []);
  assert.deepEqual(await saved(page), contact);
});

test(engine + ' malformed storage is ignored and can be forgotten', {timeout: 35000}, async t => {
  const {page, input} = await setup(t);
  await seed(page, {...contact, password: 'synthetic-unexpected-field'});
  await customerStep(page, input);
  assert.deepEqual(await fields(page), blank);
  await forget(page).click();
  assert.equal(await saved(page), null);
  await fill(page, contact);
  await continueToSummary(page);
});

