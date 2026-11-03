# Admin Dispatch payment links

Manage Dispatch adds **Send Payment Link** and **Copy Payment Link** using the
existing buttons, colors, fonts, cards and responsive styles. No CSS or booking
form changes. Send requires confirmation of the reservation's stored email;
there is no recipient, fare or customer-ID override. Copy supports the clipboard
and an existing-style readonly manual-copy fallback. Private results are cleared
on logout/navigation and stale responses cannot populate a new session's UI.

## Scope and authority

- `POST /api/bookings/:id/payment-link/copy` accepts only `{}`.
- `POST /api/bookings/:id/payment-link/email` accepts only `{"confirmed":true}`.
- Both require the current authorized admin cookie, exact site Origin, JSON,
  Fetch Metadata checks, no-store responses and request limits. No bearer admin
  token, customer session, matching email/phone or reservation ID authorizes them.
- They load an existing reservation and use its saved fare through the existing
  Checkout state machine/action lock. They never create a reservation, reprice,
  attach customer ownership, charge a card automatically or collect card data.
- The shared URL is the specific **Stripe Checkout Session URL**, not a reusable
  Stripe Payment Links product, account token, booking-access cookie or invitation.
  Only `https://checkout.stripe.com` session URLs are accepted. Custom Checkout
  domains are not enabled by this change and require a separate reviewed allowlist.
- Open sessions are verified/reused, expired/unpaid sessions can be replaced,
  lost creation responses retry the persisted idempotency key, and unknown or
  processing/paid provider states fail closed. A paid/cancelled/review reservation
  cannot obtain another link. Completed unpaid trips can still be collected.
- An active Checkout attached to a Stripe Customer/saved cards is **not shared**.
  The customer can use authenticated Complete Payment. After verified unpaid
  expiry, an admin can create an unbound payment-only session. No customer/account
  ownership follows the payer's email or phone.
- New admin sessions return to a neutral, script-free payment-information page;
  it has no booking/account API access and cannot claim Paid from return parameters.
  An existing reused session retains its frozen return URLs; its original booking
  status page still requires its original owner/guest credentials.

Only the existing verified signed webhook can establish Paid and queue customer
and company confirmations. Signature checks, amount/session association, ledger,
notification deduplication, Pay Now/Pay Later, saved cards, refunds, promotions,
hourly and the qualifying $150 EWR special remain unchanged.

Cancellation uses the existing shared lock and verified Checkout expiration.
Once cancellation safely expires an open session, the shared URL cannot pay it.
A payment already completing externally during cancellation cannot be reversed
by a URL: the existing cancelled/paid review state and truthful notifications
remain authoritative, without an automatic refund or accepted active booking.
No cancellation/refund eligibility rule is changed.

## Delivery, migration and rollback

Migration **011-admin-payment-links.sql** adds only `er_admin_payment_links`:
one audit/delivery row per reservation/Stripe session, server-owned admin actor
IDs and timestamps, expiry, immutable queued email payload, lease, retry state
and provider-idempotency timing. No historical reservation is erased, rewritten
or backfilled. Existing notification tables/constraints are untouched.

The existing booking-email worker/provider is reused with a separate durable
queue. Repeated Send clicks, retries or tabs do not send another email for the
same Checkout session; Copy remains available for sharing again. A newly verified
replacement session can have a new delivery. Queue acceptance is not a promise
of inbox delivery. Failures retry the exact message/provider key within the
existing 23-hour ambiguity window; uncertain older delivery requires review.
Paid/cancelled/superseded/expired queued links are suppressed. Payloads are
cleared after delivery/retirement. URLs and sensitive credentials are not logged.

Email requires the **existing** booking-email provider configuration:
`BOOKING_EMAILS_ENABLED=true` (or its existing recovery-enabled default), Resend
configuration and company contact. No new key/service/flag is introduced. If
email is disabled, Send fails before Checkout creation and Copy can still work.
This local implementation does not change Render/production configuration.

Rollback: stop new link generation/delivery, retain the additive table and audit
records, and roll back application code. Old reservation/outbox schemas remain
compatible. Keep the neutral static return page available for already issued
Checkout sessions until they settle/expire. Old code will not deliver this new
queue; pending records remain for reviewed recovery. Do not delete data or undo
verified payments. Migration has been intended for isolated local testing only.

## Verification

Targeted API/security tests cover auth/origin/body rejection, stored amounts,
concurrent clicks, guest/customer ownership isolation, card-bound session denial,
expiry/retry/unknown provider states, cancellation, signed-webhook-only authority,
email dedup/ambiguity, admin revocation, EWR/FIRST15, and no credentials in logs.
PostgreSQL tests cover migration replay, relational ownership, persisted delivery,
cross-worker action locks, leases, frozen payloads and transaction rollback.
Browser tests at 320/390/1440px cover Manage Dispatch placement, confirmation,
copy/manual fallback, duplicate actions, state visibility, stale logout responses,
CSP and overflow. Providers and customer data are isolated fixtures.

Reference: [Stripe customer Checkout documentation](https://docs.stripe.com/payments/existing-customers?platform=web&ui=stripe-hosted)
explains that Customer-bound Checkout can expose saved-card choices and that
verified webhook events, rather than browser returns, drive payment fulfillment.

## Local validation — November 3, 2026

| Selection | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Targeted admin/payment/customer/email/security | 214 | 0 | 0 |
| Full sequential regression | 675 | 0 | 0 |
| Separate isolated PostgreSQL | 50 | 0 | 0 |
| Separate CSP/security headers | 5 | 0 | 0 |
| Complete Chromium browser matrix | 134 | 0 | 0 |

The browser matrix includes six new Admin Dispatch checks plus 128 existing
booking, payment, toll, date and calendar cases. All tests ran sequentially.
The local PostgreSQL cluster was stopped afterward. No production database,
live Stripe, live Google request or real email delivery was used. These totals
are overlapping test selections, not additive counts of distinct tests.

## Changed files

Application/schema: `public/admin.js`, `public/payment-link-result.html`,
`server.js`, `services/admin-payment-links.js`, `storage/admin-payment-links.js`,
`storage/admin-reservations.js`, `storage/postgres.js`,
`migrations/011-admin-payment-links.sql`.

Tests/fixtures: `tests/admin-payment-links.test.cjs`,
`tests/browser/admin-payment-links.cjs`, `tests/customer-trip-management.test.cjs`,
`tests/helpers/admin-payment-link-memory.cjs`, `tests/helpers/memory-storage.cjs`,
`tests/security-abuse.test.cjs`, `tests/seo.test.cjs`,
`tests/storage-postgres.test.cjs`.

Documentation: this file. No files have been staged, committed, pushed or deployed.
