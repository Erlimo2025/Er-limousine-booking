'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const {setup, harness, guestBooking, initialClock, cookie} = require('./helpers/reservation-management.cjs');
const {configure, requested, trip: stoppedTrip} = require('./helpers/booking-stops.cjs');

const trip = {...guestBooking, vehicle: 'escalade'};
const pg = {skip: !process.env.ER_TEST_DATABASE_URL && 'Requires isolated PostgreSQL'};
const cents = value => Math.round(value * 100);
const route = minutes => ({distanceMeters: 16093.44, duration: minutes * 60 + 's'});
const stripeAmount = h => h.state.creates.at(-1).params.line_items[0].price_data.unit_amount;
const authority = (h, credentials) => ({origin: h.url, 'sec-fetch-site': 'same-origin', cookie: credentials || ''});
const browserCookie = response => cookie(response, 'er_quote_browser') || cookie(response, '__Host-er_quote_browser');

async function review(h, input, credentials) {
  const response = await h.requestRaw('/api/quote', input, {cookie: credentials || ''});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(typeof response.body.quoteApproval, 'string');
  return {quote: response.body, credentials: credentials || browserCookie(response)};
}

function reserve(h, input, review, paymentChoice = 'now', extra = {}) {
  return h.requestRaw('/api/checkout', {
    ...input, paymentChoice, quoteApproval: review.quote.quoteApproval, quoteRevision: review.quote.quoteRevision, ...extra
  }, {cookie: review.credentials || ''});
}

function replacement(response, amount, reason) {
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'QUOTE_CHANGED');
  assert.equal(response.body.reason, reason);
  assert.equal(cents(response.body.quote.total), amount);
  assert.equal(response.body.bookingId, undefined);
  assert.equal(response.body.url, undefined);
  return response.body.quote;
}

test('the original $100 to $112.50 route change creates nothing until a new approval is submitted', pg, async t => {
  const {h, pool} = await setup(t, {ROUTE_TOLLS_ENABLED: 'false'});
  h.state.routeResult = () => route(20);
  const original = await review(h, trip);
  assert.equal(cents(original.quote.total), 10000);
  assert.ok(original.credentials);

  h.state.routeResult = () => route(30);
  const updated = replacement(await reserve(h, trip, original), 11250, 'route');
  replacement(await reserve(h, trip, original), 11250, 'route');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM er_reservations')).rows[0].count, 0);
  assert.equal(h.state.creates.length, 0);

  const accepted = await reserve(h, trip, {...original, quote: updated}, 'now', {
    total: 1, miles: 0, minutes: 0, currency: 'eur', waitingCharge: 0, tollAmount: 0
  });
  assert.equal(accepted.status, 200);
  const {rows: [row]} = await pool.query('SELECT record FROM er_reservations WHERE id=$1', [accepted.body.bookingId]);
  assert.equal(cents(row.record.quote.total), 11250);
  assert.equal(stripeAmount(h), 11250);
  assert.equal(row.record.quote.currency, 'usd');
  assert.equal(row.record.quote.minutes, 30);
  assert.match(row.record.quoteApprovalHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(row.record, 'quoteApproval'), false);
});

test('a missing, malformed or another browser’s approval cannot create a reservation', async t => {
  const h = await harness(t);
  const approved = await review(h, trip);
  const otherBrowser = await review(h, trip);
  assert.notEqual(approved.credentials, otherBrowser.credentials);
  for (const [quoteApproval, credentials] of [
    [undefined, approved.credentials],
    ['invalid-approval', approved.credentials],
    [approved.quote.quoteApproval, otherBrowser.credentials],
  ]) {
    replacement(await reserve(h, trip, {quote: approved.quote, credentials}, 'later', {quoteApproval}), 10000, 'review_required');
  }
  assert.equal(h.records().length, 0);
  assert.equal(h.state.creates.length, 0);
});

test('an approval is bound to the account session, including for an identical trip and price', pg, async t => {
  const f = await setup(t, {ROUTE_TOLLS_ENABLED: 'false'});
  const owner = await f.register();
  const other = await f.register({email: 'second-quote-owner@example.test', phone: '2015550183'});
  const approved = await review(f.h, trip, owner);
  replacement(await reserve(f.h, trip, {...approved, credentials: other}, 'later'), 10000, 'review_required');
  assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM er_reservations')).rows[0].count, 0);
  const accepted = await reserve(f.h, trip, approved, 'later');
  assert.equal(accepted.status, 200);
  const {rows: [saved]} = await f.pool.query('SELECT customer_id FROM er_reservations WHERE id=$1', [accepted.body.bookingId]);
  assert.ok(saved.customer_id);
});

test('pickup, destination, date, passenger count and vehicle edits need a matching review', async t => {
  const h = await harness(t);
  const approved = await review(h, trip);
  for (const changes of [
    {pickup: 'Newark, NJ'}, {dropoff: 'Jersey City, NJ'}, {date: '2026-11-11'}, {time: '14:00'},
    {passengers: 5}, {vehicle: 'suv'}, {tripType: 'hourly', hours: 3}, {email: 'another-review@example.test'}
  ]) {
    const response = await reserve(h, {...trip, ...changes}, approved, 'later');
    assert.equal(response.status, 409);
    assert.equal(response.body.reason, 'review_required');
  }
  assert.equal(h.records().length, 0);
  assert.equal(h.state.creates.length, 0);
});

test('approval expiration at fifteen minutes refreshes the quote without creating a reservation', async t => {
  const h = await harness(t);
  const approved = await review(h, trip);
  h.advance(15 * 60000);
  const refreshed = replacement(await reserve(h, trip, approved, 'later'), 10000, 'expired');
  assert.equal(h.records().length, 0);
  assert.equal(h.state.creates.length, 0);
  assert.equal((await reserve(h, trip, {...approved, quote: refreshed}, 'later')).status, 200);
  assert.equal(cents(h.records()[0].quote.total), 10000);
});

test('a quote whose review window ends during provider work cannot create a reservation', async t => {
  const h = await harness(t);
  const approved = await review(h, trip);
  h.advance(15 * 60000 - 1);
  h.state.onGoogle = () => {h.advance(1);};
  replacement(await reserve(h, trip, approved), 10000, 'expired');
  assert.equal(h.records().length, 0);
  assert.equal(h.state.creates.length, 0);
});

test('stops, their order and planned waiting remain bound to the quoted route and charge', async t => {
  const h = await harness(t);
  configure(h);
  const stops = [requested('first', 10), requested('second', 15)];
  const input = {...stoppedTrip, stops};
  const reviewed = await review(h, input);
  assert.equal(reviewed.quote.stopSummary.billableMinutes, 15);
  assert.equal(reviewed.quote.stopSummary.rateCentsPerMinute, 150);
  assert.equal(reviewed.quote.stopSummary.chargeCents, 2250);
  const reversed = {...input, stops: [...stops].reverse()};
  const changed = await reserve(h, reversed, reviewed, 'later');
  assert.equal(changed.status, 409);
  assert.deepEqual(changed.body.quote.stopSummary.stops.map(stop => stop.address), reviewed.quote.stopSummary.stops.map(stop => stop.address).reverse());
  const waiting = {...input, stops: [requested('first', 20), stops[1]]};
  const changedWait = await reserve(h, waiting, reviewed, 'later');
  assert.equal(changedWait.status, 409);
  assert.equal(changedWait.body.quote.stopSummary.chargeCents, 3750);
  assert.equal(h.records().length, 0);
  const saved = await reserve(h, waiting, {...reviewed, quote: changedWait.body.quote}, 'later');
  assert.equal(saved.status, 200);
  assert.equal(h.records()[0].quote.stopPlan.chargeCents, 3750);
  assert.deepEqual(h.state.routes.at(-1).intermediates.map(point => point.placeId), waiting.stops.map(stop => stop.placeId));
});

test('unchanged airport, hourly, round-trip and FIRST15 quotes reserve at their reviewed amounts', async t => {
  for (const changes of [
    {tripType: 'airport', vehicle: 'suv'},
    {tripType: 'hourly', hours: 3, vehicle: 'escalade'},
    {tripType: 'roundtrip', returnDate: '2026-11-12', returnTime: '18:00', vehicle: 'suv'},
    {promoCode: 'FIRST15'}
  ]) {
    const h = await harness(t);
    const input = {...trip, ...changes};
    const approved = await review(h, input);
    const result = await reserve(h, input, approved);
    assert.equal(result.status, 200);
    assert.equal(cents(h.records()[0].quote.total), cents(approved.quote.total));
    assert.equal(stripeAmount(h), cents(approved.quote.total));
    if (changes.promoCode) {
      assert.equal(approved.quote.promotion.code, 'FIRST15');
      assert.equal(approved.quote.promotion.percentOff, 15);
    }
  }
});

test('the nonstop EWR special remains exactly $150 including tolls and excluding FIRST15', async t => {
  const h = await harness(t);
  const input = {...trip, vehicle: 'suv', offerCode: 'EWR_MANHATTAN_SUV', promoCode: 'FIRST15'};
  const approved = await review(h, input);
  assert.equal(approved.quote.total, 150);
  assert.equal(approved.quote.tolls.status, 'included');
  assert.equal(approved.quote.promotion, null);
  assert.equal((await reserve(h, input, approved)).status, 200);
  assert.equal(stripeAmount(h), 15000);
});

test('account Pay Later and Complete Payment keep the stored fare after routing and pricing change', pg, async t => {
  const f = await setup(t, {ROUTE_TOLLS_ENABLED: 'false'});
  const owner = await f.register();
  const approved = await review(f.h, trip, owner);
  const reserved = await reserve(f.h, trip, approved, 'later');
  assert.equal(reserved.status, 200);
  assert.equal(f.h.state.creates.length, 0);

  f.h.state.routeResult = () => route(90);
  vm.runInContext('pricing.vehicleRates.escalade.perMinute = 2;', f.h.context);
  f.h.advance(16 * 60000);
  const calls = f.h.state.googleCalls;
  const complete = await f.post('/api/customer/trips/' + reserved.body.bookingId + '/payment', {}, owner);
  assert.equal(complete.status, 200);
  assert.equal(stripeAmount(f.h), 10000);
  assert.equal(f.h.state.googleCalls, calls);
  assert.equal(cents((await f.store.getForDisplay(reserved.body.bookingId)).quote.total), 10000);
});

test('guest completion uses the stored legacy fare through an expired session and repeated signed events', pg, async t => {
  const f = await setup(t);
  const approved = await review(f.h, trip);
  const reserved = await reserve(f.h, trip, approved, 'later');
  assert.equal(reserved.status, 200);
  const id = reserved.body.bookingId;
  const access = reserved.headers.getSetCookie().find(value => value.startsWith('er_booking_access_')).split(';')[0];
  // Model a pre-correction reservation in the temporary database.
  await f.store.update(id, record => {delete record.quoteApprovalHash;});
  f.h.state.routeResult = () => route(90);

  const complete = () => f.h.requestRaw('/api/booking/' + id + '/checkout', {}, authority(f.h, access));
  assert.equal((await complete()).status, 200);
  assert.equal(stripeAmount(f.h), 10000);
  assert.equal((await complete()).status, 200);
  assert.equal(f.h.state.sessions.size, 1);
  [...f.h.state.sessions.values()][0].status = 'expired';
  assert.equal((await complete()).status, 200);
  assert.equal(f.h.state.sessions.size, 2);
  assert.equal(stripeAmount(f.h), 10000);
  const session = [...f.h.state.sessions.values()].at(-1);
  Object.assign(session, {status: 'complete', payment_status: 'paid'});
  assert.equal((await f.h.webhook(session)).status, 200);
  assert.equal((await f.h.webhook(session)).status, 200);
  const {rows: [ledger]} = await f.pool.query('SELECT count(*)::int AS count, max(amount_cents)::int AS amount FROM er_payment_ledger WHERE booking_id=$1', [id]);
  assert.deepEqual(ledger, {count: 1, amount: 10000});
});

test('concurrent requests create one reservation and one Stripe session for the reviewed fare', pg, async t => {
  const {h, pool} = await setup(t);
  const approved = await review(h, trip);
  h.state.createDelay = 80;
  const results = await Promise.all([reserve(h, trip, approved), reserve(h, trip, approved)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 503]);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM er_reservations')).rows[0].count, 1);
  assert.equal(h.state.creates.length, 1);
  assert.equal(h.state.sessions.size, 1);
  assert.equal(stripeAmount(h), 10000);
});

test('an authorized retry after a lost Stripe response and app restart uses one accepted payment', pg, async t => {
  const f = await setup(t);
  const approved = await review(f.h, trip);
  f.h.state.loseResponse = true;
  const interrupted = await reserve(f.h, trip, approved);
  assert.equal(interrupted.status, 503);
  const checkoutCookie = interrupted.headers.getSetCookie().find(value => value.startsWith('er_checkout_access_')).split(';')[0];
  const restarted = await harness(t, {ROUTE_TOLLS_ENABLED: 'false'}, '[]', f.store, initialClock + 16 * 60000);
  restarted.state.sessions = f.h.state.sessions;
  restarted.state.routeResult = () => route(90);
  const result = await reserve(restarted, trip, {...approved, credentials: checkoutCookie});
  assert.equal(result.status, 200);
  assert.equal(restarted.state.googleCalls, 0);
  assert.equal(restarted.state.creates[0].options.idempotencyKey, f.h.state.creates[0].options.idempotencyKey);
  assert.equal(stripeAmount(restarted), 10000);
  assert.equal(restarted.state.sessions.size, 1);
  assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM er_reservations')).rows[0].count, 1);
});


test('an unaccepted preview cannot be used after a server rate change', async t => {
  const h = await harness(t);
  const approved = await review(h, trip);
  vm.runInContext('pricing.vehicleRates.escalade.perMinute = 1.50;', h.context);
  const updated = replacement(await reserve(h, trip, approved), 10500, 'review_required');
  assert.equal(h.records().length, 0);
  assert.equal(h.state.creates.length, 0);
  assert.equal((await reserve(h, trip, {...approved, quote: updated})).status, 200);
  assert.equal(stripeAmount(h), 10500);
});

test('a new form quote for an owned reservation opens its saved summary before payment', async t => {
  const h = await harness(t);
  const approved = await review(h, trip);
  const booked = await reserve(h, trip, approved, 'later');
  assert.equal(booked.status, 200);
  const access = booked.headers.getSetCookie().find(value => value.startsWith('er_checkout_access_')).split(';')[0];

  h.state.routeResult = () => route(30);
  const updated = await review(h, trip, approved.credentials);
  assert.equal(updated.quote.total, 112.5);
  const result = await reserve(h, trip, {...updated, credentials: approved.credentials + '; ' + access});
  assert.equal(result.status, 200);
  assert.equal(result.body.bookingId, booked.body.bookingId);
  assert.match(result.body.url, /\/success\.html\?booking=/);
  assert.equal(h.records().length, 1);
  assert.equal(h.records()[0].quote.total, 100);
  assert.equal(h.state.creates.length, 0);
});
