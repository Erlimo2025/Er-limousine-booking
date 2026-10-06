# Phase 1 customer account foundation

Customer accounts are independent of admin sessions, guest reservations and FIRST15. No booking fields are autofilled or linked to an account in Phase 1. FIRST15 remains 15% with its existing eligibility, atomic claims and EWR exclusion.

## Storage and migration

Migration 003-customer-accounts.sql runs inside the existing startup transaction and migration advisory lock. It creates er_customers, er_customer_sessions and er_customer_auth_limits, with unique normalized email/phone constraints, session foreign keys and indexes. Public database access is revoked. The deployment role must have the existing migration/schema privileges; runtime requires SELECT/INSERT/UPDATE/DELETE on these tables. No new database credential is needed. Production infrastructure permissions are not asserted to be configured.

## Credentials and sessions

Passwords accept 10–128 Unicode characters (maximum 512 UTF-8 bytes). They use asynchronous Node crypto.scrypt with N=65536, r=8, p=2, a random 16-byte salt and a 64-byte result. The stored format includes scrypt/v1 and parameters; hashes are compared using timingSafeEqual. Unknown accounts undergo the same bounded scrypt work with a dummy hash. At most two password jobs run concurrently per process to limit memory use.

Session tokens use 32 random bytes. Only SHA-256 token hashes are stored in PostgreSQL. The browser receives the token solely in an HttpOnly, SameSite=Strict, Path=/ cookie, Secure with a __Host- prefix in production. Absolute lifetime is 30 days; usage does not extend it. Logout deletes the current session, login revokes the prior browser session, and disabled accounts cannot authenticate. Sessions survive worker restarts. No tokens or passwords enter browser storage, URLs, logs or API JSON.

Customer mutations require same-origin browser metadata and JSON, using the existing origin protection. All customer responses and account HTML are no-store. Login/profile errors use the existing generated reference IDs and sanitized logging.

## Abuse controls

Registration: 10 requests per IP per 15 minutes. Login: 30 requests per IP per 15 minutes. Customer APIs: 120 requests per IP per minute. In addition, a PostgreSQL atomic counter allows 20 attempts per normalized-email hash per 15 minutes across workers, whether or not the account exists. These counts include successful attempts and reset after the fixed window. No plaintext identity is stored in throttle records.

## Deferred work

Password recovery now uses secure email links through a server-only Resend adapter; production activation requires reviewed configuration and domain tracking settings. Tests use a mocked provider. See customer-recovery.md. SMS/email enrollment verification, profile editing, account-based promotion eligibility remain deferred. Contact ownership remains unverified. Expired session rows and expired throttle rows are unusable; they currently remain in storage. A future reviewed retention job can purge expired authentication metadata without deleting customers, reservations or payment records. Provider-managed database backups and restricted database access remain required as documented for reservation storage.

Tests use synthetic identities and isolated local PostgreSQL; Stripe and Google remain mocked.

## Phase 3: My Trips

The nullable er_reservations.customer_id foreign key is the sole My Trips ownership authority. At NEW reservation creation only, the server resolves its customer session and transactionally rechecks the active customer/session before inserting the account ID. Missing/stale optional cookies remain guest; stale cookies are cleared. Contact information, browser ownership fields, booking references and Stripe metadata never establish ownership. Guest and historical reservations remain NULL; no email/phone/name backfill or guest claiming is performed.

Migration 006-customer-trips.sql runs under the existing transactional migration advisory lock, leaves migrations 001–005 unchanged and adds customer ownership plus scheduled_start_at/scheduled_end_at and customer/schedule indexes. The customer foreign key uses ON DELETE RESTRICT: a future account deletion/anonymization policy must explicitly address retained reservations. Normal JSON booking updates cannot overwrite row ownership or schedules. Existing booking-credential protections still apply to Checkout reuse; a conflicting authenticated account is rejected generically. Retrying an unowned guest reservation never claims it.

GET /api/customer/trips and GET /api/customer/trips/:id require an active, unexpired customer session. Parameterized SQL includes customer_id in every query. Missing/non-owned details return the same generic 404. Responses use an explicit allowlist, exclude contacts/security/payment-provider/dispatch metadata and are no-store. Default pagination is 20, maximum 50, with a strictly validated untrusted keyset cursor (never authentication) containing schedule/UUID position and a server-selected classification timestamp. Subsequent pages use that timestamp; cursors expire after 24 hours and remain constrained to the authenticated customer even if modified. Load More follows schedule then UUID order; a fresh list snapshot moves a trip to Past when its schedule boundary passes.

Schedules use the existing America/New_York parser: start is outbound pickup; end is the same pickup for One Way/Airport, return pickup for Round Trip or pickup plus booked hours for Hourly. End is a classification boundary, not evidence of performed service. End after the snapshot is Upcoming; end at/before it is Past, regardless of booking status. Future completed/cancelled records retain their actual status but are not moved to Past solely because of that status. Booking/payment states are displayed as stored; unpaid trips never imply confirmation. No luggage count is fabricated. EWR terminal labels derive solely from the approved stored place-ID allowlist; My Trips performs no Google lookup.

The dashboard is read-only. Trip strings are rendered through textContent; no HTML interpolation or persistent browser trip storage exists. Logout/pagehide clear rendered private data, pageshow revalidates the session and reloads trips, and request-generation checks discard responses that arrive after logout/tab changes. No editing, refunds, cancellation, saved cards, rebooking or historical claiming is implemented. The future historical-claim design requires separate review and booking-specific verified authority, never contact matching alone. FIRST15 stays 15% with its existing contact-based eligibility and PostgreSQL protections.

## Saved payment methods foundation

Phase 1A adds disabled-by-default, authenticated backend APIs only. Account UI
and booking payments are unchanged; saved cards cannot yet pay for a booking.
See [customer-payment-methods.md](customer-payment-methods.md) for migration 007,
session-derived ownership, provisioning/retry safety and local test coverage.

## My Trips Book Again

Book Again opens the normal booking page without creating a reservation. The authenticated,
no-store GET /api/customer/trips/:id/book-again reads the source with customer_id + reservation ID.
Foreign, missing and unusable sources receive the same 404; guests receive 401.
Only pickup, destination, internal vehicle, passenger count, trip type, supported hourly duration
and usable pickup/drop-off Place IDs are returned as template fields. A previously
verified EWR_MANHATTAN_SUV special can also restore that single public offer selection. Existing EWR selection
and manual-edit invalidation are retained; all provider identities are verified again by normal quoting.
The template contains no old dates/times, fare, coupon redemption state, payment data, customer details,
flight number, notes, dispatch information or reservation ID. Valid cancelled/unpaid/paid/past trips
can serve as route templates; incomplete/unsupported route data cannot.

A fresh opaque flow reference, bound to the current account session, separates the new booking
from its source even when manually re-entered details match. It is not an ownership or payment
credential. It remains only in page memory and is checked before including it in the normal
retry fingerprint. Existing action locks, booking budgets and FIRST15 claim protections still apply.
The source query parameter is removed after reading; no trip data or flow reference is persisted
in browser storage. New pickup/return dates and times must be chosen; the customer reviews a
fresh server quote and uses the unchanged Pay Now / Pay Later actions. No old fare is copied,
and no old coupon is reactivated. For a source with the verified EWR special, only
the offer code is restored, preserving terminal identity and destination. Normal
EWR routes do not automatically become specials. The unchanged server must verify
approved EWR pickup, Manhattan destination, one-way trip and SUV again, and reads
the current fixed-offer price rather than the source fare.

Browser Back/bfcache restoration re-fetches an unfinished template through the authenticated endpoint. Only the source UUID is retained in page memory while loading. Stale responses cannot overwrite a restored page; success or terminal failure clears the pending source, and a failed restore leaves manual booking usable. No reservation is created by restoration.
