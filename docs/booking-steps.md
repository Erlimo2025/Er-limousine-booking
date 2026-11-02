# Three-step booking

This change reorganizes the existing booking form on mobile and desktop:

1. **Trip Details** keeps the existing service types, addresses/autocomplete/GPS,
   independent airport terminals, date/time, return fields, hours, passengers,
   vehicle and flight information.
2. **Customer Information** keeps names, email, phone, requests and promo code.
   Continue validates both panels and requests a fresh `/api/quote`. Applying a
   promo can preview its result but cannot unlock payment in this step.
3. **Trip Summary & Payment** contains the only summary, inside the form. It
   displays the selected trip, pickup/return times in New York time, total route
   distance and estimated drive time (booked hours for hourly service). The only
   pricing rows are Trip Fare, Tolls and Total, followed by both reserve actions.

## Quote and payment safety

All fares, eligibility, promotions and tolls still come from the unchanged
backend. Existing surcharges, discounts and gratuity are folded into the
displayed net Trip Fare; no calculation order is changed. The qualifying EWR
special stays exactly 15000 cents, tolls included, with its existing restrictions.

Unknown toll estimates retain the existing company-includes fallback. A
legacy/flag-off or hourly quote without a separate toll snapshot also displays
its server total unchanged with Tolls Included. This does not create a zero
estimate or add a charge. No toll or admin feature flag is changed or enabled.

The browser binds each response to the complete current form, including customer
identity, notes, service fields and place/terminal identities. An edit aborts and
invalidates the outstanding quote; a generation check rejects a late response
even if cancellation is ignored. Duplicate Continue actions share the pending
request. Back/Edit retain input and require a new Continue/quote before payment.
Resizing preserves the current step. Browser back/forward restoration invalidates
the quote without creating a reservation or assuming payment success.
Leaving valid Trip Details cancels unfinished GPS work through its existing
generation guard, preserving the address the customer just accepted.

Both payment choices require Step 3 and an unchanged reviewed quote. Submitting
early, or with silently changed inputs, cannot automatically quote and pay.
Checkout receives the existing server quoteRevision where supplied; no browser
money fields are added. A server revision conflict returns to Customer Information
for a fresh quote and explicit review. Temporary checkout failures remain
retryable. The existing backend locks, ownership, immutable saved fares, Stripe
idempotency, signed webhook authority, refunds and Complete Payment controls are
unchanged. No schema, migration, API, credential or persistent browser storage is
added.

## Validation

Run suites sequentially on Windows. The normal package suite includes
`tests/booking-steps.test.cjs`, which exercises navigation, required information,
early payment denial, form/quote binding, late responses, duplicate actions,
quote errors, revision conflicts and browser restoration.

The browser suite is separate from the Node-only package suite:

```powershell
$env:ER_TEST_PLAYWRIGHT_MODULE = '<installed playwright module>'
# Optional, if Playwright has no bundled Chromium:
$env:ER_TEST_BROWSER_EXECUTABLE = '<local Chromium or Edge executable>'
node --test --test-concurrency=1 tests/browser/booking-steps.cjs
node --test --test-concurrency=1 tests/browser/complete-payment-visibility.cjs
```

The booking browser suite covers 320, 390 and 1440px, all three steps, both payment
choices, interstate/reverse/same-state routes, round trips, hourly service,
normal airport pricing, Terminal C/$150 special, FIRST15, missing profiles,
unknown toll prices, flag-off quotes, customer ownership, payment retries,
server revision changes and validation failures. It checks real computed
visibility, a single summary, no horizontal overflow, CSP, stored/Checkout cents,
and paid-state button hiding after a signed mock webhook.

Optional `ER_TEST_BOOKING_RESULTS_FILE` writes a test summary;
`ER_TEST_BOOKING_SCREENSHOTS_DIR` writes local screenshots of each step at each
width. Tests use synthetic provider geometry/fleet assumptions, mocked
Google/Stripe, memory storage and test-only customer data. They do not verify
real toll classification, settled E-ZPass charges, phone GPS or live payments.
PostgreSQL tests must use only the previously isolated localhost test database.

## Release controls

Review the separate feature PR before merging. Feature commits use `[skip render]`
and the PR uses `[skip preview]` to avoid an unintended deployment or paid preview.
No Render settings, services or production environment values are changed. The
separate production merge/deployment and any later customer toll activation
require approval. There is no database migration or data rollback for this UI
change; a code rollback retains existing reservation/payment snapshots.
