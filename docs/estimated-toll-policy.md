# Advance interstate toll estimate policy

Original advance-estimate policy: November 1, 2026. Local availability correction:
November 4, 2026. This correction has not been deployed or activated.

The operator approved advance estimates rather than exact E-ZPass settlement,
and NJ and NYC's five boroughs (including reverse trips) as the service area.
New ordinary interstate bookings now require an available, validated estimate.
Unavailable estimates, outside coverage, or unverified jurisdiction require manual review. Hourly
behavior is unchanged. Same-state trips have no added tolls. The qualifying
EWR → Manhattan SUV offer remains exactly $150, tolls included.

## Customer price and acceptance

Display only **Trip Fare, Tolls, Total** pricing rows. Trip Fare includes the
existing surcharges, discounts and gratuity without changing their arithmetic
or order. Keep the original breakdown internally. Unavailable estimates display
**Toll estimate unavailable — contact us for a final quote**. Both quote and new
reservation endpoints return HTTP 422 with `TOLL_ESTIMATE_UNAVAILABLE` and
`checkoutAllowed: false`, without an offered total. Customer input is retained;
neither Pay Now nor Pay Later can accept that new quote. No facility or credit
rows are shown to customers. The EWR special still shows Included; same-state
trips still add $0. Hourly and explicitly disabled toll-pricing behavior remain.

The accepted booking amount is fixed. The company absorbs any toll shortfall;
**no later toll supplement is charged**. Pay Now, Pay Later, payment retries,
receipts, cancellation and refunds retain the saved authoritative total.
There is no automatic reconciliation or refund for a difference between the
advance estimate and an eventual E-ZPass bill. Existing refund rules remain.
Previously accepted `company_includes_unknown_tolls_v1` snapshots remain valid
and payable at the saved fare; this correction does not revoke, reprice or
backfill them. There is no migration or update of historical reservations.

## Failure diagnosis and availability

The prior `advance.estimate()` catch converted every failure into `absorbed`
with zero added cents, and the booking UI rendered that as Included. An
estimate-mode provider error also retried distance-only routing and could reach
the same fallback. These were explicit previous policy choices, not proof that
the selected route had no tolls. They no longer accept new ordinary bookings.

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
   entry of the actual driver's day. Share only this assumed ledger across this
   booking's directions and do not charge the day twice. Eligible peak Lincoln/
   Holland entries receive up to $3 credit, subject to the $5 daily ceiling.
   No overnight credit or TLC per-trip plan is assumed. Overnight-first/later-
   peak credit uncertainty requires manual review.
   [MTA schedule](https://www.mta.info/document/138931).
5. Lincoln/Holland NY-bound connections follow the MTA connection map. GWB
   entry needs a matched local-street witness below 60th; wholly northern
   NY-side geometry has no CRZ component. Selected Dyer/Canal/Midtown witnesses
   are not a complete zone polygon. West Street/FDR are not witnesses.
   Street evidence must be continuous; separate intersections with excluded
   roads cannot be accumulated into an entry. Reverse journeys identified as
   starting on covered Manhattan streets assume no new charge merely for
   exiting; unproved starting zones and uncertain entries from other boroughs
   require manual review.
   [MTA connection map](https://www.mta.info/map/36226).
6. For each direction, use the **greater of Google's one whole-route estimate
   and the known official PA + estimated CRZ − eligible credit subtotal**.
   Never add Google aggregate plus components, route plus leg totals, or call
   the residual an identified road charge. This is an estimate envelope, not
   component reconciliation. Google's aggregate can include additional NJTA/MTA
   roads; their commercial accuracy and congestion inclusion remain unverified.
   Unknown provider money requires manual review rather than a partial charge.
7. Sum independently assessed directions and deduct only the existing fare's
   toll allowance once per direction. Do not discount or tip added tolls.
   Provider amounts above $1,000 per direction are outside this estimate policy
   and require manual review.

Google has no actual vehicle/day ledger. If another same-day round-trip leg's
nonzero aggregate could overlap a CRZ charge, the entire toll estimate requires
**manual review**. Do not guess a subtraction or risk billing a daily charge
twice. Round trips with independently supported estimates remain bookable.

The envelope can over- or underestimate settlement. It may not capture every
additional-road adjustment, classification, prior daily entry or later credit.
The company bears these differences. Unknown road coverage is never labelled
verified or free. Queens-Midtown/Carey $1.50 eligible peak credits remain in the
separate verified engine; the simple mode does not add them independently to
Google's aggregate. Such routes use the envelope only when required PA/CRZ
evidence is supported, otherwise manual review is required.

## Configuration and class eligibility

**Shared Luxury SUV pricing update:** current Suburban and Escalade bookings use
the operator-approved server category in
[shared-luxury-suv-tolls.md](shared-luxury-suv-tolls.md). Its Class 1/congestion
inputs are customer pricing assumptions, not individual fleet certification.
The same category supplies both vehicles' route modifiers and estimate arithmetic;
their individual trip-fare rates remain unchanged. Missing/invalid category
configuration requires manual review for new interstate bookings. The per-vehicle inputs below describe legacy
unassigned estimate profiles and the separately verified path, not a requirement
to certify each shared-category vehicle before using an advance estimate.

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

Normal usage remains one Google route request per direction with TOLLS and
bounded geometry fields. A failed ordinary interstate toll request requires
manual review; there is no distance-only retry that accepts an untolled fare.
The qualifying $150 EWR special retains its independent toll-included policy
and existing base-route retry. Google toll requests retain the existing billable
API tier. No live Google/Stripe call or new paid service was used in tests.
