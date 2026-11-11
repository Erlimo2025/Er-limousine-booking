'use strict';

const {ZONE, VEHICLES, summaryResult} = require('../services/dispatch-analytics');

const localDay = expression => '(' + expression + " AT TIME ZONE '" + ZONE + "')::date";
const instant = expression => "CASE WHEN " + expression + " ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*(Z|[+-][0-9]{2}:[0-9]{2})$' " +
  "AND pg_input_is_valid(" + expression + ", 'timestamptz') THEN (" + expression + ")::timestamptz END";
const tripDate = "r.record #>> '{trip,date}'";
const tripTime = "r.record #>> '{trip,time}'";
const wallTime = "(" + tripDate + ") || ' ' || (" + tripTime + ")";
const facts = `
  booking AS (
    SELECT r.id, r.booking_reference, r.archived_at IS NOT NULL AS archived,
      r.scheduled_start_at, r.created_at, ${localDay('r.created_at')} AS received_day,
      COALESCE(${localDay('r.scheduled_start_at')}, CASE
        WHEN (${tripDate}) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND pg_input_is_valid(${tripDate}, 'date')
        THEN (${tripDate})::date END) AS pickup_day,
      COALESCE(r.scheduled_start_at, CASE
        WHEN pg_input_is_valid(${wallTime}, 'timestamp') AND (${tripTime}) ~ '^[0-9]{2}:[0-9]{2}$'
        THEN ((${wallTime})::timestamp AT TIME ZONE '${ZONE}') END) AS pickup_at,
      r.record #>> '{trip,pickup}' AS pickup, r.record #>> '{trip,dropoff}' AS destination,
      r.record #>> '{trip,vehicle}' AS vehicle,
      r.record->>'status' AS status, r.record->>'paymentStatus' AS stored_payment,
      r.record->>'stripeSessionId' AS stripe_session_id,
      ${instant("r.record->>'paidAt'")} AS recorded_paid_at,
      ${instant("r.record->>'refundConfirmedAt'")} AS recorded_refund_at,
      COALESCE(r.record->>'refundStatus'='confirmed', false) AS claims_refund,
      COALESCE(r.record->>'paymentReviewRequired'='true' OR r.record #>> '{checkoutAttempt,state}'='review_required'
        OR r.record->>'refundStatus' IN ('failed','review_required'), false) AS needs_review,
      COALESCE(r.record #>> '{checkoutAttempt,state}'='submitted_unknown'
        OR r.record #>> '{checkoutAttempt,evidence}' IN ('payment_pending','verified_paid_awaiting_webhook'), false)
        OR (r.record #>> '{checkoutAttempt,firstSubmittedAt}' IS NOT NULL AND r.record->>'stripeSessionId' IS NULL
          AND (r.record #>> '{checkoutAttempt,state}') IS DISTINCT FROM 'confirmed_unpaid') AS payment_processing,
      CASE WHEN r.record #>> '{quote,currency}'='usd' AND jsonb_typeof(r.record #> '{quote,total}')='number'
        THEN CASE WHEN (r.record #>> '{quote,total}')::numeric > 0
          THEN ROUND((r.record #>> '{quote,total}')::numeric * 100) END END AS fare_cents
    FROM er_reservations r
  ),
  ledger AS (
    SELECT l.*, count(*) OVER (PARTITION BY stripe_session_id) AS session_uses
    FROM er_payment_ledger l
  ),
  captures AS (
    SELECT l.booking_id, l.paid_at, l.amount_cents, b.id AS reservation_id,
      COALESCE(b.scheduled_start_at IS NOT NULL AND b.stored_payment='paid' AND l.currency='usd'
        AND l.stripe_session_id ~ '^cs_[A-Za-z0-9_]+$' AND l.stripe_session_id=b.stripe_session_id
        AND l.session_uses=1 AND b.recorded_paid_at=l.paid_at AND l.paid_at >= b.created_at, false) AS verified
    FROM ledger l LEFT JOIN booking b ON b.id=l.booking_id
  ),
  refund_operations AS (
    SELECT booking_id, stripe_refund_id, amount_cents, currency, created_at, first_submitted_at,
      confirmed_at, state, evidence, false AS managed FROM er_reservation_refunds
    UNION ALL
    SELECT booking_id, stripe_refund_id, amount_cents, currency, created_at, first_submitted_at,
      confirmed_at, state, evidence, true AS managed FROM er_managed_cancellations
  ),
  refund_candidates AS (
    SELECT *, evidence='webhook_confirmed' OR (managed AND evidence='provider_api_confirmed') AS evidence_ok
    FROM refund_operations WHERE state='confirmed'
  ),
  unsettled_refunds AS (
    SELECT booking_id, min(COALESCE(first_submitted_at, created_at)) AS unknown_since
    FROM refund_operations
    WHERE state='submitted_unknown'
      OR (state='review_required' AND first_submitted_at IS NOT NULL)
      OR (state='provider_identified' AND evidence IN ('provider_succeeded_awaiting_webhook','provider_succeeded_awaiting_reconciliation'))
    GROUP BY booking_id
  ),
  refund_identity AS (
    SELECT stripe_refund_id, min(confirmed_at) AS confirmed_at,
      count(DISTINCT (booking_id, amount_cents, currency))=1
      AND bool_and(evidence_ok AND confirmed_at IS NOT NULL AND amount_cents>0 AND currency='usd'
        AND COALESCE(stripe_refund_id ~ '^re_[A-Za-z0-9_]+$', false)) AS verified
    FROM refund_candidates GROUP BY stripe_refund_id
  ),
  refunds AS (
    SELECT DISTINCT ON (r.booking_id, r.stripe_refund_id) r.booking_id, r.amount_cents, r.managed,
      f.confirmed_at, f.verified
    FROM refund_candidates r JOIN refund_identity f ON r.stripe_refund_id IS NOT DISTINCT FROM f.stripe_refund_id
    ORDER BY r.booking_id, r.stripe_refund_id, r.managed DESC
  ),
  refund_totals AS (
    SELECT booking_id, COALESCE(sum(amount_cents) FILTER (WHERE verified), 0) AS cents,
      count(*) FILTER (WHERE NOT verified) AS uncertain,
      count(*) FILTER (WHERE verified AND NOT managed) AS other_refunds
    FROM refunds GROUP BY booking_id
  ),
  trip_evidence AS (
    SELECT b.*, c.paid_at AS ledger_paid_at,
      CASE WHEN c.verified THEN c.amount_cents
        WHEN c.booking_id IS NULL AND b.stored_payment IN ('unpaid','failed') AND NOT b.payment_processing AND NOT b.needs_review
        THEN 0 END AS captured_cents,
      COALESCE(m.refunded_before_cents, 0) AS undated_refund_cents,
      m.created_at AS prior_refunds_observed_at,
      COALESCE(t.cents, 0) AS dated_refund_cents,
      u.unknown_since AS unsettled_refund_since,
      COALESCE(t.uncertain, 0)>0 AS invalid_refund,
      COALESCE(t.other_refunds, 0)>0 AND COALESCE(m.refunded_before_cents, 0)>0 AS refund_overlap,
      b.claims_refund AND COALESCE(t.cents, 0)=0 AS missing_refund,
      COALESCE(m.state IN ('review_required','failed') OR lr.state IN ('review_required','failed'), false) AS refund_review,
      COALESCE(m.state IN ('prepared','submitted_unknown','provider_identified')
        OR lr.state IN ('prepared','submitted_unknown','provider_identified'), false) AS refund_processing
    FROM booking b
    LEFT JOIN captures c ON c.booking_id=b.id
    LEFT JOIN refund_totals t ON t.booking_id=b.id
    LEFT JOIN unsettled_refunds u ON u.booking_id=b.id
    LEFT JOIN er_managed_cancellations m ON m.booking_id=b.id
    LEFT JOIN er_reservation_refunds lr ON lr.booking_id=b.id
  ),
  trip_money AS (
    SELECT e.*,
      COALESCE(dated_refund_cents + undated_refund_cents > captured_cents, false) AND NOT refund_overlap AS refund_amount_conflict,
      CASE WHEN NOT (invalid_refund OR refund_overlap OR missing_refund) AND unsettled_refund_since IS NULL
        AND (captured_cents IS NULL OR dated_refund_cents + undated_refund_cents <= captured_cents)
        THEN dated_refund_cents + undated_refund_cents END AS refunded_cents,
      CASE WHEN captured_cents >= fare_cents THEN 0
        WHEN NOT needs_review AND NOT refund_review AND NOT refund_processing AND NOT invalid_refund AND NOT missing_refund
          AND dated_refund_cents=0 AND undated_refund_cents=0 THEN fare_cents - captured_cents END AS balance_cents
    FROM trip_evidence e
  ),
  trips AS (
    SELECT m.*, CASE
      WHEN needs_review OR refund_review THEN 'review'
      WHEN payment_processing OR refund_processing THEN 'processing'
      WHEN captured_cents IS NULL OR refunded_cents IS NULL OR fare_cents IS NULL THEN 'review'
      WHEN refunded_cents > 0 AND refunded_cents=captured_cents THEN 'refunded'
      WHEN refunded_cents > 0 THEN 'partially_refunded'
      WHEN captured_cents >= fare_cents THEN 'paid'
      WHEN captured_cents > 0 THEN 'partially_paid'
      WHEN stored_payment='failed' THEN 'failed' ELSE 'unpaid'
    END AS payment_status
    FROM trip_money m
  )`;

const activitySql = `
WITH ${facts},
  params AS (
    SELECT $1::date AS first_day, $2::date AS last_day, $3::timestamptz AS as_of,
      ${localDay('$3::timestamptz')} AS today
  ),
  events AS (
    SELECT received_day AS day, 'received' AS kind, NULL::text AS state, fare_cents AS cents FROM booking
    UNION ALL SELECT pickup_day, 'pickup', status, fare_cents FROM booking
    UNION ALL SELECT pickup_day, 'upcoming', NULL, NULL FROM booking CROSS JOIN params
      WHERE status IN ('confirmed','assigned','driver_en_route') AND pickup_at > as_of
    UNION ALL SELECT pickup_day, 'balance', NULL, balance_cents FROM trips WHERE status<>'cancelled'
    UNION ALL SELECT ${localDay('q.created_at')}, 'request', q.status, NULL FROM er_reservation_management_requests q
    UNION ALL SELECT ${localDay('paid_at')}, 'capture', NULL, amount_cents FROM captures WHERE verified
    UNION ALL SELECT ${localDay('r.confirmed_at')}, 'refund', NULL, r.amount_cents
      FROM refunds r JOIN trips t ON t.id=r.booking_id WHERE r.verified AND NOT t.refund_amount_conflict
  ),
  coverage_gaps AS (
    SELECT 'payment_gap' AS kind, COALESCE(${localDay('recorded_paid_at')}, received_day) AS day,
      COALESCE(${localDay('recorded_paid_at')}, greatest(received_day, today)) AS last_day
    FROM trips CROSS JOIN params WHERE captured_cents IS NULL
    UNION ALL SELECT 'payment_gap', ${localDay('paid_at')}, ${localDay('paid_at')}
      FROM captures WHERE reservation_id IS NULL
    UNION ALL SELECT 'refund_gap',
      COALESCE(${localDay('r.confirmed_at')}, ${localDay('t.recorded_paid_at')}, t.received_day),
      COALESCE(${localDay('r.confirmed_at')}, greatest(t.received_day, today))
      FROM refunds r JOIN trips t ON t.id=r.booking_id CROSS JOIN params
      WHERE NOT r.verified OR t.refund_amount_conflict
    UNION ALL SELECT 'refund_gap', ${localDay('unsettled_refund_since')},
      greatest(${localDay('unsettled_refund_since')}, today)
      FROM trips CROSS JOIN params WHERE unsettled_refund_since IS NOT NULL
    UNION ALL SELECT 'refund_gap', COALESCE(${localDay('recorded_refund_at')}, ${localDay('recorded_paid_at')}, received_day),
      COALESCE(${localDay('recorded_refund_at')}, greatest(received_day, today))
      FROM trips CROSS JOIN params WHERE missing_refund
    UNION ALL SELECT 'refund_gap',
      least(COALESCE(${localDay('recorded_paid_at')}, received_day), ${localDay('prior_refunds_observed_at')}),
      ${localDay('prior_refunds_observed_at')}
      FROM trips WHERE undated_refund_cents>0
  )
SELECT to_char(day, 'YYYY-MM-DD') AS day, kind, state, count(*)::text AS count,
  COALESCE(sum(cents), 0)::text AS cents, count(*) FILTER (WHERE cents IS NULL)::text AS missing, NULL::text AS last_day
FROM events CROSS JOIN params WHERE day BETWEEN first_day AND last_day GROUP BY day, kind, state
UNION ALL
SELECT to_char(day, 'YYYY-MM-DD'), kind, NULL, count(*)::text, '0', '0', to_char(g.last_day, 'YYYY-MM-DD')
FROM coverage_gaps g CROSS JOIN params p WHERE g.day<=p.last_day AND g.last_day>=p.first_day
GROUP BY g.day, kind, g.last_day`;

const sortColumns = {
  reference: 'COALESCE(t.booking_reference, t.id::text)', pickupDate: 't.pickup_at', pickup: 'lower(t.pickup)',
  destination: 'lower(t.destination)', vehicle: 't.vehicle', status: 't.status', payment: 't.payment_status',
  fare: 't.fare_cents', captured: 't.captured_cents', refunded: 't.refunded_cents'
};

function tripQuery(input, paginated) {
  const values = [input.from, input.to];
  const bind = value => '$' + values.push(value);
  const conditions = ['pickup_day BETWEEN $1::date AND $2::date'];
  if (input.status !== 'all') conditions.push('status=' + bind(input.status));
  if (input.payment !== 'all') conditions.push('payment_status=' + bind(input.payment));
  if (input.vehicle !== 'all') conditions.push('vehicle=' + bind(input.vehicle));
  if (input.search) {
    const escaped = input.search.toLowerCase().replace(/[\\%_]/g, '\\$&');
    conditions.push("lower(concat_ws(' ', booking_reference, id::text, pickup, destination)) LIKE " +
      bind('%' + escaped + '%') + " ESCAPE E'\\\\'");
  }
  const sort = sortColumns[input.sort];
  const direction = input.order === 'asc' ? 'ASC' : 'DESC';
  const page = paginated ? ' LIMIT ' + bind(input.limit + 1) + ' OFFSET ' + bind((input.page - 1) * input.limit) : '';
  return {
    values,
    text: `WITH ${facts} SELECT id, booking_reference, archived, to_char(pickup_day, 'YYYY-MM-DD') AS pickup_date,
      pickup, destination, vehicle, status, payment_status, fare_cents::text, captured_cents::text, refunded_cents::text
      FROM trips t WHERE ${conditions.join(' AND ')} ORDER BY ${sort} ${direction} NULLS LAST, t.id${page}`
  };
}

const tripView = row => ({
  id: row.id, reference: row.booking_reference || row.id, archived: row.archived, pickupDate: row.pickup_date,
  pickup: row.pickup, destination: row.destination, vehicle: row.vehicle,
  vehicleLabel: Object.hasOwn(VEHICLES, row.vehicle) ? VEHICLES[row.vehicle] : 'Unavailable',
  status: row.status, paymentStatus: row.payment_status,
  fareCents: row.fare_cents, capturedCents: row.captured_cents, refundedCents: row.refunded_cents
});

function dispatchAnalyticsStorage(transaction) {
  function read(fn) {
    return transaction(async client => {
      await client.query('SET TRANSACTION READ ONLY');
      await client.query("SET LOCAL statement_timeout='12s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='15s'");
      return fn(client);
    });
  }
  return {
    dispatchAnalytics: input => read(async client => {
      const {rows} = await client.query(activitySql, [input.previous?.range.from || input.selected.from, input.selected.to, new Date(input.now)]);
      return summaryResult(rows, input);
    }),
    dispatchAnalyticsTrips: input => read(async client => {
      const query = tripQuery(input, true);
      const {rows} = await client.query(query.text, query.values);
      return {trips: rows.slice(0, input.limit).map(tripView), page: input.page, hasNext: rows.length > input.limit};
    }),
    exportDispatchAnalyticsTrips: (input, active, write) => read(async client => {
      const query = tripQuery(input, false);
      // One cursor preserves the query snapshot and avoids loading an entire export into Node.
      await client.query('DECLARE analytics_trips NO SCROLL CURSOR FOR ' + query.text, query.values);
      while (active()) {
        const {rows} = await client.query('FETCH FORWARD 250 FROM analytics_trips');
        if (!active()) break;
        await write(rows.map(tripView));
        if (rows.length < 250) break;
      }
    })
  };
}

module.exports = {dispatchAnalyticsStorage};
