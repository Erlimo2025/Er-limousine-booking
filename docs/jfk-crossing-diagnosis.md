# JFK crossing diagnosis — November 5, 2026

## Confirmed evidence and limits

The operator reports two quote HTTP 422 responses at approximately 07:15–07:16
America/New_York with `crossing_missing_or_ambiguous`. The old detector uses that
same reason for both zero supported matches and multiple supported matches.
The operator confirms no match count, facility IDs or actual routing evidence
was captured. These logs cannot retrospectively establish the chosen crossing.
No customer route body, address, Google key or production data was collected.
There is no local Google key or recorded Google response for this investigation.
The server defaults to advance-estimate mode unless `ROUTE_TOLLS_MODE` is
`verified`. The strict engine also uses the old combined reason; the current
Render mode was not independently inspected during this investigation.

The advance-estimate reference contains only Lincoln, Holland and GWB. It has no
Goethals, Bayonne or Outerbridge reference, and is not certified complete road or
commercial-toll coverage. A JFK trip might use a crossing outside this catalog;
that possibility is not a determination about either failed production request.
The same zero-match outcome could reflect incomplete/misaligned reference or
provider geometry. Multiple matches could reflect a multi-crossing route or
ambiguous evidence. A zero match does not prove a particular unsupported bridge.

Existing provenance is in `services/data/toll-estimate-reference-2026.json` and
`docs/toll-acceptance/2026/`. The reference uses official
[NJOGIS centerlines](https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Tran_road/FeatureServer/0)
and [NYC OTI centerlines](https://data.cityofnewyork.us/City-Government/Centerline/inkn-q76z).
These source records do not independently verify a selected Google route.

## Small local diagnostic correction

Keep the original matching rules: samples within 45 m of each state's reference,
at least 150 m on each side, minimum 600 m traversal, east/west separation and
direction ordering. No reference coordinates, radius or thresholds change.

Extract the existing matching calculation into the pure internal
`crossingEvidence(geometry)` function. Detection now reports:

- `crossing_not_matched`: zero supported candidates; do not select a crossing.
- `crossing_ambiguous`: more than one candidate; do not choose the first one.

Both fixed reasons use the existing sanitized error-logging allowlist. The old
reason remains recognized for the separate strict verified-network engine and
legacy diagnostic compatibility. No new public endpoint, raw-route logging,
database column, route history, customer field or provider request is added.

This patch does not claim to fix production JFK booking availability. Synthetic
controls identify all three supported facilities in both directions. Synthetic
Queens/JFK destination and booking controls exercise Pay Now/Pay Later; they
are not actual Orange/Newark-to-JFK routes. Test joins remain explicitly synthetic.
Unknown congestion entry, reverse-route context, provider toll money and unsafe
geometry continue to require review even when a crossing is recognized.

## Smallest next production evidence

Confirm the active engine without changing its configuration. For one controlled
public-address quote, process the returned Google route in memory and retain only
the engine name, supported-match count, fixed facility IDs and detected directions.
In estimate mode these can be derived from `crossingEvidence(geometry(route))` without
retaining its points. Do not print the route, polylines, coordinates, addresses,
Place IDs, customer details or API key. No payment or reservation is needed.
Running a newly instrumented production build requires separate approval; no
production shell command or configuration change was performed in this work.

Zero candidates would still require an authorized in-memory inspection of that
controlled route against official geometry to distinguish an unsupported bridge
from incomplete provider/reference geometry. Two candidates must remain manual
review until the traversal can be disambiguated. Facility labels, a via request
or an airport destination alone cannot establish crossing or congestion entry.

Additional support needs source-backed facility geometry, applicable tariffs and
congestion/excluded-road evidence. Do not call unreviewed roads approved or infer
unknown charges as zero. No customer acceptance rule, tariff, timing validation,
vehicle certification, saved fare, FIRST15, Stripe code, same-state waiver, hourly
behavior or $150 qualifying EWR special is changed by this diagnostic patch.

## Subsequent approved Google backup work

The operator subsequently approved a selected-route Google toll backup. The
diagnostic findings above remain historical evidence, not an assertion about
the two original routes. The matcher and its two diagnostic categories remain
intact. A valid Google aggregate can now satisfy a new quote when custom
crossing/geometry/congestion evidence is unavailable, without asserting a custom
crossing match. See [Google backup policy](google-toll-backup.md) for validation,
round-trip overlap restrictions, persistence and current acceptance behavior.
