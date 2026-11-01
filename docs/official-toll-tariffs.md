# Official 2026 toll tariffs — inactive preparation

The reusable road-network replacement is implemented in `services/toll-road-network.js`
and used by new toll-enabled interstate quotes. It replaces full-route/address-pair
approvals. It is **not activated or production-certified**. Both feature flags
remain disabled by default. No real fleet classification, settled E-ZPass history,
public road-network dataset or additional commercial tariff table is certified
for activation by this PR. Synthetic test evidence must never be copied into production.

The [real-route acceptance package](toll-acceptance/2026/README.md) adds a sourced,
unapproved public-road candidate dataset, selected tariff references, a planned
route matrix and private vehicle-evidence requirements. It leaves the engine
unchanged. In particular, the detailed MTA schedule's Queens-Midtown/Carey credit
terms need clarification before those cases can be certified. The general
up-to-$3 description below must not be treated as that missing proof.

## Published arithmetic and preserved fares

`services/official-toll-rates.js` retains the pure integer-cent 2026 PA/MTA
calculator, version `pa-class1-mta-standard-2026-v1`, using America/New_York.
It accepts January 4, 2026 at 00:01 New York through the end of 2026. Unsupported
years, dates and uncertain rate boundaries require manual review.

* Lincoln, Holland and GWB Class 1 with eligible NY/NJ E-ZPass and readable tag:
  NY-bound $14.79 off-peak or $16.79 peak. Weekday peak is 06:00–10:00 and
  16:00–20:00; weekend peak 11:00–21:00. NJ-bound PA charge is zero.
* Standard daily small-commercial/passenger SUV CRZ: $9 peak or $2.25 overnight,
  weekday peak 05:00–21:00 and weekend peak 09:00–21:00.
* Eligible peak entry through Lincoln, Holland, Queens Midtown or Hugh L. Carey
  can receive up to $3 credit, capped by the applicable charge and crossing cost.
  GWB itself supplies no credit. Overnight supplies none. Unknown eligibility
  requires review.

Sources checked October 31, 2026:

* [PA schedules and Class 1 definition](https://www.portauthoritybuilds.com/bridges-tunnels/en/tolls.html)
* [PA 2026 effective date and direction/time periods](https://www.portauthoritybuilds.com/content/dam/bridges-tunnels/2026-toll-rates/Truckers%20Guide_Eng_Jan%202026.pdf)
* [MTA daily rates and credits](https://www.mta.info/fares-tolls/tolls/congestion-relief-zone/about)
* [MTA excluded-road connection maps](https://www.mta.info/map/36226)
* [Google geometry/static-duration fields](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes)
* [Google toll-estimate scope and commercial limitations](https://developers.google.com/maps/documentation/routes/calculate_toll_fees)

Same verified pickup/destination state: no added tolls, even on a tolled route.
Regular interstate bookings consider the entire selected route, including its
same-state road segments. Hourly behavior is unchanged. Eligible EWR → Manhattan
SUV remains **exactly $150 total, tolls included**, without coupon, surcharge or
gratuity additions; unknown internal toll costs do not block or increase it.
EWR verification, A/B/C/General handling and Terminal C fallback remain in place.

Existing fare, discount, surcharge, gratuity and toll-allowance order is unchanged.
New tolls are not discounted or tipped. Quote, immutable reservation snapshot,
confirmation email, Checkout/payment completion and refund use the same saved
integer cents. No Stripe, ownership, cancellation, customer-account or database
migration behavior is redesigned.

## Working reusable coverage

One server-requested Google DRIVE route per direction supplies HIGH_QUALITY
step polylines, step/static duration, route distance/duration and toll information.
No extra route call is made per tariff component. A selected path must match a
unique, connected sequence of reviewed directed road links. There is no stored
pickup/destination Place-ID whitelist or full-route hash approval.

The matcher clips **every route segment** against bounded convex road cells.
Provider vertices on opposite sides of an uncovered gap cannot hide that gap.
Topology, travel direction and monotonic progress must agree. Alternate known
local streets and different point sampling can reuse the same infrastructure.
Parallel/frontage roads, disconnected node identities and ambiguous paths require
review; it never chooses a cheaper/free interpretation to resolve ambiguity.
Google-verified endpoint states must match the covered route endpoints.

Each link is explicitly `free`, `facility` or `unsupported`. Missing, expired,
unsupported or ambiguous coverage returns the existing
`TOLL_ESTIMATE_UNAVAILABLE`/422 response before a new reservation or payment
session. Google reporting no price or zero does not fill missing coverage.

Both reviewed portals in a continuous corridor establish the actual Lincoln,
Holland or GWB crossing and its direction. The detected crossing must agree with
the matched facility road links. Client text, via labels, coordinates, crossing
names, money, vehicle proofs, daily facts and fake network JSON cannot authorize
a tariff. A route digest still binds quoteRevision and the saved proof, but is
an audit value rather than an eligibility whitelist. New quoteRevision values
bind the ordered verified infrastructure/tariff proofs and authoritative price;
harmless point resampling on those same links does not invalidate checkout.
Older official snapshots keep their original geometry-bound revision formula.

The present supported scope requires one unique crossing among Lincoln/Holland/
GWB per direction. Other PA crossings, no-crossing interstate routes, repeated
facilities or multiple PA traversals remain manual review. The code does not
claim every NJ/NY/CT/PA journey is covered by these three tariffs.

## Server coverage schema and bounded loading

The active schema is `reviewed-road-network-2026-v2`. Supply exactly one source:

* `OFFICIAL_TOLL_COVERAGE_JSON`: inline server-only public infrastructure JSON.
* `OFFICIAL_TOLL_NETWORK_FILE`: a server-controlled UTF-8 JSON artifact path,
  outside the public web directory. This is useful for larger reusable datasets.

Both are blank by default. Neither setting is taken from an HTTP request. Input
is limited to 8 MiB; infrastructure indexing is cached for the current content.
Expiry is still checked per quote. Only infrastructure is cached, never customer
routes, GPS history or E-ZPass transactions. File errors do not reveal paths or
contents. No new service/database is needed.

Required catalog fields:

| Field | Meaning |
| --- | --- |
| `version`, `evidence`, `validFrom`, `validUntil` | Versioned provenance and bounded 2026 validity. Evidence is an operator-controlled reference, not independently verified by the program. |
| `nodes` | Unique public-road `id`, `point:[longitude,latitude]` and reviewed `state` (NJ, NY, CT or PA). |
| `roads` | Unique `id`, `from`/`to` node IDs, convex `corridor`, explicit `bothDirections`, `kind`, optional `facility`, evidence and validity. Curves use connected straight links. |
| `junctionMeters` | Reviewed junction tolerance, 1–8 metres. Each road cell is constrained near its 10–2500 metre link; broad geographic boxes are refused. |
| `crossings` | All three PA portal pairs/corridors with radius and survey evidence. Built-in NYC envelopes are sanity limits, not surveyed geofences. |
| `facilities` | PA `pa_2026`, additional `table` tariffs or explicit `unsupported` facilities. PA rates cannot be overridden in JSON. |
| `crz` | Reviewed zone polygon, excluded-road polygons, evidence and `creditConnectors`. |

Limits include 20,000 nodes, 12,000 road links, 20 facilities, 600 provider steps,
6,000 provider points, six-hour routes, bounded spatial cells/comparison work and
candidate paths. Over-complex input fails closed. These are conservative limits,
not a promise that arbitrary global routing is supported.

There is no `routes` manifest array in v2. Legacy v1 address-manifest configuration
cannot authorize a new quote. Existing accepted v1 snapshot readers remain.

## Additional roads and NYC crossings

The working table engine supports NJ Turnpike/Garden State Parkway, and registered
MTA facilities: Queens Midtown, Hugh L. Carey, Verrazzano, RFK, Bronx-Whitestone,
Throgs Neck, Henry Hudson, Cross Bay and Marine Parkway. **No real extra-road
rates or commercial classifications are assumed by registering their names.**

A facility road run must contain a complete matched entry and exit, with
surrounding non-facility coverage. Starting/ending partway along it requires
review. Multiple road links of one facility are grouped into one charge.
An unsupported facility, missing tariff or unexplained repeat traversal is never
free. Outbound and return select their own entry/exit/direction records.

A `table` facility supplies `authority:'njta'|'mta'`, `timeBasis:'entry'|'exit'`,
label, evidence and `rates`. Every rate needs:

* `entry`/`exit` node IDs; the opposite direction needs its own applicable record.
* `vehicleClass`, `tollPass:'US_NJ_EZPASSNJ'`, `currency:'USD'`, integer
  `amountCents`, `version`, evidence and effective validity.
* `days:[0..6]` (Sunday=0), `startMinute` and exclusive `endMinute` in New York
  time. Split overnight periods into distinct records. Holiday exceptions need
  explicit date-valid records rather than an invented holiday rate.

Exactly one record must cover every possible time in the facility's uncertainty
window. Gaps, overlapping records, expired data, changed rates or an unproved
authority class fail closed. The program does not infer an MTA NY-issued-tag
discount from an NJ account or inherit NJTA/MTA classification from PA Class 1.

Google route/leg aggregates are never added to components, nor used to invent
a residual. Extra-road tariffs must be independently sourced and non-overlapping
with the PA/CRZ components. Fixture amounts such as the test's Queens Midtown
value are explicitly synthetic and are **not** a proposed production tariff.

## Vehicle, timing, congestion and credits

The selected product's server `TOLL_VEHICLE_PROFILES_JSON.official2026` still
requires `vehicleKey` binding and physical PA Class 1/tag/plan proof:
two axles, single rear wheels, no trailer, NJ issuer, mounted/readable tag,
standard daily MTA plan, non-TLC status, separate evidence refs and expiry.
Business, NJ OL and 2Ax labels alone are not enough; unknown/Mid-Tier status fails.

The network path additionally requires `fleet.vehicleRef` and
`fleet.assignmentEvidence`. This must bind an actual eligible dispatched vehicle;
a category label is not a vehicle's daily history. Extra facilities require
`fleet.authorities.njta|mta` with the applicable `vehicleClass`, evidence and
`validUntil`. No evidence is supplied for the operator's real vehicle by tests.

The reviewed `timing` uncertainty uses preceding step durations, the entire
facility step, positive route traffic delay and explicit extra slack. Tariff or
calendar-day boundaries within that window require review. It is an estimate
model requiring real calibration, not a promise of exact future crossing time.

CRZ entries come from the actual path, excluded-road polygons and local-street
transitions. Reviewed credit connectors contain the reusable ordered road tokens
(`road_id:f` or `road_id:r`), source facility, evidence and validity. Direct entry
within a verified qualifying facility can supply that source; a later connection
needs matching connector evidence. GWB itself never creates a tunnel credit.

Peak credit also requires `official2026.crossingCredit` with explicit
`eligibility:'eligible'|'ineligible'`, evidence and expiry. An unknown entitlement
cannot be treated as no credit. Each eligible component is counted once; a
Queens Midtown/Carey credit is associated with that actual entry, not the PA name.

Daily context is keyed to the actual vehicle and New York calendar day:

* Known same-quote/day charge prevents another CRZ charge or credit.
* Optional server `dailyFacts[YYYY-MM-DD]` can assert `already_charged` only with
  the matching `vehicleRef`, evidence, `observedAt` and `validUntil`. Future-dated
  observations, wrong days/vehicles and expiry within the entry window fail.
  The server clock is used; browser time/history cannot establish this.
* Otherwise absent context means review. The separate
  `dailyPolicy.kind:'assume_first_entry_estimate'` requires explicit
  `operatorApproved:true`, matching vehicleRef and evidence. Its assumption
  appears in the quote/email. **The operator has not approved this estimate
  policy by approving implementation.** Do not set it to make tests pass.

No E-ZPass feed or persistent daily-history service is created. Evidence strings
are attestations to separately reviewed records, not automatic agency-document
verification. No tag/account numbers, plates, secrets or personal GPS history
belong in infrastructure/evidence fields.

## Snapshot compatibility and release gates

New snapshots use `format:'official_network_2026'`, the network schema version,
strict component validation and road/tariff/fleet proof digests. They retain no
route polylines, network data, raw evidence refs or vehicle identifier. Existing
`official_2026`, older Google-based and no-toll-field accepted snapshots remain
readable/payable without consulting new infrastructure or repricing.

Keep immutable 2026 readers when introducing later schedules. To roll back after
accepted network snapshots exist, disable new customer charging while retaining
their reader; do not roll back to code unable to validate them or rewrite their
saved fields. Existing captured payment/refund amounts stay frozen.

Before activation:

1. Independently review real directed road coverage, PA portals, excluded roads,
   connector transitions and all relevant extra-facility entry/exit tariffs.
2. Establish actual vehicle/tag, per-authority class and assignment evidence.
3. Resolve reliable daily/credit history or separately accept the disclosed
   estimate policy; calibrate crossing-time uncertainty.
4. Compare matching route/direction/date/time/vehicle settled E-ZPass charges,
   including Mid-Tier anomalies and additional road segments.
5. Complete authorized non-production route/reservation/Stripe test-mode acceptance.
   Synthetic functional/PG tests do not prove commercial bill parity.
6. Review this draft PR and obtain separate merge/deployment/activation approval.

`ROUTE_TOLLS_ENABLED=false` and `ADMIN_TOLL_VALIDATION_ENABLED=false` remain
defaults. The admin estimate-only Google tool stays separate. No Render settings,
credentials, production database or live Stripe calls are changed/used.
The expanded geometry uses the existing Compute Routes TOLLS billing feature,
without an extra call per road or component. Any future external data/provider
cost, licensing or Google-content permission needs separate review.
