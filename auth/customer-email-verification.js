'use strict';

const crypto = require('node:crypto');

const DRAFT_MS = 30 * 60 * 1000;
const MAX_DELIVERIES = 16;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ACCEPTED = 'If registration can continue, we’ll send a verification link.';
const INVALID = 'This verification link is invalid, expired, or already used. Please request a new link.';
const TEMPORARY = 'Email verification is temporarily unavailable. Please try again later.';
const randomToken = () => crypto.randomBytes(32).toString('base64url');

function exactKeys(body, allowed, required = allowed) {
  const keys = Object.keys(body);
  return keys.every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(body, key));
}

function namePart(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f<>]/.test(value)) return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > 0 && trimmed.length <= 60 && /\p{L}/u.test(trimmed) ? trimmed : null;
}

function installEmailVerification(app, {
  store, route, rateLimit, siteUrl, secure, now, clientKey, emailProvider, reportFailure,
  email, phone, passwordValid, hashPassword, verifyPassword, hashToken,
  requireCustomer, profile, makeSession, issueSession, currentSession
}) {
  const origin = new URL(siteUrl).origin;
  const browserCookie = secure ? '__Host-er_customer_enrollment' : 'er_customer_enrollment';
  const cookieOptions = {httpOnly: true, secure, sameSite: 'strict', path: '/'};
  let deliveries = 0;

  function mutation(req, res, next) {
    res.set({'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'});
    const site = req.get('sec-fetch-site');
    if (req.get('origin') !== origin || site && site !== 'same-origin' && site !== 'none' ||
        !req.is('application/json') || !req.body || Array.isArray(req.body) || typeof req.body !== 'object') {
      return res.status(403).json({error: 'Invalid request.'});
    }
    next();
  }

  function browserHash(req) {
    const matches = String(req.headers.cookie || '').split(';').map(item => item.trim())
      .filter(item => item.startsWith(browserCookie + '='));
    const raw = matches.length === 1 ? matches[0].slice(browserCookie.length + 1) : '';
    return TOKEN.test(raw) ? hashToken(raw) : null;
  }

  const canSend = () => emailProvider?.enabled === true && typeof emailProvider.sendEnrollmentLink === 'function';
  const accepted = (res, message = ACCEPTED) => res.status(202).json({message});
  const invalid = res => res.status(400).json({error: INVALID});
  const unavailable = res => res.status(503).json({error: TEMPORARY});
  const source = req => hashToken(clientKey(req));

  async function send(req, prepare, existing = false) {
    if (deliveries >= MAX_DELIVERIES) return;
    deliveries++;
    const token = randomToken();
    const tokenHash = hashToken(token);
    try {
      const recipient = await prepare(tokenHash);
      if (!recipient) return;
      let sent = false;
      try {
        await emailProvider.sendEnrollmentLink({email: recipient, token, attemptId: tokenHash, existing});
        sent = true;
      } catch (_) {
        reportFailure(req, 'resend');
      }
      if (existing) await store.finishExistingVerificationDelivery(tokenHash, sent);
      else await store.finishEnrollmentDelivery(tokenHash, sent);
    } catch (_) {
      reportFailure(req, 'postgresql');
    } finally {
      deliveries--;
    }
  }

  app.post('/api/customer/register', rateLimit('customer-register', 10, 15 * 60 * 1000), mutation, route(async (req, res) => {
    const b = req.body;
    if (!exactKeys(b, ['firstName','lastName','email','phone','password'])) {
      return res.status(400).json({error: 'Complete all required registration fields.'});
    }
    const first = namePart(b.firstName), last = namePart(b.lastName);
    const address = email(b.email), number = phone(b.phone);
    if (!first || !last || first.length + last.length + 1 > 120) return res.status(400).json({error: 'Enter a valid first and last name.'});
    if (!address) return res.status(400).json({error: 'Enter a valid email address.'});
    if (!number) return res.status(400).json({error: 'Enter a valid U.S. phone number.'});
    if (!passwordValid(b.password)) return res.status(400).json({error: 'Use a password between 10 and 128 characters.'});
    if (!canSend()) return unavailable(res);

    const passwordHash = await hashPassword(b.password);
    const browser = randomToken();
    const draft = {
      browserHash: hashToken(browser), fullName: first + ' ' + last,
      normalizedEmail: address.normalized, displayEmail: address.display, normalizedPhone: number.normalized, passwordHash
    };
    const sourceHash = source(req), requestedAt = now();
    res.cookie(browserCookie, browser, {...cookieOptions, maxAge: DRAFT_MS});
    accepted(res);
    void send(req, tokenHash => store.prepareEnrollment({...draft, tokenHash}, sourceHash, requestedAt));
  }));

  app.post('/api/customer/enrollment/resend', rateLimit('customer-enrollment-resend', 10, 15 * 60 * 1000), mutation, route((req, res) => {
    if (!exactKeys(req.body, [])) return res.status(400).json({error: 'Invalid request.'});
    if (!canSend()) return unavailable(res);
    const browser = browserHash(req), sourceHash = source(req), requestedAt = now();
    accepted(res);
    if (browser) void send(req, tokenHash => store.resendEnrollment({browserHash: browser, tokenHash}, sourceHash, requestedAt));
  }));

  app.post('/api/customer/enrollment/confirm', rateLimit('customer-enrollment-confirm', 20, 15 * 60 * 1000), mutation, route(async (req, res) => {
    const {token, password} = req.body;
    if (!exactKeys(req.body, ['token','password'], ['token']) || typeof token !== 'string' || !TOKEN.test(token)) return invalid(res);
    const tokenHash = hashToken(token);
    const challenge = await store.enrollmentForConfirmation(tokenHash, now());
    if (!challenge) return invalid(res);
    if (browserHash(req) !== challenge.browserHash &&
        (!passwordValid(password) || !await verifyPassword(password, challenge.passwordHash))) {
      return res.status(400).json({
        code: 'ENROLLMENT_PASSWORD_REQUIRED', error: 'Enter the password you chose when you registered.'
      });
    }

    const session = makeSession();
    const result = await store.activateEnrollment(tokenHash, session, now());
    if (!result) return invalid(res);
    res.clearCookie(browserCookie, cookieOptions);
    if (result.conflict) {
      return res.status(400).json({error: 'Unable to complete registration with these details. Please sign in or request a new link.'});
    }
    const oldSession = currentSession(req);
    if (oldSession) await store.revokeCustomerSession(hashToken(oldSession));
    issueSession(res, session);
    return res.status(201).json({customer: profile(result.customer)});
  }));

  app.post('/api/customer/email-verification/request', rateLimit('customer-existing-verification-send', 10, 15 * 60 * 1000),
    mutation, route(requireCustomer), route((req, res) => {
      if (!exactKeys(req.body, [])) return res.status(400).json({error: 'Invalid request.'});
      if (!canSend()) return unavailable(res);
      const owner = {customerId: req.customer.id, sessionHash: req.customerSessionHash};
      const sourceHash = source(req), requestedAt = now();
      accepted(res, 'If verification is needed, we’ll send a link to the email on your account.');
      void send(req, tokenHash => store.prepareExistingVerification({...owner, tokenHash}, sourceHash, requestedAt), true);
    }));

  app.post('/api/customer/email-verification/confirm', rateLimit('customer-existing-verification-confirm', 20, 15 * 60 * 1000),
    mutation, route(requireCustomer), route(async (req, res) => {
      const {token} = req.body;
      if (!exactKeys(req.body, ['token']) || typeof token !== 'string' || !TOKEN.test(token)) return invalid(res);
      const customer = await store.activateExistingVerification({
        customerId: req.customer.id, sessionHash: req.customerSessionHash, tokenHash: hashToken(token)
      }, now());
      return customer ? res.json({customer: profile(customer)}) : invalid(res);
    }));
}

module.exports = {installEmailVerification};
