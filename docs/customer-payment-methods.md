# Customer saved payment methods — Phase 1A

This is a backend-only foundation. No account payment page, saved-card booking,
off-session charging, Checkout integration or payment webhook change is included.
Stripe alone collects card data in a future Stripe.js/Elements page. Application
APIs must never accept card numbers, CVC or billing addresses.

## Configuration

`CUSTOMER_PAYMENT_METHODS_ENABLED=true` explicitly enables the routes. Absent,
blank and other values leave them disabled. Enabled routes fail closed unless
the existing Stripe client and a valid canonical `SITE_URL` are configured.
Production requires HTTPS; links/ownership never derive from the Host header.
The existing private `STRIPE_SECRET_KEY` is reused server-side.
`STRIPE_PUBLISHABLE_KEY` is a blank placeholder for the future frontend and is
not required or returned by this backend release. No new dependency is added.

## Persistence and provisioning

Migration 007 runs inside the existing transactional/advisory-locked migration
runner. Migrations 001–006 are unchanged. Three separate tables hold:

- One customer mapping: customer UUID FK, unique nullable Stripe Customer ID,
  random provisioning UUID, state, provider live/test mode and timestamps.
- Setup attempts: random UUID, customer FK, unique nullable SetupIntent ID,
  consent/submission/expiry timestamps and fixed states.
- Shared rate counters keyed by SHA-256 customer/client scope, operation and
  window. No raw IP or customer PII is stored in those counters.

Foreign keys use RESTRICT. A partial unique index permits at most one active
or unresolved setup per account. No card data, fingerprint, billing details,
client secret or full provider payload is persisted.

Customers are created lazily after explicit consent, never searched by email
or phone. A server-owned provisioning UUID is committed before the Stripe call.
Per-account session advisory locks serialize workers; short transactions validate
active account/session and persist state. Stripe calls run outside transactions,
with an 8-second SDK timeout and automatic retries disabled.

Ambiguous responses and persistence failures reuse exactly the same idempotency
key and parameters on a later request, including after worker restart. Unknown
submissions aged 23 hours enter `review_required` instead of risking duplicates
after Stripe's idempotency retention period. These cases need a separately
reviewed operator recovery procedure; no unsafe automatic reset is provided.
See [Stripe idempotency](https://docs.stripe.com/api/idempotent_requests).

## Authenticated APIs

All routes require existing customer session authentication, no-store responses
and no-referrer. Mutations require exact canonical Origin, JSON, safe Fetch
Metadata and an explicit body allowlist. Admin sessions confer no authority.

- `POST /api/customer/payment-methods/setup`: only `{ "consent": true }`;
  returns `{ attempt, clientSecret }`. Creates/reuses a server-owned card-only,
  `on_session` SetupIntent for the mapped customer. Never logs/persists its secret.
- `POST /api/customer/payment-methods/setup/:attempt/verify`: empty JSON;
  retrieves Stripe's SetupIntent and customer-scoped PaymentMethod, checks
  succeeded status, exact ownership, live mode, card type and server correlation,
  then returns `{ ok: true }`. Browser success claims are rejected.
- `GET /api/customer/payment-methods`: array with only `id`, `brand`, `last4`,
  `expMonth`, `expYear`; default 20, maximum 50. A customer-scoped `cursor` and
  `X-Payment-Methods-Next` response header support pagination. The opaque Stripe
  PaymentMethod reference is only a selector, never proof of ownership.
- `DELETE /api/customer/payment-methods/:id`: empty JSON; customer-scoped
  retrieval plus ownership/type checks before detach. Foreign, nonexistent and
  already-detached references produce the same `{ ok: true }` no-op.

Attempts expire after 30 minutes without extension. Known expired pending
SetupIntents are canceled before replacement in the same setup request. Completed
attempts are reconciled to `succeeded` when the card remains owned, or `cancelled`
when customer-scoped retrieval conclusively finds no attached card. Detached cards
are never treated as saved. These terminal states leave the active uniqueness
index and allow a new attempt subject to the existing cooldown. Processing or ambiguous attempts
remain blocked until conclusively resolved. A successful SetupIntent can be
verified again safely. New attempts require a 60-second cooldown. Session
authority is rechecked after provider work before returning a client secret.

## Shared limits

Per-operation customer/client maxima:

| Operation | Customer | Client | Window |
| --- | ---: | ---: | --- |
| Setup | 20 | 40 | 15 minutes |
| Verify | 30 | 60 | 15 minutes |
| List | 60 | 120 | 1 minute |
| Remove | 20 | 40 | 15 minutes |

Atomic PostgreSQL counters enforce both scopes across workers. Customer payment
traffic also triggers bounded expired-counter cleanup: at most
100 rows per worker per 30 seconds, selected by an expiry index with row locks
and SKIP LOCKED in a separate short transaction. Live counters are never deleted;
cleanup needs no cron and drains expired rows during continued payment API traffic.
Existing broader customer/API protections remain. Lock contention returns a generic retry error.
Provider/storage exceptions are sanitized to fixed reference-ID errors; no
request body, IDs, secrets, card metadata, PII or provider payload is logged.

## Local verification and later work

Tests mock Stripe and use disposable schemas on explicitly isolated localhost
PostgreSQL. They cover concurrency, durable lost-response retries, transaction
rollback, network outside transactions, ownership, safe DTOs, limits, origin
checks, revocation and existing booking regressions. No live provider is called.

The frontend, reviewed Stripe.js/CSP integration and eventual saved-card booking
flow remain separate phases. Enabling production or resolving review-required
attempts is outside this implementation. FIRST15 stays 15%; guest bookings,
EWR, pricing, My Trips and existing Checkout/webhook authority are unchanged.
