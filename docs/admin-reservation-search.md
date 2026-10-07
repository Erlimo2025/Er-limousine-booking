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
index can be considered if volume warrants it. No schema migration is introduced.

The search response includes only the existing dispatch display/action information,
excluding guest access hashes, payment credentials and Stripe session/customer data.
All searches are read-only. Existing reservation updates, reconciliation actions,
pricing, payment/webhook authority and ownership protections are unchanged. The
legacy `/api/bookings` endpoint remains compatible; the dispatch page uses the
bounded endpoint exclusively.
