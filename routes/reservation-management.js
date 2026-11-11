'use strict';

const {
  UUID, GRANT_MINUTES, LINK_MESSAGE, REQUEST_STATUSES, ManagementError, exactKeys,
  normalizeGuestEmail, guestToken, guestTokenHash, verificationEmail, parseRequest,
  checkProposedChange, requestView, reservationView, tripFingerprint
} = require('../services/reservation-management');
const {normalizeBookingReference} = require('../services/booking-reference');

const BASE = '/api/booking/manage';
const ADMIN = '/api/admin/reservation-requests';
const UNAVAILABLE = 'Reservation unavailable. Sign in to the owning account or verify guest access.';
const LINK_INVALID = 'This verification link is invalid, expired, or already used. Request a new link.';

function queueOptions(query) {
  const invalid = () => new ManagementError(400, 'Invalid reservation request filter.');
  const status = query.status ?? 'pending';
  if (!REQUEST_STATUSES.includes(status) || Object.keys(query).some(key => !['status', 'cursor'].includes(key))) {
    throw invalid();
  }
  if (query.cursor === undefined) return {status, cursor: null};
  if (typeof query.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(query.cursor)) throw invalid();
  try {
    const raw = Buffer.from(query.cursor, 'base64url');
    const cursor = JSON.parse(raw.toString('utf8'));
    if (raw.toString('base64url') !== query.cursor || !exactKeys(cursor, ['date', 'id']) ||
        typeof cursor.id !== 'string' || !UUID.test(cursor.id) || typeof cursor.date !== 'string' ||
        new Date(cursor.date).toISOString() !== cursor.date) throw invalid();
    return {status, cursor};
  } catch (_) {
    throw invalid();
  }
}

function installReservationManagement(app, options) {
  const {store, route, rateLimit, customerAuth, requireAdmin, siteUrl, secure, emailProvider,
    parseDateTime, now = Date.now, reportFailure = () => {}, verifyRequestedStops, selfService} = options;
  const origin = new URL(siteUrl).origin;
  const name = (secure ? '__Secure-' : '') + 'er_reservation_management';
  // The status and Pay Later routes need the same verified grant after a Stripe return.
  const cookieOptions = {httpOnly: true, secure, sameSite: 'strict', path: '/api/booking'};
  let emailJobs = 0;

  function privateResponse(req, res, next) {
    res.set({'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow'});
    next();
  }

  function mutation(req, res, next) {
    const site = req.get('sec-fetch-site');
    if (req.get('origin') !== origin || (site && !['same-origin', 'none'].includes(site)) ||
        !req.is('application/json') || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(403).json({error: 'Invalid request.'});
    }
    next();
  }

  function grantHash(req) {
    const cookies = String(req.headers.cookie || '').split(';').map(value => value.trim());
    const matches = cookies.filter(value => value.startsWith(name + '='));
    return matches.length === 1 ? guestTokenHash(matches[0].slice(name.length + 1)) : null;
  }

  const handle = action => route(async (req, res) => {
    try {
      await action(req, res);
    } catch (error) {
      if (!(error instanceof ManagementError)) throw error;
      res.status(error.status).json({error: error.message});
    }
  });

  app.use([BASE, ADMIN, '/manage-reservation.html'], privateResponse);
  app.use('/manage-reservation.html', (req, res, next) => {
    res.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    next();
  });

  app.post(BASE + '/verification/request', mutation,
    rateLimit('reservation-verify-send', 5), rateLimit('reservation-verify-send-hour', 20, 60 * 60000),
    handle(async (req, res) => {
      const {reference, email} = req.body;
      const normalized = normalizeGuestEmail(email);
      const selector = normalizeBookingReference(reference) ||
        (typeof reference === 'string' && UUID.test(reference) ? reference.toLowerCase() : null);
      if (!exactKeys(req.body, ['reference', 'email']) || !selector || !normalized) {
        throw new ManagementError(400, 'Enter your full reservation reference and booking email.');
      }
      if (!emailProvider?.enabled) throw new ManagementError(503, 'Guest verification is temporarily unavailable. Please contact ER Limousine Service.');
      // Respond before either lookup or delivery, regardless of who owns the reference.
      res.status(202).json({message: LINK_MESSAGE});
      if (emailJobs >= 24) return;
      emailJobs++;
      void (async () => {
        try {
          const token = guestToken();
          const recipient = await store.issueReservationVerification(selector, normalized, guestTokenHash(token), now());
          if (recipient) await emailProvider.sendBookingEmail(verificationEmail(origin, recipient, token));
        } catch (_) {
          reportFailure();
        } finally {
          emailJobs--;
        }
      })();
    })
  );

  app.post(BASE + '/verification/exchange', mutation, rateLimit('reservation-verify-exchange', 20), handle(async (req, res) => {
    const link = exactKeys(req.body, ['token']) ? guestTokenHash(req.body.token) : null;
    if (!link) throw new ManagementError(400, LINK_INVALID);
    const grant = guestToken();
    if (!await store.exchangeReservationVerification(link, guestTokenHash(grant), now())) {
      throw new ManagementError(400, LINK_INVALID);
    }
    res.cookie(name, grant, {...cookieOptions, maxAge: GRANT_MINUTES * 60000});
    res.json({ok: true});
  }));

  app.post(BASE + '/guest/sign-out', mutation, rateLimit('reservation-guest-signout', 20), handle(async (req, res) => {
    if (!exactKeys(req.body, [])) throw new ManagementError(400, 'Invalid request.');
    const grant = grantHash(req);
    res.clearCookie(name, cookieOptions);
    if (grant) await store.revokeReservationVerification(grant);
    res.json({ok: true});
  }));

  const automation = require('./reservation-self-service').reservationSelfService({
    app, store, mutation, rateLimit, handle, requireAdmin, adminPath: ADMIN, queueOptions, parseDateTime, now, ...selfService
  });

  for (const [kind, path] of [['guest', BASE + '/guest'], ['account', BASE + '/account/:id']]) {
    async function authorization(req, res) {
      if (kind === 'guest') {
        const hash = grantHash(req);
        if (!hash) throw new ManagementError(404, UNAVAILABLE);
        return {authority: {kind, grantHash: hash}, reference: null};
      }
      const reference = req.params.id;
      if (!UUID.test(reference)) throw new ManagementError(404, UNAVAILABLE);
      await customerAuth.resolve(req, res);
      if (!req.customer) throw new ManagementError(401, 'Sign in to view this account reservation.');
      return {
        authority: {kind, customerId: req.customer.id, sessionHash: req.customerSessionHash},
        reference: reference.toLowerCase()
      };
    }

    app.get(path, rateLimit('reservation-manage-view', 60), handle(async (req, res) => {
      const {authority, reference} = await authorization(req, res);
      const result = await store.reservationManagementView(authority, reference, now());
      if (!result) throw new ManagementError(404, UNAVAILABLE);
      res.json({
        reservation: reservationView(result.record, now(), parseDateTime, result.bookingReference, true),
        requests: result.requests.map(requestView),
        ...await automation.customerView(result.record, result.requests)
      });
    }));

    app.post(path + '/requests', mutation, rateLimit('reservation-manage-request', 15), handle(async (req, res) => {
      const {authority, reference} = await authorization(req, res);
      const input = parseRequest(req.body);
      let routeRevision;
      if (input.details.stops) {
        const current = await store.reservationManagementView(authority, reference, now());
        if (!current) throw new ManagementError(404, UNAVAILABLE);
        const previous = current.requests.find(request => request.client_request_id === input.requestId);
        if (!previous) checkProposedChange(current.record, input, now(), parseDateTime);
        routeRevision = tripFingerprint(current.record);
        if (input.details.stops.length) {
          try {
            const verified = await verifyRequestedStops(current.record,input.details,req);
            input.details.stops = Array.from(verified, ({address,placeId,waitMinutes}) => ({address,placeId,waitMinutes}));
          }
          catch (error) { throw new ManagementError(400,error.message); }
        }
      }
      const at = now();
      const saved = await store.submitReservationRequest(authority, reference, input, at, record => {
        if (routeRevision && routeRevision !== tripFingerprint(record)) {
          throw new ManagementError(409, 'This reservation changed. Refresh it before submitting a request.');
        }
        checkProposedChange(record, input, at, parseDateTime);
      });
      res.json({request: requestView(saved)});
    }));

    automation.customerRoutes(path, authorization);
  }

  app.get(ADMIN, requireAdmin, rateLimit('admin-reservation-requests', 60), handle(async (req, res) => {
    const {status, cursor} = queueOptions(req.query);
    const limit = 20;
    const rows = await store.listReservationRequests(status, cursor, limit);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const nextCursor = rows.length > limit ? Buffer.from(JSON.stringify({
      date: new Date(last.created_at).toISOString(), id: last.id
    })).toString('base64url') : null;
    res.json({nextCursor, requests: page.map(row => ({
      ...requestView(row),
      reservation: reservationView(row.record, now(), parseDateTime, row.booking_reference),
      source: row.customer_id ? 'account' : 'guest',
      reviewer: row.reviewer_id
    }))});
  }));

  app.post(ADMIN + '/:id/decision', requireAdmin, mutation, rateLimit('admin-reservation-decisions', 30), handle(async (req, res) => {
    if (!UUID.test(req.params.id) || !exactKeys(req.body, ['status', 'confirmed']) ||
        !['approved', 'declined'].includes(req.body.status) || req.body.confirmed !== true) {
      throw new ManagementError(400, 'Invalid decision.');
    }
    const at = now();
    const decide = () => store.decideReservationRequest(req.adminArchiveAuthority, req.params.id.toLowerCase(), req.body.status, at,
      async (record, row) => {
        const action = await automation.checkApproval(record, row, now());
        if (!action) checkProposedChange(record, row, now(), parseDateTime);
        return action;
      });
    const cancellation = await store.managedCancellationReview(req.params.id.toLowerCase());
    let saved;
    if (cancellation) {
      const record = await store.get(cancellation.booking_id);
      if (!record) throw new ManagementError(404, 'Request unavailable.');
      saved = await store.withActionLock(record.checkoutFingerprint || 'reservation:' + record.id, decide);
    } else saved = await decide();
    res.json({request: requestView(saved)});
  }));

  return {
    async verifiedGuest(req, reference) {
      const grant = grantHash(req);
      return !!grant && UUID.test(reference) && await store.verifiedGuestReservation(grant, reference.toLowerCase(), now());
    }
  };
}

module.exports = {installReservationManagement};
