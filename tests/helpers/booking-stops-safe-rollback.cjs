'use strict';

const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {existsSync} = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {harness, cookie} = require('./reservation-management.cjs');
const {createStore} = require('../../storage/postgres');

const approvedCommit = '39fba97cf1ced80c17770ade58788b36b85de1ec';
const featurePath = process.env.ER_TEST_STOP_FEATURE_CHECKOUT;
const unavailable = !process.env.ER_TEST_DATABASE_URL ? 'Requires isolated PostgreSQL' :
  !featurePath ? 'Set ER_TEST_STOP_FEATURE_CHECKOUT to the approved Add a Stop checkout' : false;

let fixtures;
function approvedFeature() {
  if (fixtures) return fixtures;
  assert.ok(path.isAbsolute(featurePath) && !existsSync(path.join(featurePath, '.env')));
  const git = (...args) => execFileSync('git', ['-C', featurePath, ...args], {encoding:'utf8', windowsHide:true}).trim();
  assert.equal(git('rev-parse', 'HEAD'), approvedCommit);
  assert.equal(git('status', '--porcelain=v1', '--untracked-files=all'), '');
  const {setup} = require(path.join(featurePath,'tests/helpers/reservation-management.cjs'));
  const {configure, trip, requested} = require(path.join(featurePath,'tests/helpers/booking-stops.cjs'));
  fixtures = {setup, configure, trip, requested};
  return fixtures;
}

async function stoppedBooking(t, {vehicle='suv', guest=false, paymentChoice='later', loseResponse=false}={}) {
  const {setup, configure, trip, requested} = approvedFeature();
  const feature = await setup(t, {ROUTE_TOLLS_ENABLED:'true', ROUTE_TOLLS_MODE:'estimate'});
  configure(feature.h);
  const owner = guest ? null : await feature.register({email:trip.email, phone:trip.phone});
  const input = {...trip, vehicle, stops:[requested('first',10), requested('second'), requested('third',15)]};
  const quote = await feature.post('/api/quote',input,owner);
  assert.equal(quote.status,200,JSON.stringify(quote.body));
  feature.h.state.loseResponse = loseResponse;
  const checkout = await feature.post('/api/checkout',{...input,paymentChoice,quoteRevision:quote.body.quoteRevision},owner);
  assert.equal(checkout.status,loseResponse ? 503 : 200);
  const {rows} = await feature.pool.query('SELECT id FROM er_reservations');
  assert.equal(rows.length,1);
  const id = rows[0].id;
  const accepted = await feature.store.getForDisplay(id);
  assert.match(accepted.bookingReference,/^ER-[0-9]{6}$/);
  assert.equal(accepted.quote.stopPlan.rateCentsPerMinute,150);
  assert.equal(accepted.quote.stopPlan.chargeCents,2250);
  assert.equal(accepted.quote.totalCents,quote.body.totalCents);
  return {feature,owner,id,accepted,input,checkout,quote:quote.body};
}

async function startRollback(t, feature, overrides={}) {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0,'127.0.0.1',resolve));
  const port = String(probe.address().port);
  await new Promise(resolve => probe.close(resolve));
  const origin = 'http://127.0.0.1:'+port;
  const store = createStore({}, feature.pool);
  const h = await harness(t,{PORT:port,SITE_URL:origin,ROUTE_TOLLS_ENABLED:'true',ROUTE_TOLLS_MODE:'estimate',
    BOOKING_EMAILS_ENABLED:'true',RESEND_API_KEY:'synthetic-resend-credential',
    CUSTOMER_RECOVERY_FROM:'test@erlimousineservice.com',...overrides},'[]',store);
  h.state.sessions = feature.h.state.sessions;
  h.state.refunds = feature.h.state.refunds;
  const request = (route,body,credentials) => h.request(route,body,{
    origin, 'sec-fetch-site':'same-origin', ...(credentials && {cookie:credentials})
  });
  async function adminLogin() {
    const response = await request('/api/admin/login',{token:'local-test-token'});
    assert.equal(response.status,200);
    return cookie(response,'er_admin_session');
  }
  return {h,store,request,adminLogin};
}

module.exports={unavailable, approvedFeature, stoppedBooking, startRollback};
