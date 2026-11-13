'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {analyticsFixture, endpoint} = require('../helpers/dispatch-analytics.cjs');
const {guestBooking} = require('../helpers/reservation-management.cjs');

const engine = process.env.ER_TEST_ANALYTICS_ENGINE || 'chromium';
const pg = {skip: !process.env.ER_TEST_DATABASE_URL && 'Requires isolated PostgreSQL', timeout: 90000};
let browser, devices;

test.before(async () => {
  if (pg.skip) return;
  const playwright = require(process.env.ER_TEST_PLAYWRIGHT_MODULE || 'playwright');
  const executablePath = engine === 'webkit' ? process.env.ER_TEST_WEBKIT_EXECUTABLE : process.env.ER_TEST_BROWSER_EXECUTABLE;
  browser = await playwright[engine].launch({headless: true, ...(executablePath && {executablePath})});
  devices = playwright.devices;
});
test.after(async () => { await browser?.close(); });

async function open(t, fixture, width) {
  const mobile = width < 600;
  const profile = devices[engine === 'webkit' ? 'iPhone 13' : 'Pixel 7'];
  const height = {320: 568, 390: 844, 430: 932}[width] || 1050;
  const context = await browser.newContext({viewport: {width, height}, isMobile: mobile,
    hasTouch: mobile, acceptDownloads: true, ...(mobile && {userAgent: profile.userAgent})});
  t.after(() => context.close());
  await context.addInitScript(() => {
    window.analyticsCsp = [];
    document.addEventListener('securitypolicyviolation', event => window.analyticsCsp.push(event.effectiveDirective));
  });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.h.url ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.h.url + '/admin.html');
  await page.getByRole('button', {name: 'Admin login'}).waitFor({state: 'visible'});
  return {context, page, errors};
}

async function login(page, openAnalytics = true) {
  const panel = page.locator('#businessAnalytics');
  assert.equal(await panel.isVisible(), false);
  await page.getByLabel('Admin credential').fill('local-test-token');
  await page.getByRole('button', {name: 'Admin login'}).click();
  if (openAnalytics) await panel.locator(':scope > summary').click();
}

async function layout(page) {
  assert.deepEqual(await page.evaluate(() => {
    const main = document.querySelector('main');
    const root = document.scrollingElement;
    return {overflow: Math.max(0, root.scrollWidth - innerWidth, main.scrollWidth - main.clientWidth),
      documentScroll: Math.max(0, root.scrollHeight - root.clientHeight - 1),
      csp: window.analyticsCsp};
  }), {overflow: 0, documentScroll: 0, csp: []});
}

async function scrollTo(locator) {
  await locator.evaluate(async element => {
    element.scrollIntoView({block: 'start', behavior: 'instant'});
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function dateControlsInView(page) {
  const bounds = await page.evaluate(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    const header = rect('.nav'), main = rect('main'), title = rect('#businessAnalytics > summary'), filters = rect('#analyticsDates');
    return {headerTop: header.top, headerBottom: header.bottom, mainTop: main.top, mainBottom: main.bottom,
      titleTop: title.top, titleBottom: title.bottom, filtersTop: filters.top, filtersBottom: filters.bottom, scrollY};
  });
  assert.ok(Math.abs(bounds.headerTop) <= 1 && bounds.mainTop >= bounds.headerBottom - 1 &&
    bounds.titleTop >= bounds.mainTop - 1 && bounds.filtersTop >= bounds.titleBottom - 1 &&
    bounds.filtersBottom <= bounds.mainBottom + 1, 'Dispatch header, analytics title and date filters: ' + JSON.stringify(bounds));
}

async function screenshot(page, locator, name) {
  const directory = process.env.ER_TEST_ANALYTICS_SCREENSHOTS_DIR;
  if (!directory) return;
  fs.mkdirSync(directory, {recursive: true});
  await scrollTo(locator);
  await page.screenshot({path: path.join(directory, name + '.png'), animations: 'disabled'});
}

async function seed(t) {
  const f = await analyticsFixture(t);
  f.setNow('2026-11-11T17:00:00Z');
  let archived;
  for (let index = 0; index < 28; index++) {
    const month = String(1 + index % 3).padStart(2, '0');
    const day = String(2 + index % 24).padStart(2, '0');
    const date = '2026-' + month + '-' + day;
    const status = index % 5 === 0 ? 'cancelled' : index % 6 === 0 ? 'awaiting_payment' : 'completed';
    const fareCents = 12800 + index * 427;
    const trip = await f.trip({createdAt: date + 'T14:00:00Z', pickupDate: date, pickupAt: date + 'T17:00:00Z',
      status, fareCents, capture: status === 'awaiting_payment' ? undefined : fareCents, paidAt: date + 'T15:00:00Z',
      archived: index === 0, vehicle: index % 3 ? 'suv' : 'escalade',
      pickup: index % 2 ? '18 Example Plaza, Newark, NJ' : '26 Sample Lane, Orange, NJ',
      destination: index % 3 ? '32 Test Avenue, Manhattan, NY' : 'JFK International Airport'});
    if (index === 0) {
      archived = trip;
      await f.managedRefund(trip, {confirmedAt: '2026-03-12T17:00:00Z'});
    }
    if (index < 9) await f.request(trip, ['pending', 'approved', 'declined'][index % 3], date + 'T18:00:00Z');
  }
  await f.trip({createdAt: '2026-11-05T15:00:00Z', pickupDate: '2026-11-24', pickupAt: '2026-11-24T16:00:00Z'});
  await f.trip({createdAt: '2026-11-11T14:00:00Z', pickupDate: '2026-11-11', pickupAt: '2026-11-11T15:00:00Z',
    status: 'completed', capture: 15000, paidAt: '2026-11-11T15:00:00Z'});
  await f.trip({createdAt: '2025-12-05T14:00:00Z', pickupDate: '2025-12-09', pickupAt: '2025-12-09T15:00:00Z',
    status: 'completed', capture: 15000, paidAt: '2025-12-09T15:00:00Z'});
  return {...f, archived};
}

for (const width of [320, 390, 430, 1440]) {
  test(engine + ' analytics dates, cards, charts, report, CSV and Dispatch at ' + width + 'px', pg, async t => {
    const f = await seed(t);
    const {page, errors} = await open(t, f, width);
    const dates = page.locator('#analyticsDates');
    const period = page.locator('#analyticsPeriod');
    const summary = page.locator('#businessAnalytics > summary');
    const from = page.getByLabel('From Date', {exact: true});
    const to = page.getByLabel('To Date', {exact: true});
    const report = page.locator('#analyticsTripReport');
    const comparison = page.locator('#analyticsComparison');
    const collectedChange = comparison.locator('.ba-comparison-card').filter({hasText: 'Actual payments collected'}).locator('.ba-change');
    const ready = (label, expected) => page.waitForFunction(
      ([text, count]) => document.getElementById('analyticsPeriod').textContent === text &&
        document.querySelector('[data-metric="bookingsReceived"] dd')?.textContent === count,
      [label, String(expected)]);
    await login(page);
    await ready('Nov 1, 2026 – Nov 30, 2026', 2);
    assert.equal(await from.inputValue(), '2026-11-01');
    assert.equal(await to.inputValue(), '2026-11-30');
    await report.locator('tbody tr').first().waitFor();
    await scrollTo(summary);
    await dateControlsInView(page);
    await layout(page);

    await from.fill('2026-01-01');
    await to.fill('2026-03-31');
    await dates.getByRole('button', {name: 'Apply Filter', exact: true}).click();
    await ready('Jan 1, 2026 – Mar 31, 2026', 28);
    assert.match(await page.locator('#analyticsGranularity').textContent(), /Weekly activity/);
    assert.equal(await page.locator('.ba-metric').count(), 16);
    assert.equal(await page.locator('#analyticsCharts .ba-chart').count(), 5);
    await comparison.getByText('Compared with Oct 1, 2025 – Dec 31, 2025 · Equivalent calendar periods (3 full calendar months each)', {exact: true}).waitFor();
    assert.equal(await collectedChange.textContent(), '+2,853.24%');
    await report.locator('tbody tr').first().waitFor();
    assert.equal(await report.locator('tbody tr').count(), 25);
    await dateControlsInView(page);
    await layout(page);
    if ([390, 1440].includes(width)) await screenshot(page, summary, 'custom-quarter-' + width);
    if (width === 1440) await screenshot(page, page.locator('#analyticsChartsHeading'), 'desktop-trends-1440');

    await page.getByRole('button', {name: 'Next page'}).click();
    await page.getByText('Page 2', {exact: true}).waitFor();
    assert.equal(await report.locator('tbody tr').count(), 3);
    await page.getByRole('button', {name: 'Previous page'}).click();
    await page.getByText('Page 1', {exact: true}).waitFor();
    await page.getByLabel('Search trips').fill(f.archived.reference.toLowerCase());
    await page.locator('#analyticsTripStatus').selectOption('cancelled');
    await page.getByLabel('Sort by').selectOption('fare');
    await page.getByRole('button', {name: 'Apply Trip Filters'}).click();
    const openTrip = report.getByRole('button', {name: 'Open ' + f.archived.reference + ' in Dispatch'});
    await openTrip.waitFor();
    assert.equal(await report.locator('tbody tr').count(), 1);
    if (width === 390) await screenshot(page, page.locator('#analyticsTripsHeading'), 'mobile-trip-report-390');
    if (width === 1440) await screenshot(page, page.locator('#analyticsTripsHeading'), 'desktop-trip-report-1440');

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name: 'Export CSV'}).click()]);
    assert.equal(download.suggestedFilename(), 'er-dispatch-trips-2026-01-01_2026-03-31.csv');
    const csv = fs.readFileSync(await download.path(), 'utf8');
    assert.match(csv, new RegExp(f.archived.reference));
    assert.equal(csv.trim().split('\r\n').length, 2);
    assert.doesNotMatch(csv, /rider@example|2015550140|stripe/i);
    await openTrip.click();
    await page.locator('#bookings .dispatch-card .dispatch-editor[open]').waitFor();
    assert.equal(await page.locator('#filterView').inputValue(), 'archived');
    assert.equal(await page.locator('#reservationSearch').inputValue(), f.archived.reference);
    assert.equal(await page.locator('#bookings .dispatch-card').getAttribute('data-id'), f.archived.id);
    await layout(page);

    await scrollTo(summary);
    await dateControlsInView(page);
    await page.getByLabel('Quick date filter').selectOption('thisYear');
    await ready('Jan 1, 2026 – Dec 31, 2026', 30);
    assert.match(await page.locator('#analyticsGranularity').textContent(), /Monthly activity/);
    await comparison.getByText(/Equivalent calendar periods \(12 full calendar months each\)/).waitFor();
    await report.locator('tbody tr').first().waitFor();
    await dateControlsInView(page);
    if (width === 1440) await screenshot(page, summary, 'full-year-filter-1440');

    await page.getByLabel('Quick date filter').selectOption('today');
    await ready('Nov 11, 2026', 1);
    await comparison.getByText('Compared with Nov 10, 2026 · Equal calendar-day lengths (1 day each)', {exact: true}).waitFor();
    assert.equal(await collectedChange.textContent(), 'No prior activity');
    await dateControlsInView(page);
    if (width === 1440) {
      for (const [quick, start, end] of [
        ['yesterday','2026-11-10','2026-11-10'],
        ['thisWeek','2026-11-09','2026-11-15'], ['lastWeek','2026-11-02','2026-11-08'],
        ['thisMonth','2026-11-01','2026-11-30'], ['lastMonth','2026-10-01','2026-10-31'],
        ['lastYear','2025-01-01','2025-12-31']
      ]) {
        await page.getByLabel('Quick date filter').selectOption(quick);
        await page.waitForFunction(([first, last]) =>
          document.getElementById('analyticsFrom').value === first && document.getElementById('analyticsTo').value === last, [start,end]);
      }
    }
    await dates.getByRole('button', {name: 'Reset Filter'}).click();
    await ready('Nov 1, 2026 – Nov 30, 2026', 2);
    assert.equal(await page.getByLabel('Search trips').inputValue(), '');
    await period.waitFor();
    await dateControlsInView(page);
    await page.getByRole('button', {name: 'Admin logout'}).click();
    await page.locator('#businessAnalytics').waitFor({state: 'hidden'});
    assert.equal(await page.locator('[data-metric]').count(), 0);
    assert.equal(await report.locator('tbody tr').count(), 0);
    assert.deepEqual(errors, []);
  });
}

for (const width of [320, 390, 430, 1440]) {
  test(engine + ' Dispatch payment review and signed confirmation at ' + width + 'px', pg, async t => {
    const fixture = await analyticsFixture(t);
    const {h, store} = fixture;
    const booking = await fixture.post('/api/checkout', {...guestBooking, paymentChoice: 'now'});
    assert.equal(booking.status, 200);
    const id = booking.body.bookingId;
    const session = [...h.state.sessions.values()][0];
    Object.assign(session, {status: 'complete', payment_status: 'paid'});
    h.advance(31 * 60_000);
    await h.context.runPaymentConfirmationRecovery();

    const {page, errors} = await open(t, fixture, width);
    await login(page, false);
    await page.locator('#filterPayment').selectOption('review');
    await page.locator('#filterTiming').selectOption('all');
    await page.locator('#applyFilters').click();
    const card = page.locator('.dispatch-card');
    await card.getByText('Payment Review', {exact: true}).waitFor();
    await card.getByText(/ER-\d{6}/).waitFor();
    await card.getByText('Manage Dispatch', {exact: true}).click();
    await card.getByText(/Stripe reports payment received\. Signed confirmation needed\./).waitFor();
    const check = page.waitForResponse(response => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/bookings/' + id + '/reconcile');
    await card.getByRole('button', {name: 'Check Stripe payment'}).click();
    assert.equal((await check).status(), 200);
    assert.equal((await store.get(id)).paymentStatus, 'unpaid');
    await layout(page);
    assert.equal((await h.webhook(session)).status, 200);
    await page.locator('#applyFilters').click();
    await page.getByText('No matching reservations.').waitFor();
    assert.deepEqual(errors, []);
  });
}

test(engine + ' analytics loading, error, empty and expired-session states', pg, async t => {
  const f = await analyticsFixture(t);
  const {context, page, errors} = await open(t, f, 390);
  let fail = true;
  await context.route('**' + endpoint + '?**', async route => {
    if (fail) {
      fail = false;
      assert.match(route.request().url(), /preset=thisMonth/);
      return route.fulfill({status: 503, contentType: 'application/json', body: '{"error":"Analytics temporarily unavailable."}'});
    }
    return route.continue();
  });
  await login(page);
  await page.getByText('Analytics temporarily unavailable.', {exact: true}).waitFor();
  assert.equal(await page.locator('#analyticsResults').isVisible(), false);
  await page.locator('#analyticsDates').getByRole('button', {name: 'Reset Filter'}).click();
  await page.getByText('No trips match the applied dates and filters.', {exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: 'Export CSV'}).isDisabled(), true);
  assert.equal(await page.getByText('No activity in this period.', {exact: true}).count(), 5);
  await layout(page);
  f.h.advance(2 * 60 * 60 * 1000);
  await page.getByLabel('Quick date filter').selectOption('yesterday');
  await page.locator('#businessAnalytics').waitFor({state: 'hidden'});
  assert.equal(await page.locator('[data-metric]').count(), 0);
  assert.deepEqual(errors, []);
});
