# 2026 toll network acceptance package

Prepared November 1, 2026 against engine commit
`320a2e9800243f9c1d161fa48908c017692648d6` on
`codex/official-toll-tariffs`, for draft PR #1.

**Ready for source review and acceptance planning; not ready for activation.**
This package adds public research data and offline checks. It does not replace
or change the route matcher, tariffs, customer UI, reservations, Stripe, flags,
database or Render configuration. No real Google route or private E-ZPass account
was queried. No real route acceptance case has passed yet.

`ROUTE_TOLLS_ENABLED=false` and `ADMIN_TOLL_VALIDATION_ENABLED=false` remain the
repository defaults. No production setting was read or changed in this task.
The eligible EWR to Manhattan SUV special remains **$150 total, tolls included**.
Same-state added tolls remain waived and hourly behavior is unchanged.

## Reviewable artifacts

| Artifact | Contents and limits |
| --- | --- |
| [sources.json](sources.json) | Agency URLs, source scope, retrieval limits and available PDF hashes. |
| [candidate-nj-roads.geojson](candidate-nj-roads.geojson) | 3,722 actual public NJOGIS road features, with original coordinates and source IDs; all candidate/unreviewed, toll status unknown. |
| [geometry-provenance.json](geometry-provenance.json) | Exact bounded query, fields, four response-page hashes/counts, retrieval times, attribution and transformations. |
| [network-inventory.json](network-inventory.json) | Feature references, facility/approach inventory, missing portals/corridors, CRZ/exclusions and credit connectors. **Zero approved links/facilities.** |
| [published-tariff-reference.json](published-tariff-reference.json) | Conditional PA/MTA rates and selected NJTA entry/exit cells; unresolved amounts remain null. No runtime tariff table is configured. |
| [route-testing-matrix.csv](route-testing-matrix.csv) / [JSON](route-testing-matrix.json) | 45 planned cases, 17 public locations and 15 time/replay profiles; all real-route results are empty. |
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

**Acceptance blocker: NYC tunnel credits need clarification.** The detailed
schedule lists $1.50 for Phase 1 Queens-Midtown/Carey credits and describes
per-trip/daily-credit terms, while the overview groups the four entries under
an up-to-$3 description. The current `calculateCongestion()` allows up to $3
for those NYC tunnels and skips further charge/credit once already charged.
Do not certify those cases from the overview. Obtain MTA's current explanation
of each tunnel's credit, exit-only/later credits and overnight-then-peak entries;
compare settled statements and separately review any necessary correction.
No engine change is made by this acceptance package.

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
   Resolve daily context and credits, or separately approve a clearly disclosed
   estimate policy. No such policy is approved by preparing this package.
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
They still require operator/source review, including the credit discrepancy.

Run the offline data checks with
`node scripts/validate-toll-acceptance.cjs` and the focused tests with
`node --test --test-concurrency=1 tests/toll-acceptance-data.test.cjs`.
The checks prove package integrity and fail-closed separation, not commercial
settlement accuracy or real-route acceptance.
