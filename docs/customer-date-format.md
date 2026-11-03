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
The real native date/time input covers only the 44px calendar/clock icon area.
It receives trusted touch/mouse interaction directly, with pointer events
enabled. The glyph is decorative; the native control is labelled, keyboard
focusable and has a visible focus ring. The manual US-format field remains
independently editable. No `showPicker()`, synthetic click or programmatic focus
is used to open a picker: iOS Safari can silently ignore `showPicker()` even
when the method exists ([WebKit issue 261703](https://bugs.webkit.org/show_bug.cgi?id=261703)).
A native picker popup can follow the device locale; the visible selected value
always uses the US format.

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
- `tests/browser/native-calendar-picker.cjs` tests 320/390/1440px mouse and touch
  interaction when `showPicker()` is a no-op, absent or throws. Chromium checks
  the actual native popup's `:open` state, selects/changes pickup and return dates,
  and uses the popup's Clear action. It also checks manual re-entry, required
  validation, ISO values, fresh quote revisions before payment, native autofill
  invalidation, no duplicate reservations/payment sessions, hit targets, focus,
  AM/PM display, no overflow and strict CSP. The former API-call-only picker
  assertion now also requires a real popup to open.
- The same regression file can run with `ER_TEST_PICKER_ENGINE=webkit` and an
  installed WebKit binary. Windows WebKit reports native date/time controls as
  text, so it checks trusted input hit/focus and manual/value synchronization;
  it cannot open or drive the iPhone OS chooser. The formatter keys off the
  declared input type so US manual entry remains usable without a native picker.
  These scenarios commit the active text edit with Tab (Next/Done) before
  Continue; they are not a physical Safari keyboard or first-tap acceptance test.
- `ER_TEST_PICKER_ENGINE=firefox` covers desktop native popup opening at each
  width, followed by native value edits/manual clearing and the same quote
  protections. Its internal indicator is aligned with the visible icon using
  padding; Blink/WebKit's indicator covers the full native hit area. Firefox
  popup selection itself is not driven by this headless test.

No production DB, Google requests or live Stripe calls are needed. Before
release, smoke-test real iPhone Safari and Android Chrome native picker popups,
the keyboard, AM/PM entry and Back/Edit. Real-phone acceptance should open both
pickup and return calendars, select/change/clear dates, then confirm that payment
requires a fresh Step 3 quote. Desktop engine/mobile emulation checks do not
certify device-specific native picker behavior.
