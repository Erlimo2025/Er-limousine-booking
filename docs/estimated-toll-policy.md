# Advance NJ-to-NYC toll estimate policy

Original advance-estimate policy: November 1, 2026. Availability correction:
November 4, 2026.

For new ordinary routed quotes with toll pricing enabled, only a direction
starting at a server-verified New Jersey pickup and ending at a server-verified
destination in New York City's five boroughs may add an estimated toll. The
recognized counties are Bronx, Kings (Brooklyn), New York (Manhattan), Queens,
and Richmond (Staten Island). Verify the county on a potential NJ-to-NY
direction before classifying it. Missing or ambiguous county evidence requires
manual review.

All other verified directions add $0 in customer tolls. They still require
standard driving-route validation and do not request toll estimates. A
round trip can have at most one toll-eligible direction. For an NYC-to-NJ
round trip, the NJ-to-NYC return is the eligible direction. Intermediate stops
do not change the pickup or destination used for this decision. Existing stop
validation still applies.

An interstate booking with no toll-eligible direction records $0 of customer
tolls using the existing `none` toll snapshot without a `format` field. It
retains the legacy `interstate_only` eligibility record and uses zero customer
toll amounts for each direction. Same-state bookings retain the existing
`waived` snapshot. These values record the fare policy. Physical road tolls
remain unestimated on these directions. Hourly behavior and the $150
toll-inclusive qualifying EWR-to-Manhattan Suburban offer are unchanged.

## Customer price and acceptance

Display only **Trip Fare, Tolls, Total** pricing rows. Trip Fare includes the
existing surcharges, discounts and gratuity without changing their arithmetic
or order. Keep the original breakdown internally. Unavailable estimates display
**Toll estimate unavailable — contact us for a final quote**. Both quote and new
reservation endpoints return HTTP 422 with `TOLL_ESTIMATE_UNAVAILABLE` and
`checkoutAllowed: false`, without an offered total. Customer input is retained;
neither Pay Now nor Pay Later can accept that new quote. No facility or credit
rows are shown to customers. The EWR special still shows Included. Verified
directions outside the NJ-to-NYC toll policy add $0. Hourly and explicitly
disabled toll-pricing behavior remain.

The accepted booking amount is fixed. The company absorbs any toll shortfall;
**no later toll supplement is charged**. Pay Now, Pay Later, payment retries,
receipts, cancellation and refunds retain the saved authoritative total.
There is no automatic reconciliation or refund for a difference between the
advance estimate and an eventual E-ZPass bill. Existing refund rules remain.
Previously accepted `company_includes_unknown_tolls_v1` snapshots remain valid
and payable at the saved fare; this correction does not revoke, reprice or
backfill them. There is no migration or update of historical reservations.
Interstate bookings with zero customer tolls use an existing snapshot shape
that the baseline reader can validate. Saved pricing stays authoritative in a
rollback. A rollback can restore earlier eligibility rules for new quotes.

## Failure diagnosis and availability

The prior `advance.estimate()` catch converted every failure into `absorbed`
with zero added cents, and the booking UI rendered that as Included. An
estimate-mode provider error also retried distance-only routing and could reach
the same fallback. These choices left physical toll costs unknown. An unavailable
toll estimate still blocks a new ordinary quote when the direction qualifies.

Server diagnostics retain only a closed `tollReason` category alongside the
existing request reference, timestamp, operation and HTTP status:

- Missing/invalid pricing category or legacy profile: `vehicle_estimate_profile_missing`.
- Provider request/response, routing fallback, missing/invalid money:
  `provider_request_failed`, `provider_response_invalid`, `provider_fallback_route`,
  `provider_amount_unknown`. A missing toll indication conflicting with a known
  chargeable PA crossing is `provider_toll_evidence_conflict`.
- Geometry validity/continuity/size, crossing and direction: `geometry_*`,
  `crossing_missing_or_ambiguous`, `direction_conflict`.
- Congestion entry/start evidence and possible repeated daily provider charge:
  `congestion_entry_unknown`, `reverse_starting_zone_unknown`,
  `reverse_congestion_entry_unknown`, `daily_provider_overlap_unknown`.
- Missing/inconsistent time, day-boundary uncertainty and unsupported schedules:
  `timing_*`, `day_boundary_uncertain`, `unsupported_tariff_date`.
- Unverified jurisdiction/coverage and unexpected failures use separate closed
  categories; arbitrary exception text is replaced by `estimate_unavailable`.

No customer addresses, coordinates, place IDs, email, provider bodies, secrets
or payment credentials enter these diagnostics. Internal categories are not
returned as customer detail. HTTP errors, timeouts and invalid provider JSON
share `provider_request_failed`; no unsupported provider cause is asserted.
No production route response/log was captured for this local correction, so
the category of any particular reported production trip remains unconfirmed.
Real route comparisons and fleet eligibility evidence remain outstanding.

## Estimated-toll arithmetic

These rules apply to the toll-eligible direction. Direction and overlap rules
for older accepted snapshots remain in the historical readers.

1. Use the server's selected Google driving route and verified endpoint states/
   counties. Browser amounts, state/county claims, crossing names, vehicle/class
   assertions and history are ignored.
2. Identify one Lincoln/Holland/GWB traversal from substantial ordered matches
   against both NJOGIS and NYC OTI reference portions. A name, nearby point or
   via label is insufficient. These references support estimation, not certified
   commercial coverage. No individual address pair or every local road needs
   preapproval. Ambiguous/missing/unsupported geometry requires manual review.
3. Use official PA Class 1 NY/NJ E-ZPass rates: $14.79 off-peak / $16.79 peak
   NY-bound, zero PA component NJ-bound. Weekday peaks: 06:00–10:00 and
   16:00–20:00; weekend peaks: 11:00–21:00, America/New_York. Evaluate the
   provider crossing-step static/traffic time window, not pickup time. A window
   spanning a tariff boundary uses its higher applicable rate as a conservative
   estimate. Unsupported years or uncertain calendar-day boundaries require
   manual review. [PA schedule](https://www.portauthoritybuilds.com/bridges-tunnels/en/tolls.html).
4. Internally estimate standard daily CRZ charges at $9 peak / $2.25 overnight.
   Assume the first chargeable entry of this booking/day, not a verified first
   entry of the actual driver's day. Eligible peak Lincoln/Holland entries
   receive up to $3 credit, subject to the $5 daily ceiling.
   No overnight credit or TLC per-trip plan is assumed. Overnight-first/later-
   peak credit uncertainty requires manual review.
   [MTA schedule](https://www.mta.info/document/138931).
5. Lincoln/Holland NY-bound connections follow the MTA connection map. GWB
   entry needs a matched local-street witness below 60th; wholly northern
   NY-side geometry has no CRZ component. Selected Dyer/Canal/Midtown witnesses
   are not a complete zone polygon. West Street/FDR are not witnesses.
   Street evidence must be continuous; separate intersections with excluded
   roads cannot be accumulated into an entry. Uncertain CRZ entry evidence
   requires manual review when no eligible backup is available.
   [MTA connection map](https://www.mta.info/map/36226).
6. For the eligible direction, use the **greater of Google's one whole-route estimate
   and the known official PA + estimated CRZ − eligible credit subtotal**.
   Never add Google aggregate plus components, route plus leg totals, or call
   the residual an identified road charge. This is an estimate envelope, not
   component reconciliation. Google's aggregate can include additional NJTA/MTA
   roads; their commercial accuracy and congestion inclusion remain unverified.
   Unknown provider money requires manual review rather than a partial charge.
7. Deduct the existing toll allowance for the eligible direction once. Do not
   discount or tip added tolls. Provider amounts above $1,000 for that direction
   require manual review.

Google has no actual vehicle/day ledger. A round trip under this policy has
at most one toll estimate, so an excluded direction contributes no Google toll
aggregate to the accepted fare.

The envelope can over- or underestimate settlement. It may not capture every
additional-road adjustment, classification, prior daily entry or later credit.
The company bears these differences. Unknown road coverage is never labelled
verified or free. Queens-Midtown/Carey $1.50 eligible peak credits remain in the
separate verified engine; the simple mode does not add them independently to
Google's aggregate. Such routes use the envelope only when required PA/CRZ
evidence is supported, otherwise manual review is required.

## 2027 tariff rollover

Tariff windows use America/New_York time and the supported crossing or zone
entry time. The reviewed Port Authority table ends at midnight at the start of
January 1, 2027 (05:00 UTC). The 2026 New Jersey Turnpike, Garden State Parkway,
and ordinary MTA bridge and tunnel figures remain 2026 references. A future
facility tariff needs a published schedule and verified effective time.

- The Port Authority approved reducing the Class 1 E-ZPass off-peak discount
  from $2.00 to $1.50 on January 3, 2027. Its November 12 announcement also
  identifies an inflation adjustment and a scheduled $0.25 increase. These
  sources do not supply a final 2027 Class 1 toll table.
  [Port Authority approved change](https://www.panynj.gov/content/dam/corporate/public-hearings-pdfs/Approved_Fee_Changes_Toll_and_Bus.pdf)
  and [2027 announcement](https://www.panynj.gov/port-authority/en/press-room/press-release-archives/2026-press-releases/port-authority-unveils--10-3-billion-2027-budget-to-advance-hist.html).
- NJTA budget projections assume annual indexing. The MTA financial plan
  anticipates an ordinary crossing increase in March 2027, subject to Board
  action. These are projections and contain no facility-level 2027 tariffs.
  [NJTA budget](https://www.njta.gov/document/2026-annual-budget-in-brief/)
  and [MTA preliminary budget](https://www.mta.info/document/215226).
- The published MTA Phase 1 Congestion Relief Zone (CRZ) schedule covers 2027.
  Standard non-TLC Class 1 pricing with valid E-ZPass remains $9.00 peak and
  $2.25 overnight, charged once per day. Eligible peak credits are $3.00 for
  Lincoln/Holland entry and $1.50 for Queens Midtown/Hugh L. Carey entry or
  exit, capped at $5.00 per day. Existing eligibility, prior-charge, direction,
  and timing checks apply. The independently reviewed CRZ window ends at
  midnight at the start of January 1, 2028 (05:00 UTC).
  [MTA Phase 1 schedule](https://www.mta.info/document/138931).

Combined custom quotes using the existing 2026 formats still require every
tariff window to fit the 2026 review. Only the eligible NJ-to-NYC direction
can fall back to the same selected route's Google amount when the custom
estimate needs an expired or unsupported rate. The
[Google backup checks](google-toll-backup.md) still apply. The backup consumes
one whole-route estimate with no separate PA or CRZ charge or credit. An
unusable estimate requires a final quote from Dispatch. Verified mode still
requires current tariff, route, fleet, and account evidence.

Accepted reservations continue to use their saved amounts. Both the current
and baseline readers support the existing quote formats. Rolling back this
rollover change keeps the NJ-to-NYC directional policy already in the baseline.

## Configuration and class eligibility

**Shared Luxury SUV pricing update:** current Suburban and Escalade bookings use
the operator-approved server category in
[shared-luxury-suv-tolls.md](shared-luxury-suv-tolls.md). Its Class 1/congestion
inputs are customer pricing assumptions, not individual fleet certification.
The same category supplies both vehicles' route modifiers and estimate arithmetic;
their individual trip-fare rates remain unchanged. Missing/invalid category
configuration requires manual review for new bookings with a toll-eligible
direction. The per-vehicle inputs below describe legacy unassigned estimate
profiles and the separately verified path. The shared advance estimate category
uses its own profile.

`ROUTE_TOLLS_ENABLED=false` and `ADMIN_TOLL_VALIDATION_ENABLED=false` remain
defaults. No production configuration is changed. `ROUTE_TOLLS_MODE=estimate`
is the default if customer toll pricing is separately activated. `verified`
retains the stricter previous network path. All legacy accepted snapshot readers
and prices remain; admin estimate-only mode stays independent.

The server-only `TOLL_VEHICLE_PROFILES_JSON` can carry `estimate2026` per actual
vehicle: explicitly confirm `paClass1Eligible: true`, two axles, single rear
wheels, no trailer, `mtaPlan: "standard_daily"`, non-TLC status and a boolean
crossing-credit entitlement, together with the NJ-issued pass. These are
operator-confirmed estimate inputs, not independent account verification.
Business/OL/2Ax alone cannot fill them. Missing inputs require manual review.
Do not copy synthetic fixtures into production or mark commercial/congestion
verification flags true. No real vehicle classification is certified here.

Exact settled transactions and a real Google test key/export remain unavailable.
Their comparison is pending; settlement history is no longer an advance-estimate
gate. Shared-category assumptions are operator-approved pricing inputs; actual
vehicle eligibility is still unverified. Separate deployment/activation approval
is required. No migration
or persistent GPS/E-ZPass history is introduced; accepted snapshots contain only
compact hashes, assumptions and cents.

## Sources, usage and testing

`services/data/toll-estimate-reference-2026.json` preserves original NJOGIS/NYC
OTI source coordinates and documents URLs, the supplemental 81-feature Midtown
query/hash, and selection/grouping. No source geometry was invented, snapped,
buffered or certified. Retain source conditions and the prior acceptance
package's unresolved access/level/topology limitations.
[NYC dataset](https://data.cityofnewyork.us/City-Government/Centerline/inkn-q76z),
[NYC conditions](https://cityofnewyork.github.io/opendatatsm/publicpolicies.html).

Each direction still uses the existing driving-route request. Only the eligible
NJ-to-NYC direction requests TOLLS and the additional geometry fields. If that
direction cannot produce a validated toll estimate, the quote requires manual
review. A distance-only response cannot authorize a new toll-eligible fare.
The qualifying $150 EWR special retains its independent toll-included policy
and existing base-route retry. Google toll requests retain the existing billable
API tier. No live Google/Stripe call or new paid service was used in tests.
