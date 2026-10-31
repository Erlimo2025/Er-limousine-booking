# Official 2026 toll tariffs — inactive preparation

This is a new implementation from the operator's supplied specification. The
original package's JavaScript was unavailable; its 13-test transcript is not
claimed as a run of this code. The new arithmetic suite has its own 13 tests.

`ROUTE_TOLLS_ENABLED=false` and `ADMIN_TOLL_VALIDATION_ENABLED=false` remain the
defaults. Nothing in this work changes Render, credentials, a database schema,
an existing booking, a refund or a Stripe setting. No extra Render service is
needed. There is **no production-certified geometry catalog or fleet evidence
shipped in the repository**. Tests contain clearly synthetic attestations.

## Published schedules and scope

`services/official-toll-rates.js` is a pure integer-cent calculator. Its version
is `pa-class1-mta-standard-2026-v1`, using America/New_York. It accepts crossings
from January 4, 2026 at 00:01 New York until January 1, 2027. Earlier or later
dates require review; a future schedule is never extrapolated automatically.

* PA Class 1, NY/NJ E-ZPass, readable mounted tag: NY-bound $14.79 off-peak or
  $16.79 peak. Weekday peak is 06:00–10:00 and 16:00–20:00; weekend peak is
  11:00–21:00. NJ-bound PA crossing charge is zero. No holiday exception is
  invented. This module handles Lincoln, Holland and GWB.
* MTA standard daily passenger/small-commercial SUV plan: $9 peak, $2.25
  overnight. Weekday peak is 05:00–21:00; weekend peak is 09:00–21:00.
  Only a new zone entry can create a charge. Starting inside and leaving the
  zone does not itself create a new entry.
* Eligible peak Lincoln/Holland credit is up to $3, capped by applicable charges.
  GWB has no such credit; overnight has none. Unknown eligible peak tunnel
  credit requires review, not an assumed zero credit.

Sources checked October 31, 2026:

* [Port Authority schedule and Class 1 definition](https://www.portauthoritybuilds.com/bridges-tunnels/en/tolls.html)
* [PA 2026 effective date, direction and time periods](https://www.portauthoritybuilds.com/content/dam/bridges-tunnels/2026-toll-rates/Truckers%20Guide_Eng_Jan%202026.pdf)
* [MTA zone, exclusions, daily plan, rates and credits](https://www.mta.info/fares-tolls/tolls/congestion-relief-zone/about)
* [Google route geometry and step/static-duration fields](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes)

## Actual route evidence and complete coverage

New toll-enabled interstate quotes request one selected Google DRIVE route per
direction with HIGH_QUALITY step polylines, step/static duration, distance and
route duration. The bounded field mask is exported as `officialFieldMask`.
Names, directions, crossing claims, coordinates, geometry, amounts and verification
flags submitted by the browser cannot establish tariff eligibility.
Provider fallback responses and inconsistent geometry/distance/timing require review.

The geometry parser bounds steps, point count, coordinate ranges and gaps. A PA
crossing requires both reviewed portals in the correct order within a continuous
convex crossing corridor. Passing a portal nearby or selecting a via point does
not prove a crossing. Missing or multiple crossings fail closed. Built-in NYC
envelopes are only sanity limits, not certified crossing geofences.

The CRZ decision uses intersections of the actual path with a reviewed zone
polygon and reviewed excluded-road polygons. It can detect entry between two
outside endpoints. Parallel travel along an uncertain zone/exclusion boundary
requires review. Reviewers must include the actual FDR/Route 9A/Hugh L. Carey
connections and their tolled local-street transitions; a coarse Manhattan box
or a destination label is not an acceptable production catalog.

`OFFICIAL_TOLL_COVERAGE_JSON` is server-only, with version
`reviewed-route-geometry-2026-v1`. It contains:

* `evidence`, all three `crossings` (`id`, `nj`, `ny`, convex `corridor`,
  `portalRadiusMeters`, `evidence`), and `crz` (`polygon`, `excluded`, `evidence`).
  Coordinates are public road geometry in `[longitude, latitude]` order.
* A bounded `routes` array. Each full-route manifest binds `geometrySha256`,
  `catalogSha256`, `fleetSha256`, `originPlaceId`, `destinationPlaceId`, the actual
  `crossing`/`direction`, `crzEntries`, `allTollsReviewed:true`, `evidence`,
  `validFrom`, `validUntil`, `crzCreditSource`, `creditEligibility`/`creditEvidence`
  and `otherTolls`. A zone entry requires reviewed credit coverage even on a GWB
  route: `crzCreditSource` must be `none` (with `ineligible`), or the detected
  NY-bound `lincoln`/`holland` crossing. Unknown or additional MTA tunnel credit
  sources, including Queens Midtown and Hugh L. Carey, require manual review.

The **exact full geometry**, verified endpoint IDs and vehicle-policy digest
must match one manifest. Any reroute, changed catalog, duplicate match, missing
road audit or expired validity interval requires manual review. This is
intentionally restrictive: it is not a claim that three Hudson crossing prices
cover every possible NJ/NY/CT/PA route. No blanket coverage approval is provided.

Other road costs require separately reviewed `id`, `label`, integer USD
`amountCents`, `tariffVersion`, `evidence`, `validFrom`, `validUntil`, and an
inclusive `segments:[first,last]` range in the decoded route. Cost spans cannot
overlap each other, the PA crossing, or CRZ entry. Generic Google/aggregate
totals are rejected as components. Turnpike, Parkway, other MTA crossings or
other-state routes without this independent, nonoverlapping evidence require
review. More complicated bundled/credit scenarios are unsupported, not free.

Google's full-route and leg toll totals are **never added** to these components
or subtracted to infer an unknown road cost. The existing strict Google Money
decoder remains for the separate admin reference tool and legacy snapshots.

For offline candidate inspection, after separately obtaining an authorized test
Google response and reviewed public geometry catalog:

```text
node scripts/inspect-toll-route.cjs --route route.json --coverage catalog.json
```

This makes no network calls, reads no .env and prints only candidate hashes,
crossing/direction and counts. It does not certify coverage or a customer price.
Do not store customer route/GPS history to populate the catalog. Use reviewed
public reference routes and keep any necessary private evidence separately.

## Vehicle, time and daily-entry proof

Each selected vehicle's server `TOLL_VEHICLE_PROFILES_JSON` entry retains its
actual emissions and NJ toll pass, plus a separately reviewed `official2026`:

* `vehicleKey` must match that exact selected vehicle; no inherited approval.
* `fleet`: `paClass:'1'`, `axles:2`, `singleRearWheels:true`, `noTrailer:true`,
  `accountIssuer:'NJ'`, `tagStatus:'mounted_readable'`, `mtaPlan:'standard_daily'`,
  `tlcLicensed:false`, `classEvidence`, `tagEvidence`, `planEvidence`, `validUntil`.
  NJ Business, OL plates, Suburban model and 2Ax alone do not establish this.
  An actual Mid-Tier/unknown tag condition is not priced at the standard rate.
* `timing`: a reviewed `uncertaintySeconds` and `evidence`. The time range uses
  preceding Google step durations, the entire crossing step, all positive
  route traffic delay and the reviewed extra uncertainty. If the range crosses
  a PA/MTA rate or day boundary, the quote is refused. This is an estimate model,
  not a guarantee of actual future crossing time. Calibration/acceptance is
  still required; no production uncertainty policy is supplied.
* `dailyPolicy`: absent/unknown means review for CRZ entries. This implementation
  offers `kind:'assume_first_entry_estimate'` only with `operatorApproved:true`
  and explicit `evidence`. It visibly states the first-entry assumption in
  quote/email, and does not claim exact settlement. **The operator has not
  accepted that policy as part of this implementation.** Do not set it merely
  to make a quote pass. If that policy is not acceptable, a separately designed
  authoritative day-history source is needed before CRZ charging can activate.

The pure calculator also supports independently established first/already-paid
daily facts. The public booking adapter does not accept browser daily claims or
pretend it has an E-ZPass history feed. Within one quoted round trip, it carries
the first chargeable New York calendar day forward so another entry that day
does not add another congestion charge or credit. Separate quote requests share
no driver history. This limitation must be accepted or resolved before activation.

Evidence fields are operator-controlled reference strings, not automatically
validated agency documents. Their existence in configuration is an attestation
to review, not proof generated by tests. Never put plate/tag/account numbers,
API secrets or payment credentials into these fields. Stored quote snapshots
retain digests, classifications and amounts, not route polylines or evidence text.

## Preserved booking/payment behavior

Same verified endpoint state: waive all added tolls without asking for tariff
evidence. Hourly: unchanged fare and payment flow, with no invented route toll.
Eligible EWR → Manhattan Luxury SUV: **exactly $150, tolls included**, without
coupon, surcharge or gratuity additions. Missing internal toll evidence cannot
block or increase that offer; its existing Google/EWR identity checks remain.

Regular interstate total keeps the existing fare, discount, gratuity and toll
allowance order. Official net tolls are neither discounted nor tipped. The quote
shows PA, MTA, eligible credit, separately verified roads and Total Including
Tolls. No new booking step is added. The same components/net cents are saved and
rendered in confirmation email; Stripe uses the existing immutable saved total.

Existing version-1 snapshots, including accepted Google-estimate fares, remain
valid and payable with no repricing. New official snapshots add a format/version,
strictly validated components, and digests bound into quoteRevision. JSONB key
order remains irrelevant. PostgreSQL schema, customer ownership, FIRST15,
cancellation, refunds, webhook authority, payment retries and saved cards are
not redesigned. No migration is necessary.
Keep the immutable 2026 schedule/reader when adding a later tariff version; do
not edit its version in place and invalidate accepted 2026 reservations.

## Controlled release and rollback

1. Review this PR with both flags off. No commit here changes Render. Cancel any
   unsaved production flag edit yourself; this feature does not need activation.
2. Obtain and independently review real fleet class, tag and plan records; a
   statement amount or synthetic test is not proof of commercial rate parity.
3. Review official geometry/excluded-road connections, complete road inventory,
   each exact reference route, time bounds and every additional toll tariff.
   Include NJ→Brooklyn/JFK and unsupported NY/NJ/CT/PA routes as manual-review
   cases until complete nonoverlapping coverage exists.
4. Resolve/accept daily-history and credit-estimate policy; then compare actual
   applicable, settled E-ZPass transactions against matching route/day/time.
5. Run route + reservation + **Stripe test-mode** acceptance checks in an
   approved non-production setup. Do not create a paid Render staging service
   automatically. This PR's tests use synthetic providers and isolated local PG.
6. Merge/deploy only with separate approval. Keep customer charging off until
   the operator approves the evidence and all supported cases. Enabling the
   admin estimate-only feature is a separate approval and separate flag.

Before any accepted official-toll reservation exists, rollback is the previous
code with both flags off. After acceptance, disable **new** toll charging but
retain the official snapshot reader/validator until those records are no longer
needed. Do not roll back to a reader that cannot validate their components, or
rewrite/remove saved toll fields. Payment/refund amounts remain frozen.

The expanded geometry fields add payload, not extra route calls. TOLLS retains
the existing Compute Routes Enterprise SKU; no new Maps SDK, service or database
is introduced. Existing Places verification requests remain. The admin-only
Google total and its rate limits stay independent.

## Local validation on October 31, 2026

Executed sequentially on Node 24.19.0, with synthetic Google/Stripe providers
and a verified localhost-only, nonsuperuser PostgreSQL test database:

| Run | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| New pure tariff and route-evidence tests | 26 | 0 | 0 |
| Full package test selection (`--test-concurrency=1`) | 509 | 0 | 0 |
| Separate PostgreSQL integration selection | 47 | 0 | 0 |
| Separate CSP selection | 5 | 0 | 0 |

The npm CLI was unavailable; the package's complete Node test selection was
executed directly, with the same sequential setting. The initial full run had
one account-fixture clock failure (508/509), and the initial separate PG run had
the corresponding PG clock failure (46/47). Those fixtures now use the harness
clock consistently; production authentication and expiry rules were unchanged.
The final runs above include those corrections. No test was skipped or bypassed.

Local browser checks at 320, 390 and 1440 CSS pixels showed the component rows,
credit, policy warning and total without horizontal overflow or console errors.
Synthetic noon Lincoln quote: $80 fare + $14.79 PA + $9 MTA − $3 credit = $100.79.
Reverse route: $80 with no new PA/CRZ charge. These are fixture demonstrations,
not verified customer-route or commercial E-ZPass statement comparisons.
The EWR special remained $150 with tolls included at all three widths. Browser
checks created zero reservations, Checkout sessions or payment calls. The local
preview and isolated PG server were stopped after validation.

`git diff --check` passed. No production database, Google request, Stripe call,
Render setting, production deployment or customer toll activation was used.
