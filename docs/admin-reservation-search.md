# Dispatch reservation search

The existing admin session guards `GET /api/bookings/search`. Customer sessions and
guests cannot access it. The dispatch page now defaults to active upcoming trips;
Clear Filters returns to that default. All dates use America/New_York.

Search accepts at most 120 characters / six words, matches literal case-insensitive
terms across reference, passenger name, email, phone, route and flight number, and
normalizes normal U.S. phone formatting for searches. SQL LIKE metacharacters are
escaped and every input is bound as a parameter. Filter values are fixed allowlists.

Filters combine reservation status, payment/verification/refund state, trip timing,
airport and existing `suv` / `escalade` keys. Active includes awaiting payment and
in-progress dispatch statuses, excluding cancelled/completed. Upcoming/Past uses
the end of service (including round-trip return or hourly duration); Today/Tomorrow
uses the pickup day. Existing relational schedule columns take precedence; legacy
unowned records with no schedule columns use their stored New York trip fields.

Airport categories inspect both ends of the route. EWR recognizes its maintained
Place IDs or airport name; JFK/LGA require recognizable airport names. “Other /
unidentified” includes trips without that reliable evidence. These are read-only
dispatch categories and never establish booking/pricing identity.

Pages default to 25, maximum 50. Schedule/reference keyset cursors are bound to
the filter selection and snapshot clock and expire after 24 hours. No total-count
scan or full dataset is sent to the page. A five-second transaction-local statement
timeout and existing admin limits plus a 30/minute search limit bound resource use.
Substring searches may scan rows in this existing modest dataset; a dedicated text
index can be considered if volume warrants it.

The search response includes only the existing dispatch display/action information,
excluding guest access hashes, payment credentials and Stripe session/customer data.
All searches are read-only. Existing reservation updates, reconciliation actions,
pricing, payment/webhook authority and ownership protections are unchanged. The
legacy `/api/bookings` endpoint remains compatible; the dispatch page uses the
bounded endpoint exclusively.

Reservation cards prioritize stored New York pickup date/time, authoritative
reservation/payment/refund badges and airport/terminal labels. Maintained EWR IDs
take precedence over address text. JFK/LGA and legacy airport labels use conservative
stored airport-name/terminal text for display only; no pricing identity is inferred.
The admin-only projection includes customer notes (up to 2,000 characters) and airline
if already stored (up to 120 characters); the current booking form does not collect
a separate airline field. No airline is guessed from a flight number.

All contact/address/flight/notes text is escaped. Telephone targets contain only
validated phone digits; email targets use a fixed mailto scheme and encoded address.
Invalid contact values remain plain text. Long notes and the existing dispatch editor
use native expandable details, with keyboard access and 44px controls. Repeated
terminal prefixes are collapsed only in displayed addresses. Cancelled cards have
a clear “DO NOT DISPATCH” warning. No reservation, fare, identity or action logic changes.

## Archive and restore

Manage Dispatch offers Archive Trip only when the server establishes eligibility:
cancelled/completed reservations, or past awaiting-payment/confirmed reservations
whose entire service has ended. Assigned, driver-en-route and passenger-on-board
trips must be cancelled or completed, even if their planned pickup has passed.
Round-trip return and hourly service end times count. Unknown schedules fail closed.
An explicit second confirmation is required; archiving never cancels a trip,
changes its fare/payment state, expires Checkout, releases FIRST15, or refunds funds.

The default Dispatch trips view excludes archived records. Archived Trips selects
all statuses/dates initially, then uses the same search, filters and keyset paging.
Clear Filters returns to active upcoming unarchived dispatch trips. Restore Trip
has its own confirmation and returns the record to normal filtering; cancelled or
completed trips still require the corresponding status/date filters to appear.
Restore does not reactivate or change reservation status. Restore is required before
reactivating an archived trip through the dispatch status editor.

Migration 010 adds nullable relational archived_at/archived_by columns and the
append-only er_admin_trip_archive_events table. It does not rewrite historical
JSON, ownership or schedule fields. Archive/restore hold the existing reservation
action lock, lock the row, recheck admin authorization and eligibility, and atomically
commit visibility plus an audit event. Confirmed requests contain only a server-
validated request UUID; retries are bound to the reservation/action and cannot
reapply an old archive after restoration. Events record no-op requests too.

Both POST /api/bookings/:id/archive and /restore require the existing admin cookie,
canonical Origin, safe Fetch Metadata, JSON, exact confirmed/requestId input and
existing rate limits. Browser-supplied actor, owner, fare or status fields are rejected.
This application has one shared ADMIN_TOKEN and no named admin accounts or tenants.
The audit actor is a non-secret UUID generated per authorized admin login session,
not the credential/session-token hash and not a verified person's name. Different
admin sessions have distinct persistent audit references. Customer sessions confer
no archive/restore authority. Archive state never filters customer/payment/refund,
reconciliation or audit workflows; the reservation remains available to its owner.
