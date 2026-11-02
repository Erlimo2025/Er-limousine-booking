# Advance interstate toll estimate policy

Draft PR #1, November 1, 2026. Not deployed or activated.

The operator approved advance estimates rather than exact E-ZPass settlement,
NJ and NYC's five boroughs (including reverse trips) as the automatic booking
area, and company-paid unknown tolls within that area. Outside that area, or
when provider jurisdiction cannot establish it, require manual review. Hourly
behavior is unchanged. Same-state trips have no added tolls. The qualifying
EWR → Manhattan SUV offer remains exactly $150, tolls included.

## Customer price and acceptance

Display only **Trip Fare, Tolls, Total** pricing rows. Trip Fare includes the
existing surcharges, discounts and gratuity without changing their arithmetic
or order. Keep the original breakdown internally. Unavailable estimates show
**Tolls: Included**, not a false zero estimate; the internal route-cost estimate
remains null. No facility or credit rows are shown to customers.

The accepted booking amount is fixed. The company absorbs any toll shortfall;
**no later toll supplement is charged**. Pay Now, Pay Later, payment retries,
receipts, cancellation and refunds retain the saved authoritative total.
There is no automatic reconciliation or refund for a difference between the
advance estimate and an eventual E-ZPass bill. Existing refund rules remain.

## Estimated-toll arithmetic

1. Use the server's selected Google driving route and verified endpoint states/
   counties. Browser amounts, state/county claims, crossing names, vehicle/class
   assertions and history are ignored.
2. Identify one Lincoln/Holland/GWB traversal from substantial ordered matches
   against both NJOGIS and NYC OTI reference portions. A name, nearby point or
   via label is insufficient. These references support estimation, not certified
   commercial coverage. No individual address pair or every local road needs
   preapproval. Ambiguous/missing/unsupported geometry uses included tolls.
3. Use official PA Class 1 NY/NJ E-ZPass rates: $14.79 off-peak / $16.79 peak
   NY-bound, zero PA component NJ-bound. Weekday peaks: 06:00–10:00 and
   16:00–20:00; weekend peaks: 11:00–21:00, America/New_York. Evaluate the
   provider crossing-step static/traffic time window, not pickup time. A window
   spanning a tariff boundary uses its higher applicable rate as a conservative
   estimate. Unsupported years or uncertain calendar-day boundaries use included
   tolls. [PA schedule](https://www.portauthoritybuilds.com/bridges-tunnels/en/tolls.html).
4. Internally estimate standard daily CRZ charges at $9 peak / $2.25 overnight.
   Assume the first chargeable entry of this booking/day, not a verified first
   entry of the actual driver's day. Share only this assumed ledger across this
   booking's directions and do not charge the day twice. Eligible peak Lincoln/
   Holland entries receive up to $3 credit, subject to the $5 daily ceiling.
   No overnight credit or TLC per-trip plan is assumed. Overnight-first/later-
   peak credit uncertainty uses included tolls.
   [MTA schedule](https://www.mta.info/document/138931).
5. Lincoln/Holland NY-bound connections follow the MTA connection map. GWB
   entry needs a matched local-street witness below 60th; wholly northern
   NY-side geometry has no CRZ component. Selected Dyer/Canal/Midtown witnesses
   are not a complete zone polygon. West Street/FDR are not witnesses.
   Street evidence must be continuous; separate intersections with excluded
   roads cannot be accumulated into an entry. Reverse journeys identified as
   starting on covered Manhattan streets assume no new charge merely for
   exiting; unproved starting zones and uncertain entries from other boroughs
   use included tolls.
   [MTA connection map](https://www.mta.info/map/36226).
6. For each direction, use the **greater of Google's one whole-route estimate
   and the known official PA + estimated CRZ − eligible credit subtotal**.
   Never add Google aggregate plus components, route plus leg totals, or call
   the residual an identified road charge. This is an estimate envelope, not
   component reconciliation. Google's aggregate can include additional NJTA/MTA
   roads; their commercial accuracy and congestion inclusion remain unverified.
   Unknown provider money uses included tolls rather than a partial charge.
7. Sum independently assessed directions and deduct only the existing fare's
   toll allowance once per direction. Do not discount or tip added tolls.
   Provider amounts above $1,000 per direction are outside this estimate policy
   and use included tolls.

Google has no actual vehicle/day ledger. If another same-day round-trip leg's
nonzero aggregate could overlap a CRZ charge, the entire toll estimate uses
**Tolls Included**. Do not guess a subtraction or risk billing a daily charge
twice. Round trips remain bookable; the company pays that unresolved cost.

The envelope can over- or underestimate settlement. It may not capture every
additional-road adjustment, classification, prior daily entry or later credit.
The company bears these differences. Unknown road coverage is never labelled
verified or free. Queens-Midtown/Carey $1.50 eligible peak credits remain in the
separate verified engine; the simple mode does not add them independently to
Google's aggregate. Such routes use the envelope only when required PA/CRZ
evidence is supported, otherwise included tolls.

## Configuration and class eligibility

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
Business/OL/2Ax alone cannot fill them. Missing inputs use included tolls.
Do not copy synthetic fixtures into production or mark commercial/congestion
verification flags true. No real vehicle classification is certified here.

Exact settled transactions and a real Google test key/export remain unavailable.
Their comparison is pending; settlement history is no longer an advance-estimate
gate. Operator confirmation of eligible class/plan and acceptance of the estimate
policy are still necessary before separately approved activation. No migration
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
bounded geometry fields. A failed toll request retries once without toll extras
to recover the ordinary fare; if ordinary routing also fails, the existing
inability to quote remains. Google toll requests retain the existing billable
API tier. No live Google/Stripe call or new paid service was used in tests.
