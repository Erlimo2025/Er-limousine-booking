# 2026 toll network acceptance package

Prepared November 1, 2026 on `codex/official-toll-tariffs`, for draft PR #1.
The original source package targeted engine `320a2e9`; the first-route controls
now test runtime `8cf3b47494560331f3e5e2f6aba5aa1a4c43251e` with corrected daily
credits. Source/candidate artifacts are not runtime approvals.

**Ready for source review and acceptance planning; not ready for activation.**
This package adds public research data and offline checks. A follow-up correction
implements facility-specific congestion credits and complete daily ledgers for
new quotes. It does not certify candidate geometry/fleet information or change
customer UI, existing reservations, Stripe, flags, databases or Render settings.
No real Google route or private E-ZPass account was queried. No real-route
acceptance case has passed yet.

`ROUTE_TOLLS_ENABLED=false` and `ADMIN_TOLL_VALIDATION_ENABLED=false` remain the
repository defaults. No production setting was read or changed in this task.
The eligible EWR to Manhattan SUV special remains **$150 total, tolls included**.
Same-state added tolls remain waived and hourly behavior is unchanged.

## Reviewable artifacts

| Artifact | Contents and limits |
| --- | --- |
| [sources.json](sources.json) | Agency URLs, source scope, retrieval limits and available PDF hashes. |
| [candidate-nj-roads.geojson](candidate-nj-roads.geojson) | 3,722 actual public NJOGIS road features, with original coordinates and source IDs; all candidate/unreviewed, toll status unknown. |
| [candidate-nyc-roads.geojson](candidate-nyc-roads.geojson) / [provenance](nyc-geometry-provenance.json) | 409 original NYC OTI/CSCL features for named crossings/approaches; bounded public query, no geometry edits, all unapproved. |
| [geometry-provenance.json](geometry-provenance.json) | Exact bounded query, fields, four response-page hashes/counts, retrieval times, attribution and transformations. |
| [road-evidence-review.json](road-evidence-review.json) | Reproducible independent provenance/attribute/topology desk review; zero runtime approvals. |
| [first-route-review.md](first-route-review.md) / [cases](first-route-cases.json) | Six Orange/Newark-to-Midtown trials; isolated software controls executed, real routes and E-ZPass comparisons pending. |
| [first-route-software-results.json](first-route-software-results.json) | Explicit synthetic-provider result snapshot; 12 payment flows and six manual-review cases, zero actual route/account validations. |
| [network-inventory.json](network-inventory.json) | Feature references, facility/approach inventory, missing portals/corridors, CRZ/exclusions and credit connectors. **Zero approved links/facilities.** |
| [published-tariff-reference.json](published-tariff-reference.json) | Conditional PA/MTA rates and selected NJTA entry/exit cells; unresolved amounts remain null. No runtime tariff table is configured. |
| [route-testing-matrix.csv](route-testing-matrix.csv) / [JSON](route-testing-matrix.json) | 45 planned cases, 17 public locations and 15 time/replay profiles; all real-route results are empty. |
| [credit-acceptance-scenarios.json](credit-acceptance-scenarios.json) | 12 additional conditional credit cases linked to candidate routes; all unexecuted and unapproved. |
| [vehicle-evidence-checklist.md](vehicle-evidence-checklist.md) | Exact redacted account, vehicle, class, daily-context and transaction evidence needed privately. |
| [comparison-template.csv](comparison-template.csv) | Empty result template. Keep completed private comparisons outside Git. |
| [checksums.json](checksums.json) | Hashes for this public package; integrity checks are not certification. |

These artifacts deliberately use candidate/reference schemas, not
`reviewed-road-network-2026-v2`. Do not load them into
`OFFICIAL_TOLL_NETWORK_FILE` or `OFFICIAL_TOLL_COVERAGE_JSON`. The runtime loader
rejects them. Do not copy synthetic fixture evidence or turn approval flags on
to make a route pass.

## What the public geometry establishes

The supplementary geometry comes from **NJ Office of Information Technology,
Office of GIS (NJOGIS)** [public Road Centerlines item](https://www.arcgis.com/sharing/rest/content/items/fc3d0a95921b4026b386643eef5ff088?f=json),
not from a PA/NJTA/MTA toll-free road inventory. The item warns that its contents
are not survey data. Preserve NJOGIS attribution and review the linked source
conditions before using derivatives in a runtime catalog.

The bounded selection includes highways and selected public-facility streets in
the Orange/Newark to Fort Lee/Hudson corridor. It contains 24 features labelled
Lincoln Tunnel, 15 Holland Tunnel, 33 George Washington Bridge and 587 beginning
with New Jersey Turnpike. Labels are **candidate selectors**, not proof of a
physical crossing, toll facility, legal vehicle access or toll-free road.

All coordinates are unchanged from the official query's `outSR=4326` response.
The export adds provenance, hashes and candidate status only. It does not snap,
buffer, clip, simplify, invent or approve geometry. Full features intersecting
the envelope can extend outside it. Source one-way/elevation fields are retained
for review, not automatically converted into a trusted routing graph.

Missing work includes unlabelled ramps, other local streets, legal pickup curbs,
grade-separated junctions, tube/bridge-level distinctions, portal coordinates,
corridor widths, NYC approaches and road coverage, and the georeferenced CRZ and
excluded-road polygons. Even any source features extending into New York require
independent review. The PA guide and NJTA overview map establish network context;
they are not accurate enough to invent narrow runtime geofences.

The first-route follow-up adds attributed NYC centerline candidates, not a joined
or approved network. NJ/NY seams, tube/level permissions, complete Manhattan
approaches and the CRZ/exclusion geofences still need independent review. Run
`node scripts/audit-toll-road-candidates.cjs` to reproduce the public desk review.
The operator has explicitly deferred actual E-ZPass/class verification and has
neither a local approved Google test key nor a server-fetched route export;
real-route execution is pending. Successful software simulations are not
real-world route passes. See the linked first-route review for exact status.

## Published components and unresolved rates

For an independently confirmed PA Class 1 vehicle with an eligible readable
NY/NJ tag, PA's current table lists $14.79 off-peak / $16.79 peak entering New
York; the reverse PA component is zero. The same table lists $19.55 Mid-Tier.
That amount alone does not establish why a particular transaction cost $19.55.
[PA toll table](https://www.portauthoritybuilds.com/bridges-tunnels/en/tolls.html)

PA, NJTA and MTA use different time periods. Select each at the actual facility
crossing/entry window, not blindly at pickup. The reference file records all
three schedules and refuses to imply 2027 validity. NJTA's passenger table was
visually checked for the selected cells; for example, 15W to 16W is $2.17
E-ZPass or $1.63 eligible NJ off-peak. It is an additional charge only if the
actual eligible interstate route traverses that entry/exit pair. Blank cells
are not zero. Reversed entries were read independently.
[NJTA 2026 passenger table](https://www.njta.gov/document/2026-turnpike-class-1-passenger-cars-2-axles/)

The Parkway table distinguishes Union mainline NB at milepost 142.7 from Union
Ramp NB entrance at 142.8; both show a conditional Class 1 $2.25. A similarly
named account entry does not establish which was used. Do not add both without
actual collection/overlap evidence.
[NJTA 2026 Parkway table](https://www.njta.gov/document/2026-parkway-nj-e-zpass-rates/)

MTA's standard daily passenger/small-commercial reference is $9 peak / $2.25
overnight, with once-daily context and eligible peak credits. Actual local-street
entries and excluded-road transitions must follow both pages of the official
connection map, not destination ZIP or NY state. Lincoln/Holland's Phase 1 peak
credit is explicitly $3 in the detailed schedule; GWB itself gives no tunnel
credit. Overnight gives no crossing credit.
[MTA overview](https://www.mta.info/fares-tolls/tolls/congestion-relief-zone/about),
[connection maps](https://www.mta.info/map/36226),
[detailed schedule](https://www.mta.info/document/138931)

**Published credit amounts resolved; actual eligibility remains unverified.**
The operator independently checked the detailed Phase 1 schedule. New calculator
version `pa-class1-mta-daily-credits-2026-v2` applies $3 for eligible peak Lincoln/
Holland entries and $1.50 for eligible peak Queens-Midtown/Carey entries or exits.
The $5 maximum daily credit is separate from the once-daily congestion charge.
Eligible later crossings can consume the remaining allowance, with no second
daily charge, provided actual path/direction, tag/plan eligibility and complete
same-vehicle/day charged and credited balances are established. One physical
tunnel traversal cannot be credited twice from multiple zone transitions.

Unknown history, a boolean already-paid flag and the old first-entry estimate
policy require manual review for new quotes. Overnight-first then a later peak
credit also remains manual pending settled/agency treatment. Future statements
or extended validity cannot establish unknown intervening trips. Existing v1
accepted prices keep their frozen arithmetic/reader; no accepted booking is
repriced or refunded by the new calculation.

MTA bridge/tunnel Class 31 rates for a non-NYCSC tag are also materially different
from NYCSC rates: the listed major crossings are $12.03 versus $7.46. The issuer
and assigned MTA class must be established for this vehicle; PA Class 1 is not
MTA Class 31 proof. Do not assume a 2Ax/business label settles MGW/body-class or
parkway-access questions.
[MTA vehicle rates and full schedule](https://www.mta.info/fares-tolls/tolls/vehicle-types)

Unknown roads/charges, agency class, incomplete ticket-road entry/exit, ambiguous
direction, expired evidence, uncertain peak/day boundary or unknown daily facts
remain manual-review cases. Google aggregate totals are comparison observations,
never added to the components or used to fabricate a residual.

## Acceptance sequence

1. Review public sources, licenses, rates and the gaps in the inventory. Obtain
   georeferenced infrastructure and independently check directed connectivity,
   toll classification, portals, exclusions, credit connectors and every extra
   facility. A successful route does not approve the whole dataset.
2. Supply the private, redacted vehicle/account evidence in the checklist.
   Establish actual dispatched-vehicle assignment and per-agency eligibility.
   Supply complete daily charged/credited balances and resolve eligibility and
   overnight-first settlement. An estimate policy cannot replace unknown history.
3. Authorize a small local/estimate-only Google acceptance run. Server-verify
   public endpoints and selected geometry. Start with Orange Hall, Orange
   Library, Newark Hall and Newark Penn to Midtown; then Holland/Lower Manhattan
   and GWB/Upper Manhattan. Include NJTA approaches only when actually used.
4. Test the same infrastructure with the remaining public origins/destinations,
   reverse journeys, independent round-trip legs, unknown roads, time boundaries
   and daily-credit cases. Replay timing/class negatives offline where possible.
   Brooklyn/JFK and other crossings remain review cases until their whole route
   is covered. Current engine scope still requires one unique Lincoln/Holland/
   GWB traversal per direction; other PA crossings remain unsupported.
5. Compare component-by-component with settled, same-vehicle/date/direction
   account rows and credits. A snapshot of earlier charges cannot prove future
   daily history. Unexplained differences fail acceptance.
6. In isolated fixtures and Stripe test mocks, verify quoted/displayed/stored/
   payment cents, FIRST15 ordering, Pay Now/Pay Later/retry/refund/legacy behavior,
   same-state waiver, hourly behavior and all EWR $150 identities. This package
   does not authorize production payment or reservation tests.
7. Review the still-draft PR, evidence, unsupported/manual cases and rollback
   plan. Merge, deployment and activation each need separate authorization.
   Keep charging disabled while evidence is incomplete. After any accepted toll
   snapshots exist, rollback must retain their reader and immutable prices.

Public source fetching and offline preparation made no paid Google request and
created no service or database. Original MTA PDFs could be read through the web
reader but not downloaded here; those references therefore have no byte hash.
They still require operator/source review. Published amounts were independently
confirmed; this does not verify an operator account, path or settled comparison.

Run the offline data checks with
`node scripts/validate-toll-acceptance.cjs` and the focused tests with
`node --test --test-concurrency=1 tests/toll-acceptance-data.test.cjs`.
The checks prove package integrity and fail-closed separation, not commercial
settlement accuracy or real-route acceptance.
