# Customer booking dates and times

Customer trip dates display as **MM/DD/YYYY**, and pickup/return times as
**h:mm AM/PM (New York time)**. The booking form, Step 3, guest/account
confirmation, My Trips and pickup-time editor share `public/trip-date-format.js`.
Customer reservation, payment, reschedule, cancellation and refund emails use
the same formatter. Admin dispatch and admin notification formats are unchanged.

## Input and storage boundary

`public/booking-date-controls.js` adds unnamed US-format text fields alongside
the existing named native date/time controls. Manual dates accept MM/DD/YYYY
(or eight digits MMDDYYYY on a numeric phone keyboard); times require AM/PM.
Calendar/clock buttons retain the device's native picker when available, with
manual entry available on older browsers. A native picker popup can follow the
device locale; the visible selected value always uses the US format.

The existing named fields, FormData, requests and stored trip snapshots remain
`YYYY-MM-DD` and `HH:mm`. Required/minimum-date validation remains on those
canonical controls. The adapter forwards input/change events so edits still
invalidate the reviewed quote and require fresh server quoting before payment.
Book Again clears dates, native picker selection refreshes the visible fields,
and Back/Edit preserves valid entries. No browser storage is introduced.

Trip dates/times are already New York wall-clock components, so display them
without parsing in the customer's device timezone. Absolute timestamps such as
Booked on/payment deadlines use `Intl` with `America/New_York`, including DST.
Existing server schedule validation, DST calculations, date constraints,
database schema/storage, quote revisions, fares, tolls and Stripe logic remain
unchanged. Previously frozen email outbox payloads remain unchanged on retry.
The only server middleware edit is the exact hash of the updated confirmation
script in the existing strict CSP.

## Validation

- `node --test --test-concurrency=1 tests/trip-date-format.test.cjs`
- `npm test` (sequential root suite; PostgreSQL tests require an isolated test DB)
- Existing CSP, customer trip, booking, payment and email tests
- `tests/browser/us-booking-dates.cjs` with installed Playwright/Chromium:
  UK locale, Tokyo device timezone, 320/390/1440px, partial/invalid date entry,
  minimum dates, explicit AM/PM, native/manual picker paths, return trips,
  fresh quotes, ISO request/snapshot consistency, Pay Later, guest/account
  confirmation, account rescheduling, reset, no overflow and strict CSP.
- Existing three-step booking, both payment choices, payment visibility and
  shared-SUV toll browser suites remain part of the regression checks.

No production DB, Google requests or live Stripe calls are needed. Before
release, smoke-test real iPhone Safari and Android Chrome native picker popups,
the keyboard, AM/PM entry and Back/Edit. Local automated browser checks use Edge;
they do not certify device-specific native picker behavior.
