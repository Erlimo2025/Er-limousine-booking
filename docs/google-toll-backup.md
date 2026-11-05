# Automatic Google toll backup — local implementation

## Selection and pricing

The existing advance estimator remains primary. A successful custom estimate is
returned unchanged. A closed list of custom crossing/geometry/timing/coverage
and congestion-context failures can use the Google backup. The existing JFK
`crossing_not_matched` / `crossing_ambiguous` diagnostics and matcher are retained.
An unknown programming error, unverified location/profile, provider failure,
provider fallback route or conflicting provider evidence cannot authorize backup.

The backup reads the route-level toll total from the SAME selected response used
for distance and traffic duration. There are no backup network calls, route
changes, forced via points, alternate-route totals or invented crossing labels.
The full booking uses custom OR Google totals; it never mixes custom legs with
Google legs or adds custom PA/MTA charges, credits or leg advisories to Google.
Existing fare, surcharge, discount, gratuity and toll-allowance arithmetic stays
in the existing pricing code. Tolls are added once after existing discounts.

This permits Google-priced routes outside the three-crossing custom inventory,
including JFK/Brooklyn routes using other facilities, when Google supplies a
usable amount. This is not certification of those roads, commercial rates or a
particular actual route. Local route/city/crossing tests are synthetic controls.
The existing approved scope remains New Jersey and NYC's five boroughs.

## Independent validation

- The existing Google client must return a successful response. Provider errors,
  invalid JSON, absent routes and provider fallback information fail closed.
  An error body is rejected even if its HTTP status is 200.
- Server-verified origin/destination Place IDs, direction and scheduled departure
  bind the selected route. Google distance and traffic duration must be valid;
  backups retain the six-hour route limit. Return trips must follow arrival.
- The configured server vehicle/profile must be eligible for the existing
  operator-approved estimate policy. Browser amounts, passes and class claims
  cannot select or repair a profile. Individual commercial certification stays
  false in the shared Luxury SUV pricing model.
- Exactly one route-level USD Money value is accepted. Negative, overflowing,
  invalid currency, malformed or multiple prices are unknown. Integer cents use
  the existing half-up Money parser. Missing tollInfo/estimatedPrice and leg-only
  prices are not zero. Explicit protobuf USD zero is valid (omitted zero units
  and nanos retain their documented meaning).
- The existing $1,000 per-leg estimate limit remains. Accepted route amounts and
  the total are integers; an unknown amount is never labelled Included or $0.

## Round trips and congestion

Different-day routes are independently priced, then added once. Per the operator's
explicit approval, two positive Google aggregates with overlapping possible New
York calendar charge days require manual review. This includes a leg crossing
midnight before a return that day. A direction with an explicit valid Google
zero does not introduce a second daily amount. No speculative congestion credit
or subtraction is used. The backup never adds a separate congestion charge.

Google's non-commercial estimate may omit toll facilities, congestion charges,
daily-history effects or credits, or differ from business-account settlement.
The business absorbs differences from the accepted estimate; no later toll charge
or accepted-fare adjustment is introduced. For existing API behavior and the
non-commercial limitation, see [Google toll documentation](https://developers.google.com/maps/documentation/routes/calculate_toll_fees).

The custom tariff's unsupported future year can use a valid Google estimate for
that scheduled route. No future official PA/MTA schedule is invented or certified.
Strict `ROUTE_TOLLS_MODE=verified` continues to require its separate verified road,
fleet and history evidence; this backup belongs to the advance-estimate path.

## Reservation, payment and privacy compatibility

`google_routes_backup_v1` is a versioned JSONB quote snapshot. It stores the
accepted cents, safe estimate assumptions, an allowlisted primary reason and
selected route/request hashes and metrics. No polyline, GPS trace, provider body,
account/tag identifier, payment credential or key is stored or logged.

The existing quoteRevision binds financial/request assumptions. Harmless changes
to the primary diagnostic alone do not change a Google-backed price revision.
Profile, selected-request or financial changes still require a fresh quote before
acceptance. Customer DTOs keep only the existing safe fare/toll totals; internal
assumptions and routing evidence are not exposed. Step 3 remains Trip Fare, Tolls,
Total with the existing buttons and layout.

The stored snapshot is immutable through payment completion/retry, cancellation
and refund. Validation after restart uses the stored snapshot, not current Google
prices or configuration. Historical custom, strict verified, included and legacy
snapshots remain readable/payable. No SQL migration or new schema is needed.

Before any release, rollback code MUST retain the new snapshot reader/validator
once a Google-backed reservation exists. A wholesale rollback to code that rejects
the new format could block accepted bookings. Disable the new selection in a
compatible application build or roll forward; never rewrite historical fares or
remove accepted snapshots to facilitate rollback. This work does not deploy.

## Unchanged policies and controls

The qualifying Suburban EWR-to-Manhattan offer is exactly $150 including tolls.
Same-state additional tolls stay zero; hourly behavior stays unchanged. FIRST15,
vehicle fares, Stripe checkout/webhooks/refunds, reservation ownership and action
locks, Admin payment links, reviews and account authentication are unchanged.
Both unavailable estimators, unverified endpoints/profile, invalid Google money,
provider errors and ambiguous same-day overlap retain the manual-quote response.

No new flags, credentials, dependencies or services are required. Existing
`ROUTE_TOLLS_ENABLED` and estimate/verified mode controls retain their defaults.
The admin estimate-only tool and `ADMIN_TOLL_VALIDATION_ENABLED` stay separate.
No Render setting or production database is changed.

## API usage and cost

The original request already includes TOLLS and traffic-aware routing. Consuming
its price as backup adds zero Google requests. Existing fresh quote/checkout
revalidation still uses one route request per direction. Google bills requests
by the requested features. Its current global list gives Compute Routes Pro a
5,000-request monthly free cap and $10 per 1,000 at the first paid volume tier;
actual billing depends on the account, region, usage and contract. See
[usage/billing](https://developers.google.com/maps/documentation/routes/usage-and-billing)
and [current pricing](https://developers.google.com/maps/billing-and-pricing/pricing).
All local tests mock Google, Stripe and email; isolated PostgreSQL is loopback-only.
