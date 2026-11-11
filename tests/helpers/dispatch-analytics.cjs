'use strict';

const crypto = require('node:crypto');
const {setup} = require('./reservation-management.cjs');

const endpoint = '/api/admin/business-analytics';
const dateQuery = (from, to, extra = {}) => new URLSearchParams({from, to, ...extra}).toString();

async function analyticsFixture(t) {
  const f = await setup(t);
  let next = 510000;

  async function trip(options = {}) {
    const id = crypto.randomUUID();
    const reference = 'ER-' + next++;
    const pickupAt = options.pickupAt || '2026-03-15T16:00:00.000Z';
    const pickupDate = options.pickupDate || '2026-03-15';
    const createdAt = options.createdAt || '2026-01-12T16:00:00.000Z';
    const fareCents = options.fareCents ?? 15000;
    const status = options.status || 'confirmed';
    const vehicle = options.vehicle || 'suv';
    const paid = options.capture !== undefined || options.legacyPaid === true;
    const paidAt = options.paidAt || '2026-02-15T16:00:00.000Z';
    const session = paid ? (options.session || 'cs_' + id.replaceAll('-', '')) : null;
    const record = {
      id, createdAt, status, paymentStatus: paid ? 'paid' : options.paymentStatus || 'unpaid', stripeSessionId: session,
      ...(paid && !options.omitPaidAt ? {paidAt} : {}),
      ...(options.refundStatus ? {refundStatus: options.refundStatus} : {}),
      ...(options.paymentReviewRequired ? {paymentReviewRequired: true} : {}),
      ...(options.checkoutAttempt ? {checkoutAttempt: options.checkoutAttempt} : {}),
      quote: {total: fareCents / 100, currency: 'usd', vehicle: vehicle === 'suv' ? 'Luxury SUV / Suburban' : 'Cadillac Escalade', vehicleKey: vehicle},
      trip: {date: pickupDate, time: '12:00', pickup: options.pickup || '1 Example Place, Newark, NJ',
        dropoff: options.destination || '2 Sample Avenue, New York, NY', tripType: 'oneway', vehicle, passengers: 1},
      customer: {firstName: 'Synthetic', lastName: 'Rider', email: 'rider@example.test', phone: '2015550140'},
      dispatch: {driver: '', driverPhone: '', vehicle: '', plate: ''}
    };
    await f.pool.query(
      'INSERT INTO er_reservations(id, record, created_at, scheduled_start_at, scheduled_end_at, booking_reference, archived_at, archived_by) VALUES($1,$2,$3,$4,$4,$5,$6,$7)',
      [id, record, createdAt, options.legacy ? null : pickupAt, reference, options.archived ? pickupAt : null, options.archived ? crypto.randomUUID() : null]);
    if (options.capture !== undefined) {
      const ledgerAt = options.omitPaidAt ? createdAt : paidAt;
      await f.pool.query('INSERT INTO er_payment_ledger(booking_id,amount_cents,currency,stripe_session_id,paid_at,retain_until) ' +
        "VALUES($1,$2,$3,$4,$5,$5::timestamptz+interval '7 years')",
      [id, options.capture, options.ledgerCurrency || 'usd', session, ledgerAt]);
    }
    return {id, reference, record, fareCents, paidAt, session, pickupAt};
  }

  async function request(reservation, status, createdAt) {
    await f.pool.query('INSERT INTO er_reservation_management_requests(id,booking_id,client_request_id,kind,details,trip_hash,created_at,status,reviewed_at,reviewer_id) ' +
      "VALUES($1,$2,$3,'cancellation','{}',$4,$5,$6,$7,$8)",
    [crypto.randomUUID(), reservation.id, crypto.randomUUID(), 'b'.repeat(64), createdAt, status,
      status === 'pending' ? null : createdAt, status === 'pending' ? null : crypto.randomUUID()]);
  }

  async function managedRefund(reservation, {amount, before = 0, state = 'confirmed', createdAt = '2026-03-10T16:00:00.000Z',
    confirmedAt = '2026-03-12T16:00:00.000Z', evidence = 'provider_api_confirmed', stripeRefundId} = {}) {
    const id = crypto.randomUUID();
    const refundId = stripeRefundId || 're_' + id.replaceAll('-', '');
    await f.pool.query('INSERT INTO er_managed_cancellations(id,booking_id,request_id,terms_revision,origin,pickup_at,fare_cents,captured_cents,' +
      'fee_percent,fee_cents,amount_cents,currency,stripe_session_id,payment_intent_id,charge_id,idempotency_key,state,evidence,stripe_refund_id,' +
      'first_submitted_at,submission_count,created_at,updated_at,confirmed_at,refunded_before_cents) ' +
      "VALUES($1,$2,$3,$4,'guest',$5,$6,$6,0,0,$7,'usd',$8,$9,$10,$11,$12,$13,$14,$15,1,$15,$15,$16,$17)",
    [id, reservation.id, crypto.randomUUID(), 'a'.repeat(64), reservation.pickupAt, reservation.fareCents, amount ?? reservation.fareCents,
      reservation.session, 'pi_' + id.replaceAll('-', ''), 'ch_' + id.replaceAll('-', ''), 'er-managed-cancel-' + id,
      state, evidence, refundId, createdAt, state === 'confirmed' ? confirmedAt : null, before]);
    return {id, refundId};
  }

  async function legacyRefund(reservation, customerId, {amount, confirmedAt = '2026-03-10T17:00:00.000Z', stripeRefundId,
    submittedAt = confirmedAt, state = 'confirmed', evidence = 'webhook_confirmed'} = {}) {
    const event = crypto.randomUUID(), id = crypto.randomUUID();
    await f.pool.query('INSERT INTO er_customer_trip_events(id,booking_id,customer_id,request_id,kind,old_start_at,new_start_at,old_end_at,new_end_at,details,created_at) ' +
      "VALUES($1,$2,$3,$4,'customer_cancelled',$5,$5,$5,$5,'{}',$6)",
    [event, reservation.id, customerId, crypto.randomUUID(), reservation.pickupAt, submittedAt]);
    const refundId = stripeRefundId || 're_' + id.replaceAll('-', '');
    await f.pool.query('INSERT INTO er_reservation_refunds(id,booking_id,customer_id,trip_event_id,stripe_session_id,payment_intent_id,charge_id,amount_cents,' +
      'currency,idempotency_key,state,stripe_refund_id,first_submitted_at,submission_count,evidence,created_at,updated_at,confirmed_at) ' +
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8,'usd',$9,$10,$11,$12,1,$13,$12,$12,$14)",
    [id, reservation.id, customerId, event, reservation.session, 'pi_' + id.replaceAll('-', ''),
      'ch_' + id.replaceAll('-', ''), amount ?? reservation.fareCents, 'er-refund-' + id, state, refundId,
      submittedAt, evidence, state === 'confirmed' ? confirmedAt : null]);
    return {id, refundId};
  }

  const setNow = instant => f.h.advance(Date.parse(instant) - Date.parse('2026-10-01T16:00:00Z'));
  return {...f, trip, request, managedRefund, legacyRefund, setNow};
}

module.exports = {analyticsFixture, dateQuery, endpoint};
