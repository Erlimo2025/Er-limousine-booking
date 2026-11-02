# First Orange / Newark acceptance review

November 1, 2026; draft PR #1, `codex/official-toll-tariffs`.
Runtime under test: `8cf3b47494560331f3e5e2f6aba5aa1a4c43251e`.

**No real-world route has passed acceptance.** The operator confirmed that
settled E-ZPass records, official vehicle-class confirmation, a local approved
Google test key and a server-fetched route export are not available yet. Actual
account comparisons and classification verification are pending. No transaction,
settled charge, GPS path, account identifier or vehicle proof has been invented.

This follow-up adds public source data, a reproducible desk review and isolated
software controls. It changes no runtime booking, fare, payment, authentication,
storage or configuration code. Both repository feature flags remain false.
No production database, Stripe account or Render configuration was accessed.

## Six first-route trials

Public origins: Orange City Hall, 29 North Day Street, and Newark Penn Station,
Raymond Plaza between Raymond Boulevard and Market Street. Public destination:
Grand Central, 89 East 42nd Street, Manhattan. These are input references;
server Place IDs, legal pickup curbs and coordinates remain unverified/null.

| Trial | Origin | Requested crossing | Isolated Pay Now / Pay Later controls | Actual selected route / settled comparison |
| --- | --- | --- | --- | --- |
| F001 | Orange City Hall | Lincoln | Passed with synthetic providers | Pending / pending |
| F002 | Orange City Hall | Holland | Passed with synthetic providers | Pending / pending |
| F003 | Orange City Hall | GWB | Passed with synthetic providers | Pending / pending |
| F004 | Newark Penn | Lincoln | Passed with synthetic providers | Pending / pending |
| F005 | Newark Penn | Holland | Passed with synthetic providers | Pending / pending |
| F006 | Newark Penn | GWB | Passed with synthetic providers | Pending / pending |

The named crossing is an experiment target, not an observed result. A via point
or address label does not prove it. No actual full-route price is assigned.
Every real case remains manual review until its complete route, legal access,
vehicle class, time windows, extra toll facilities and daily facts are established.
The machine-readable [case file](first-route-cases.json) retains null evidence
and charge fields. The broader 45-case matrix remains unexecuted.

## Public geometry evidence

The independent desk review checked provenance, feature IDs, original geometry
hashes, agency attributes, relative levels and exact source endpoints. It
approves source attribution and the reported attribute counts, **not runtime
charging coverage**. See [road-evidence-review.json](road-evidence-review.json).

The existing [NJOGIS candidates](candidate-nj-roads.geojson) contain 3,722
features. The Lincoln/Holland/GWB-labelled subsets contain 24/15/33 features;
all have NJ/NJ state attributes. Their exact endpoint-plus-relative-level
subgraphs have 4/2/9 components. These are subset diagnostics: other road names
may connect them. They neither prove the full network disconnected nor certify
a bridge/tube connection. NJ elevation codes are relative intersection levels,
not surveyed heights or independently established upper/lower bridge identity.

New [NYC OTI/CSCL candidates](candidate-nyc-roads.geojson) add 409 actual source
features for the crossings and selected Dyer/Canal/West/Fort Washington approaches.
Core Lincoln/Holland/GWB labels account for 37/39/27 features. Raw MultiLineString
geometry and selected public infrastructure fields are preserved. No source
geometry was snapped, buffered, simplified or joined across the NJ/NY seam.
The exact bounded query, response hash and timestamp are in
[nyc-geometry-provenance.json](nyc-geometry-provenance.json).
[Official dataset](https://data.cityofnewyork.us/City-Government/Centerline/inkn-q76z),
[source terms](https://cityofnewyork.github.io/opendatatsm/publicpolicies.html).

NYC street labels include bus/pedestrian approaches; domain codes, driving
permissions and relative levels still require review. This selection is not
complete Manhattan coverage. It does not establish NJ OL access, live closures,
CRZ inclusion or excluded-road transitions. The source provides no accuracy or
fitness warranty. **Zero road links and zero toll facilities are approved for
activation.** Candidate artifacts are rejected by the runtime loader.

## Official tariff review

Conditional PA Class 1 NY/NJ E-ZPass rates remain $14.79 off-peak / $16.79 peak,
collected NY-bound. The reverse PA component is zero; that does not waive other
facilities or congestion charges along a reverse route. Class, readable tag and
actual crossing time must be proved independently. A $19.55 charge alone cannot
establish Mid-Tier treatment or classify this vehicle.
[PA schedule](https://www.portauthoritybuilds.com/bridges-tunnels/en/tolls.html).

The Phase 1 standard daily MTA reference remains $9 peak / $2.25 overnight.
Eligible peak Lincoln/Holland entries allow up to $3 credit; Queens-Midtown/Carey
entries or exits allow up to $1.50, subject to the published $5 daily limit.
Known eligible later crossings may consume remaining allowance without adding
another daily congestion toll. Unknown prior charges/credits, the actual
standard-daily plan and overnight-first/later-peak settlement remain blockers.
No NYC TLC per-trip enrollment is assumed. Date-specific schedule changes must
also be checked before accepting a route.
[MTA detailed schedule](https://www.mta.info/document/138931).

NJTA rates must follow independently identified entry/exit pairs, account/class
eligibility and NJTA's own entry-time periods. The current table also specifies
an adjustment for a paid 18W exit followed by a 19W exit within 20 minutes,
applicable to exit movements. Adopted resolution 2026-04-124 explains the
Meadowlands context and commencement conditions; this review did not establish
the exact historical implementation date. This is not a general Manhattan/GWB
waiver. No new runtime waiver is implemented. A route needing this unmodelled
collection context stays manual review; do not add both tolls blindly or waive
a charge from a road name.
[NJTA table](https://www.njta.gov/document/2026-turnpike-class-1-passenger-cars-2-axles/),
[adopted resolution](https://www.njta.gov/document/minutes-bm-4-21-2026/).

Unknown extra toll roads and incomplete entry/exit coverage remain unknown,
never zero. No Google aggregate is added to independently calculated components
or used as a residual. The public tariff file contains conditional component
references only; every real full-route amount remains null.

## Isolated controls and release gate

`tests/first-route-acceptance.test.cjs` runs 14 controls: one public desk-review
test, one guard test covering all six trials with each candidate source or a
missing vehicle profile, and 12 Pay Now/Pay Later simulations. All Google,
vehicle/day proofs, road coverage and Stripe responses in successful controls
are explicitly synthetic. The GWB simulation contains an explicit synthetic
path into the test congestion zone; GWB alone does not imply a CRZ entry.

The controls verify quote cents equal stored cents and Stripe-mock cents,
Pay Later initially creates no Checkout session, payment retries reuse one
session, and only the mock signed webhook establishes paid state. With missing
class or unapproved geometry, quote and both booking choices return manual
review before any reservation, Checkout session or saved-card action is created.
No real customer was charged. Passing these controls does not validate a real
route, commercial class or E-ZPass settlement.
The focused run passed all 14 first-route controls plus the five package checks
(19 passed, zero failed/skipped). Its explicit mock-only
[result snapshot](first-route-software-results.json) records zero real-route,
vehicle-class or settled-account validations.

Before acceptance, provide an approved local routing source and the private,
redacted evidence listed in [vehicle-evidence-checklist.md](vehicle-evidence-checklist.md).
Review actual Google route geometry and time windows against a complete,
directed, access-checked infrastructure catalog, including CRZ exclusions and
every additional facility. Then reconcile debits, daily entries, credits and
later adjustments for the same vehicle/day. Keep private completed comparisons
outside Git. Do not assign real profiles from synthetic test attestations.

Keep `ROUTE_TOLLS_ENABLED=false`; same-state additional tolls remain waived,
hourly behavior remains unchanged, and the eligible EWR → Manhattan SUV offer
remains **$150 total, tolls included**. Keep the separate admin estimate feature
disabled by default. Draft review, evidence acceptance, merge, deployment and
activation remain separate steps requiring authorization.
