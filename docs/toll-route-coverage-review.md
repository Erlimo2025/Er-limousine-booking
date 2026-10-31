# Draft PR #1: reusable toll-route coverage review

Reviewed October 31, 2026 on `codex/official-toll-tariffs`, commit `8a1306e`.
This is a design review. The replacement described below is **not implemented
or production-verified**. This review changes documentation only and leaves
customer charging disabled. The PR remains a draft.

## Finding: the present approval unit is too restrictive

`services/toll-route-evidence.js:144` requires the exact decoded polyline hash,
both endpoint Place IDs and the fleet-policy digest to match a stored full-route
manifest. Its catalog has a 200-manifest limit. A nearby address, a new Place ID,
a different routing-provider point sample or a harmless traffic detour can
therefore reject a route using the same known tunnel and roads. This is safe
against omitted tolls but unsuitable for general address-based booking.

The crossing detector and rate calculator are reusable. The full-route manifest
lookup is the part to replace. Simply deleting that lookup would also delete
the current proof that additional toll roads were considered; that is not safe.

## Recommended approval unit: public road links and toll facilities

Use server-fetched Google route geometry to identify an ordered sequence of
reusable, independently reviewed road/facility records. The approval unit should
be a road link, toll plaza, entry/exit pair or crossing, not a customer's address
pair. Many pickups, destinations and combinations can reuse those records.

1. Keep server verification of endpoint states and the selected driving route.
   Match both directions separately. Browser names, via labels and crossing or
   toll claims remain untrusted. Do not issue another route request merely to
   look up a tariff for geometry already fetched by the server.
2. Reuse directed crossing gates/corridors for Lincoln, Holland and GWB. Require
   a continuous traversal with the expected portal order. Check adjacent roads,
   ramps, overpasses, parallel decks, polyline precision and ambiguous matches.
   Proximity to one portal or a text instruction does not prove a crossing.
3. Match the **entire** selected path to a versioned, reviewed road network or a
   trustworthy toll-coverage service. Every relevant segment must have explicit
   known-free, known-tolled or unsupported status, valid direction and provenance.
   Local streets can reuse public road-link classifications; customers do not
   need individual approval. An unmatched segment, ambiguous link, expired data
   or unknown charge means manual review. A broad NJ/NY polygon and an
   `allTollsReviewed:true` flag alone are not coverage evidence.
4. Recognize additional facilities in route order. A ticket-system road needs
   its actual entry and exit plus the applicable authority's class/rate table;
   a barrier/ramp needs the correct direction and plaza. A nearby toll-free
   frontage road must not match the tolled highway. An incomplete entry/exit,
   unknown facility or unsupported rate cannot contribute an invented zero.
5. Determine CRZ entries and excluded-road transitions from reviewed geometry.
   Feed only verified events into the existing pure tariff calculator. A GWB
   traversal does not itself establish a zone entry. Model other MTA tunnels
   and their credit interactions separately before supporting those routes.
6. Calculate each official component once. Google aggregate tolls remain
   reference diagnostics; do not add them to components or subtract known
   tariffs from them to invent a residual. A matching aggregate alone does not
   establish correct commercial classification or complete facility coverage.
7. Keep geometry digests for integrity and quoteRevision binding, not as an
   address whitelist. Bind snapshot amounts to tariff, evidence and vehicle
   versions. Keep the existing accepted-snapshot reader and immutable totals.

This supports arbitrary addresses **within established network coverage**.
It does not claim all of NJ/NY/CT/PA can be covered by the three PA prices.
Coverage can expand by adding reusable links and tariffs without approving
every new origin/destination combination. Until the replacement is implemented
and validated, the current exact-route safety guard stays in place.

For ordinary bookings, the reusable coverage would work as follows:

| Journey | Coverage needed, reused across customer addresses |
| --- | --- |
| NJ local streets to Midtown via Lincoln | Known-free approach/destination links, directed Lincoln traversal, actual zone-entry/credit events and vehicle/day facts. |
| NJ to upper Manhattan via GWB | Known approach-road costs, GWB direction, and proof of whether the selected path ever enters the CRZ. A Manhattan destination does not establish that event. |
| NJ to Brooklyn/JFK | Every actual facility and road segment. Some routes can use Goethals, Bayonne or Outerbridge rather than the three currently supported Hudson crossings; other MTA crossings and NJ entry/exit tolls need separately supported tariffs. |
| NYC to NJ | No NJ-bound PA charge, but any applicable NJ road/ramp charges remain relevant on this interstate journey. Zero PA toll does not make the full route free. |

The replacement should consume an ordered facility-event sequence. Do not assume
every trip uses exactly one of the current three crossings. Unsupported events
or unexplained repeat traversals remain manual review until their pricing and
daily-credit interactions are implemented and verified.

## Why Google alone does not close the remaining gap

The documented Google `TollInfo` response exposes aggregate monetary estimates
for a route/leg, rather than a verified physical-facility inventory. Google's
estimate is for non-commercial vehicles and can have unknown fees. Those facts
do not establish every road's commercial rate, applicable credits or daily
congestion history. See [Google toll documentation](https://developers.google.com/maps/documentation/routes/calculate_toll_fees)
and the [TollInfo schema](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TollInfo).

`avoidTolls` is a routing preference, not proof that an eligible route contains
no other tolls. It must not silently change the selected route or waive unknown
costs. See [RouteModifiers](https://developers.google.com/maps/documentation/routes/reference/rest/v2/RouteModifiers).

A separately licensed road/toll dataset or coverage provider is an option, but
none has been chosen, purchased, contacted with customer geometry or verified
by this review. Assess coverage guarantees, freshness, permitted Google-content
use, commercial-vehicle support, privacy, costs and failure behavior first.
Agency maps/tariffs can support an audited local catalog; a map or a few sample
journeys alone does not prove the complete road network has no other tolls.

## Evidence and configuration still needed

| Area | Required before customer charging |
| --- | --- |
| Road coverage | A source/licence and versioned, independently reviewed directed network; PA portals/corridors; all relevant additional plazas/entry-exit systems; explicit toll-free coverage; ambiguity tolerances, freshness and expiry checks. No production dataset is included. |
| Vehicle | Evidence that the actual dispatched vehicle meets PA Class 1 physical criteria, has the eligible NJ-issued account and a mounted/readable tag, and uses the standard daily/non-TLC MTA plan. NJ OL, Business and 2Ax labels alone are insufficient. Other agencies require their own class/discount mapping. |
| Vehicle assignment | Bind evidence to the actual vehicle or a proved homogeneous fleet. A booking category such as `suv` does not itself identify a vehicle's daily entries or prove every possible dispatched SUV has the same tariff eligibility. |
| Time | A reviewed uncertainty model for reaching each facility from the scheduled departure, in America/New_York. Keep manual review when the interval crosses a rate/date boundary; refuse unsupported schedules/years. |
| Congestion | Reviewed zone and excluded-road/local-street transition geometry, daily context for the actual vehicle, and eligibility for credits. Resolve unknown outside-booking entries or separately approve a disclosed estimate policy; no policy is approved by this review. |
| Additional roads | Current official tariffs and issued-tag eligibility for the actual facilities used, including NJ roads/ramps and relevant MTA bridges/tunnels. Unsupported additional costs stay manual review. |
| Acceptance | Match settled charges with the same route, direction, date/time and vehicle, then run controlled non-production reservation/Stripe test-mode acceptance. Synthetic tests do not establish real commercial parity. |

The [PA published schedule](https://www.portauthoritybuilds.com/bridges-tunnels/en/tolls.html)
still governs the existing Class 1 calculator. Mid-Tier/unknown tag status must
not silently receive the lower standard rate. No tariff amounts change here.

MTA daily tolls, credits and excluded roads are separate from PA crossing
recognition. Follow the [MTA toll rules](https://www.mta.info/fares-tolls/tolls/congestion-relief-zone/about)
and [official connecting-road maps](https://www.mta.info/map/36226). Preserve
manual review when daily history or a qualifying credit cannot be established.
Do not infer a TLC per-trip plan from a limousine business description.

Existing settings remain unchanged:

* `ROUTE_TOLLS_ENABLED=false` or unset: customer toll additions disabled.
* `ADMIN_TOLL_VALIDATION_ENABLED=false` or unset: independent admin tool disabled.
* `TOLL_VEHICLE_PROFILES_JSON`: server-only evidence; leave unverified fields
  unverified. The present `official2026` validation remains in force.
* `OFFICIAL_TOLL_COVERAGE_JSON`: the current v1 exact-route schema still applies.
  A future reusable network schema needs its own version, validation and tests.
  Do not insert a broad regional approval into the existing schema or set
  verification booleans merely to bypass its checks.

No new configuration values are supplied or activated by this review. A reusable
dataset may be a versioned server artifact rather than a large environment
variable; its loading/update strategy still needs implementation review. No
Render settings, credentials, paid services or database migration are needed
for this documentation review.

## Preserved business rules and replacement acceptance tests

Same verified pickup/destination state: no additional tolls. Regular interstate
journeys: consider the entire eligible route, including same-state segments
within that interstate journey. Round trips: evaluate each direction, with
vehicle/day-aware congestion handling. Hourly bookings remain unchanged when
the full route is unknown. The qualifying EWR-to-Manhattan SUV special remains
exactly **$150 total including tolls**, even with unknown internal toll costs.
Existing accepted fares, Stripe amounts, refunds, cancellation and ownership
rules remain unchanged.

Before replacing the current guard, add tests for many synthetic address pairs
and benign reroutes reusing the same verified facilities; known-free links;
unknown/new/expired road links; frontage roads and ambiguous crossings; complete
ticket-road entry/exit matching; unknown additional tolls; all supported issued-tag
class mappings; excluded-road transitions and other MTA credit sources; date/time
boundaries; vehicle-specific daily history; independent directions; and accepted
snapshot/retry/Stripe/refund consistency. Retain the EWR, hourly, same-state,
authentication, guest-ownership and manual-review regressions.

The existing full suite validates the current guarded implementation, not this
proposed replacement. Production activation remains blocked pending both the
coverage refactor and the evidence/acceptance work above.
