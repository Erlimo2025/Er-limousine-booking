'use strict';

const crypto = require('node:crypto');
const {isDeepStrictEqual} = require('node:util');
const {
  LINK_MINUTES, GRANT_MINUTES, ManagementError, normalizeGuestEmail, tripFingerprint
} = require('../services/reservation-management');

const MINUTE = 60000;
const unavailable = () => new ManagementError(404, 'Reservation unavailable.');

function reservationManagementStorage(transaction, safe, validateRecord, queryClient, assertActionLock) {
  const paymentLock = client => client.query('SELECT pg_advisory_xact_lock($1)', [730903]);
  async function ownedRow(client, authority, reference, now, write = false, paymentWrite = false) {
    const time = new Date(now);
    const reservationLock = write ? ' FOR UPDATE' : ' FOR SHARE';
    if (authority.kind === 'guest') {
      const access = (await client.query(
        'SELECT booking_id FROM er_reservation_management_access WHERE grant_hash=$1 AND grant_expires_at>$2 FOR SHARE',
        [authority.grantHash, time]
      )).rows[0];
      if (!access || (reference && reference !== access.booking_id)) return null;
      if (paymentWrite) await paymentLock(client);
      return (await client.query(
        'SELECT record FROM er_reservations WHERE id=$1 AND customer_id IS NULL' + reservationLock,
        [access.booking_id]
      )).rows[0] || null;
    }

    // Lock the account/session before the reservation, matching existing trip management.
    const active = (await client.query(
      "SELECT 1 FROM er_customer_sessions s JOIN er_customers c ON c.id=s.customer_id " +
      "WHERE c.id=$1 AND c.account_status='active' AND s.token_hash=$2 AND s.expires_at>$3 FOR SHARE OF c,s",
      [authority.customerId, authority.sessionHash, time]
    )).rowCount;
    if (!active) return null;
    if (paymentWrite) await paymentLock(client);
    return (await client.query(
      'SELECT record FROM er_reservations WHERE id=$1 AND customer_id=$2' + reservationLock,
      [reference, authority.customerId]
    )).rows[0] || null;
  }

  return {
    ...require('./reservation-self-service').reservationSelfServiceStorage({
      transaction, safe, validateRecord, queryClient, ownedRow, assertActionLock
    }),
    issueReservationVerification: (reference, email, linkHash, now) => transaction(async client => {
      const row = (await client.query(
        'SELECT record FROM er_reservations WHERE id=$1 AND customer_id IS NULL', [reference]
      )).rows[0];
      if (!row) return null;
      const record = validateRecord(row.record);
      if (normalizeGuestEmail(record.customer.email) !== email) return null;
      const issuedAt = new Date(now);
      // Reissuing a link never signs out a browser. A new verified exchange rotates the grant.
      const result = await client.query(
        'INSERT INTO er_reservation_management_access (booking_id,link_hash,issued_at,expires_at,window_started_at,issued_count) ' +
        'VALUES ($1,$2,$3,$4,$3,1) ON CONFLICT (booking_id) DO UPDATE SET link_hash=EXCLUDED.link_hash, ' +
        'issued_at=EXCLUDED.issued_at, expires_at=EXCLUDED.expires_at, used_at=NULL, ' +
        'window_started_at=CASE WHEN er_reservation_management_access.window_started_at <= $6 THEN $3 ' +
        'ELSE er_reservation_management_access.window_started_at END, ' +
        'issued_count=CASE WHEN er_reservation_management_access.window_started_at <= $6 THEN 1 ' +
        'ELSE er_reservation_management_access.issued_count+1 END ' +
        'WHERE er_reservation_management_access.issued_at <= $5 AND ' +
        '(er_reservation_management_access.issued_count < 4 OR er_reservation_management_access.window_started_at <= $6)',
        [reference, linkHash, issuedAt, new Date(now + LINK_MINUTES * MINUTE), new Date(now - MINUTE), new Date(now - 60 * MINUTE)]
      );
      return result.rowCount ? record.customer.email : null;
    }),

    exchangeReservationVerification: (linkHash, grantHash, now) => safe(async () => {
      const result = await queryClient().query(
        'UPDATE er_reservation_management_access a SET used_at=$3, grant_hash=$2, grant_expires_at=$4 ' +
        'FROM er_reservations r WHERE a.link_hash=$1 AND a.used_at IS NULL AND a.expires_at>$3 ' +
        'AND r.id=a.booking_id AND r.customer_id IS NULL RETURNING a.booking_id',
        [linkHash, grantHash, new Date(now), new Date(now + GRANT_MINUTES * MINUTE)]
      );
      return result.rowCount === 1;
    }),

    revokeReservationVerification: grantHash => safe(() => queryClient().query(
      'UPDATE er_reservation_management_access SET grant_hash=NULL, grant_expires_at=NULL WHERE grant_hash=$1', [grantHash]
    )),

    verifiedGuestReservation: (grantHash, reference, now) => safe(async () => {
      const result = await queryClient().query(
        'SELECT 1 FROM er_reservation_management_access a JOIN er_reservations r ON r.id=a.booking_id ' +
        'WHERE a.grant_hash=$1 AND a.booking_id=$2 AND a.grant_expires_at>$3 AND r.customer_id IS NULL',
        [grantHash, reference, new Date(now)]
      );
      return result.rowCount === 1;
    }),

    reservationManagementView: (authority, reference, now) => transaction(async client => {
      const row = await ownedRow(client, authority, reference, now);
      if (!row) return null;
      const record = validateRecord(row.record);
      const {rows} = await client.query(
        "SELECT * FROM er_reservation_management_requests WHERE booking_id=$1 " +
        "ORDER BY (status='pending') DESC, created_at DESC, id DESC LIMIT 20", [record.id]
      );
      return {record, requests: rows};
    }),

    submitReservationRequest: (authority, reference, input, now, checkChange) => transaction(async client => {
      const row = await ownedRow(client, authority, reference, now, true);
      if (!row) throw unavailable();
      const record = validateRecord(row.record);
      const previous = (await client.query(
        'SELECT * FROM er_reservation_management_requests WHERE booking_id=$1 AND client_request_id=$2',
        [record.id, input.requestId]
      )).rows[0];
      if (previous) {
        if (previous.kind !== input.kind || !isDeepStrictEqual(previous.details, input.details)) {
          throw new ManagementError(409, 'This request reference was already used. Refresh and try again.');
        }
        return previous;
      }
      await checkChange(record, client);
      const existing = await client.query(
        "SELECT 1 FROM er_reservation_management_requests WHERE booking_id=$1 AND status='pending'", [record.id]
      );
      if (existing.rowCount) throw new ManagementError(409, 'This reservation already has a pending request.');
      return (await client.query(
        'INSERT INTO er_reservation_management_requests ' +
        '(id,booking_id,customer_id,client_request_id,kind,details,trip_hash,created_at) ' +
        'VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *',
        [crypto.randomUUID(), record.id, authority.customerId || null, input.requestId,
          input.kind, JSON.stringify(input.details), tripFingerprint(record), new Date(now)]
      )).rows[0];
    }),

    listReservationRequests: (status, cursor, limit) => safe(async () => {
      const result = await queryClient().query(
        'SELECT q.*, r.record FROM er_reservation_management_requests q JOIN er_reservations r ON r.id=q.booking_id ' +
        'WHERE q.status=$1 AND ($2::timestamptz IS NULL OR (q.created_at,q.id)<($2,$3::uuid)) ' +
        'ORDER BY q.created_at DESC,q.id DESC LIMIT $4',
        [status, cursor?.date || null, cursor?.id || null, limit + 1]
      );
      return result.rows.map(row => ({...row, record: validateRecord(row.record)}));
    }),

    decideReservationRequest: (authority, id, status, now, checkApproval) => transaction(async client => {
      if (!authority?.authorized()) throw new ManagementError(401, 'Sign in to Dispatch.');
      const request = (await client.query(
        'SELECT booking_id FROM er_reservation_management_requests WHERE id=$1', [id]
      )).rows[0];
      if (!request) throw new ManagementError(404, 'Request unavailable.');
      const reservation = (await client.query(
        'SELECT record FROM er_reservations WHERE id=$1 FOR UPDATE', [request.booking_id]
      )).rows[0];
      const row = (await client.query(
        'SELECT * FROM er_reservation_management_requests WHERE id=$1 FOR UPDATE', [id]
      )).rows[0];
      if (!row || !reservation) throw new ManagementError(404, 'Request unavailable.');
      if (!authority.authorized()) throw new ManagementError(401, 'Sign in to Dispatch.');
      if (row.status === status) return row;
      if (row.status !== 'pending') throw new ManagementError(409, 'A decision has already been recorded.');
      if (status === 'approved') {
        const record = validateRecord(reservation.record);
        if (row.trip_hash !== tripFingerprint(record)) {
          throw new ManagementError(409, 'The reservation changed after this request. Decline it and ask the customer to submit a new request.');
        }
        const action = await checkApproval(record, row);
        if (!authority.authorized()) throw new ManagementError(401, 'Sign in to Dispatch.');
        if (action?.cancel === true) {
          await assertActionLock(record.checkoutFingerprint || 'reservation:' + record.id);
          if (row.kind !== 'cancellation' || record.status === 'cancelled' || action.proof?.safe !== true ||
              (action.proof.sessionId || null) !== (record.stripeSessionId || null)) throw new ManagementError(409, 'Cancellation needs Dispatch review.');
          row.cancellation_status_before = record.status;
          row.cancellation_applied_at = new Date(now);
          record.status = 'cancelled';
          record.cancellationReason = 'owner_approved_request';
          if (record.paymentStatus !== 'paid' && record.checkoutAttempt) Object.assign(record.checkoutAttempt,
            {state: 'confirmed_unpaid', evidence: 'verified_cancelled_unpaid', lastReconciledAt: now});
          validateRecord(record);
          await client.query('UPDATE er_reservations SET record=$2::jsonb,version=version+1,updated_at=$3 WHERE id=$1',
            [record.id, JSON.stringify(record), new Date(now)]);
        }
      }
      return (await client.query(
        'UPDATE er_reservation_management_requests SET status=$2,reviewed_at=$3,reviewer_id=$4,' +
        'cancellation_applied_at=$5,cancellation_status_before=$6 WHERE id=$1 RETURNING *',
        [id, status, new Date(now), authority.actorId, row.cancellation_applied_at || null, row.cancellation_status_before || null]
      )).rows[0];
    })
  };
}

module.exports = {reservationManagementStorage};
