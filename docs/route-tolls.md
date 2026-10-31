# Route toll estimates

Customer toll calculation is disabled by default. No Google, Render,
Stripe or database configuration is changed. ER confirmed a NJ E-ZPass business
account and Suburban class **2Ax**. Commercial-rate equivalence and congestion
coverage still need verification before customer toll charges are enabled.
Synthetic test attestations are not evidence of provider coverage.

## Business policy and activation

Confirmed rule: **add toll charges only when the verified pickup and destination
are in different US states**. Same-state trips have no added toll charge, even
if the selected road crosses another state or uses tolled roads, bridges or
tunnels. This is a company waiver, not a claim that the physical route is free.
Interstate eligibility does not imply a toll: the directional route estimate
still determines whether a charge is expected.

The existing EWR Airport → Manhattan qualifying Luxury SUV offer is **$150 total,
tolls included**. Its existing one-way/airport, EWR identity, Manhattan and SUV
restrictions remain authoritative. No surcharge, gratuity or coupon is added to
or subtracted from $150. An unknown internal toll cost stays unknown and never
blocks the special. If a toll-enabled provider call fails, the special retries the
existing distance/duration request without toll computations; a genuine routing
or eligibility failure still fails normally.

`ROUTE_TOLLS_ENABLED=true` opts new regular quotes into interstate-only toll pricing. Without
it, regular pricing and hourly booking remain unchanged. The offer's inclusive
wording and breakdown are independent of the flag. Never change this flag on
production as part of local testing.

`TOLL_VEHICLE_PROFILES_JSON` is a server-only object keyed by `suv` / `escalade`.
Each reviewed profile requires:

- `emissionType`: GASOLINE, DIESEL, HYBRID or ELECTRIC, matching the actual vehicle.
- `tollPasses`: the Suburban uses only `US_NJ_EZPASSNJ`, supplied from the confirmed
  account if omitted. An explicit different issuer or cash profile is rejected
  for the Suburban. Other vehicles require their actual configured pass list;
  do not infer that they share the Suburban classification or mounted tag.
- `vehicleClass`: the Suburban's confirmed classification is `2Ax`, recorded with
  its business-account type. This is not the NJ Turnpike's "Class 2" truck category
  and is not proof of commercial/passenger rate equivalence. The previous
  `two_axle_passenger_equivalent` configuration label remains compatible; other
  vehicles require that supported rate basis to be explicitly verified.
- `commercialRatesVerified: true` and `congestionCoverageVerified: true` only after
  the operator verifies coverage for the service's routes. These are deployment
  attestations, not a Google capability to calculate commercial or TLC rates.

Missing, malformed or unverified profiles on interstate trips produce the same
manual-review status as an unknown toll. Same-state waivers do not need a toll
profile because the customer is not charged tolls. Unsupported commercial classifications have no automatic
charge path. Other tag issuers require an allowlist review, not an invented enum.
Never place account numbers, transponder numbers or credentials in these profiles.
Only the confirmed Suburban issuer/account/class facts have defaults. Emissions,
other vehicle classes, commercial rates and congestion coverage are not assumed.
No toll price table is hardcoded. Google accepts emissions and issuer passes;
its request does not accept a business-account or `2Ax` class parameter.

Hourly services have no complete fixed route in the existing form. Per the
confirmed business rule, they retain their exact existing quote, discounts,
Pay Now and Pay Later behavior with the feature enabled or disabled. No state or
route lookup, new toll charge, or toll estimate is introduced. The absence of a
toll snapshot on these quotes means the toll cost was not estimated, not that
the journey is toll-free. No later toll is automatically added to or charged
against an accepted hourly booking.

## Provider calculation and limitations

New regular routed quotes resolve pickup and destination through the existing
server-side Google Places Text Search with a unique result, valid provider Place
ID/location, and one US country/state address-component pair. Customer-entered
state suffixes, JSON state fields and browser-supplied Place IDs cannot establish
jurisdiction. Compute Routes uses those same verified Place IDs so a second,
independent text geocode cannot change the route's endpoints. Existing EWR
terminal ID/geography proofs already establish New Jersey and are reused,
including the existing Terminal C fallback. The special retains its existing
EWR/Manhattan validation and is never blocked by the new state-lookup requirement.

Missing, ambiguous, conflicting, non-US or malformed location evidence requires
manual review; it is never treated as a same-state waiver. Round trips reuse the
verified endpoint pair in reverse and calculate each direction independently.
No additional GPS coordinates are persisted or logged.

Interstate Compute Routes requests retain distance/duration and request `extraComputations:
["TOLLS"]` plus `routes.travelAdvisory.tollInfo`. Emissions and actual passes are
sent through `routeModifiers`. Scheduled New York pickup time is used when toll
mode is enabled; round trips use their independent return pickup time. Only the
selected route-level aggregate is counted. For an eligible interstate booking,
this includes all reported tolls along the entire route, including roads within
either state, crossings, and applicable congestion tolls when covered by the
verified provider profile. It is never limited to the state-border crossing.
Leg prices are never added again and a separate congestion charge is not stacked
on a route total that already includes it.
Same-state quotes use only distance/duration requests and store an explicit
`waived` customer toll status; the unrequested physical toll cost stays unknown.

Google documents that these estimates apply to non-commercial vehicles and can
vary for commercial vehicles. It uses cash pricing without a relevant pass and
can ignore unsupported pass values. Toll coverage is limited: unsupported roads,
tag plans, local discounts, airport fees and congestion charging cannot be assumed
complete. See [Google toll calculations](https://developers.google.com/maps/documentation/routes/calculate_toll_fees)
and [route modifiers/pass enums](https://developers.google.com/maps/documentation/routes/reference/rest/v2/RouteModifiers).

Port Authority tolls are directional; its 2026 guide states no crossing toll is
collected entering New Jersey. That does not make the entire return journey free:
other roads can have tolls. NJ Turnpike Class 1 is a two-axle passenger category;
NJ E-ZPass's business application includes some SUVs/limousines in its automobile
category but registration weight and vehicle details matter. Verified endpoint
states determine company eligibility, and actual routes determine interstate
amounts; state boundaries are never used to invent an amount or limousine class.

- [Port Authority 2026 guide](https://www.panynj.gov/content/dam/bridges-tunnels/truckers-guides/Truckers%20Guide_Eng_Apr%202026.pdf)
- [NJTA current toll schedules](https://www.njta.gov/travel-resources/toll-calculator/toll-schedules-new-jersey-turnpike/)
- [NJ E-ZPass business application/classification](https://www.ezpassnj.com/en/about/b_ezapp.pdf)

MTA's TLC Per-Trip Charge Plan can replace the daily congestion toll for enrolled
vehicles. The agency lists $0.75 for eligible taxis/other FHVs and $1.50 for
high-volume FHVs, instead of the standard daily rate. These are published policy
examples, not ER charges. A generic passenger-route estimate cannot establish
enrollment, per-trip applicability, once-per-day history or all crossing credits.
Do not add a second congestion fee or assume an estimate covers the correct FHV
treatment. Keep incompatible/unverified cases in manual review. ER's actual
enrollment and commercial-versus-Google rate error are unknown; no defensible
percentage error can be promised. [MTA plan](https://www.mta.info/fares-tolls/tolls/congestion-relief-zone/taxi-fhv-tolls).

## Money, quotes and payment

Toll states distinguish a same-state company waiver, no toll expected on an
interstate route, estimated USD price, and unknown cost.
Missing route-level tollInfo means none expected according to the provider;
present tollInfo with no usable price is unknown. Malformed information, multiple
currencies, non-USD values, negative values and overflow never become zero. Money
units/nanos are parsed with integers and rounded half-up to cents. Google may
omit zero units/nanos. Provider coverage omissions remain a limitation, not proof
that an unsupported road is free. [TollInfo](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TollInfo).

The existing fare formula and rates are unchanged. Existing surcharges remain in
the fare before FIRST15 (still 15%) and existing gratuity calculations. Estimated
tolls are added afterwards, with no coupon discount or gratuity on the new tolls.
An existing nonzero toll allowance is credited once per applicable leg against
new toll charges; it remains in its original fare/discount base. No amount is
added twice. The new final addition, stored breakdown and total use integer cents.

Unknown interstate costs and unverified location states return HTTP 422,
`code: TOLL_ESTIMATE_UNAVAILABLE`,
`tollStatus: review_required`, `checkoutAllowed: false`, and
“Toll estimate unavailable — contact us for a final quote”. No reservation,
FIRST15 claim or Stripe session is created. There is no public amount-override
or manual-resolution endpoint; the customer must contact the operator for a
separately agreed final quote.

The UI echoes a server-generated price revision only as a change detector, never
as price authority. A changed displayed breakdown/total requires a new quote
before creating a reservation. New regular routed toll-enabled API bookings must
also echo this revision; omitting it fails closed. Hourly bookings retain the
existing request format because their fare has no new toll calculation.
Browser total/fee/discount fields
are ignored. The revision is not an authorization token or an amount override. An
accepted reservation and Checkout retry use its stored quote; Complete Payment
does no new route lookup or toll calculation. Existing expiry, Stripe idempotency,
webhook authority, refunds and cancellation controls remain intact. A legacy
reservation without toll fields keeps its original price and presentation.
If a booking-form retry has a different price revision from an accepted owned
reservation (or omits the revision in toll mode), it opens that reservation's
status page first. The customer sees the accepted stored amount before Complete
Payment; no replacement reservation or differently priced Checkout is created.

The quote's versioned `pricingBreakdown`, `tolls`, `totalCents` and price revision
fit the existing JSONB record. New fields are validated on storage reads/writes;
key ordering is canonicalized for PostgreSQL JSONB. No schema migration, data
rewrite or reprice is needed. Customer/status/email projections expose the
accepted breakdown; raw provider bodies, keys and vehicle-profile attestations
are not exposed. No additional customer GPS data is collected.

## API costs and local validation

As checked on 2026-10-28, Google's SKU detail places toll calculation in Compute
Routes **Enterprise**. Global list pricing is $15/1,000 requests in the first paid
tier with 1,000 free monthly requests; current traffic-aware requests otherwise
use Pro at $10/1,000 with 5,000 free. This is a tier change, not two SKUs charged
for the same request. Account contracts, taxes, other use and volume tiers may
change the bill. No live billing configuration has been inspected or changed.

State verification can add up to two billable Places Text Search calls per new
quote/calculation; their existing field-mask billing applies separately. Verified
EWR proofs can avoid a redundant location lookup. Same-state route calls do not
request the toll computation/Enterprise feature.

One-way quotes use one route call and round-trip quotes two. Checkout revalidates
new quotes, so a quote plus a new booking normally uses two or four calls.
Accepted reservation/payment retries do no new route work. Toll-feature failures
on the inclusive special may cause a fallback route call. Budget for repeated
Get Quote actions and compare the Enterprise free cap with existing Pro usage.
Routes API and billing must already be enabled for the existing server key; no
new frontend key or separate toll API is needed.

- [SKU triggers](https://developers.google.com/maps/billing-and-pricing/sku-details#routes-compute-routes-enterprise)
- [Global list pricing](https://developers.google.com/maps/billing-and-pricing/pricing)
- [Usage/billing](https://developers.google.com/maps/documentation/routes/usage-and-billing)

Run `node --test --test-concurrency=1 tests/tolls.test.cjs` for synthetic Google,
Stripe and vehicle-profile cases. The full supported suite is `npm test` and is
sequential. PostgreSQL tests require an explicitly isolated local
`ER_TEST_DATABASE_URL`; never use production `DATABASE_URL` as a fallback.
Sample amounts in tests/reports are fixtures, not current agency rate promises.

For rollback before release, keep the flag disabled. If rolled back after new
reservations exist, retain toll-aware storage validation/projections and accepted
snapshots: disable new toll calculation only. Never remove accepted toll fields,
reprice a reservation or alter a live Checkout's frozen amount.

The immutable toll snapshot also records the verified endpoint states/Place IDs
and `interstate_only` policy. The public breakdown uses “Estimated Interstate
Tolls” and “Total Including Tolls” for regular interstate trips, and “No added
tolls — same-state trip” with “Total” for waived trips. Historical snapshots
without the new policy remain valid at their accepted amounts, including older
accepted same-state fares. The new rule does not trigger repricing or refunds.

## Admin Toll Validation — Estimate Only

This independent tool is available only when `ADMIN_TOLL_VALIDATION_ENABLED` is
exactly `true` and the operator has a valid existing admin session. Its default
is false. `ROUTE_TOLLS_ENABLED` stays false; enabling validation never enables
customer toll calculation. Neither commercial nor congestion verification flags
are changed. No production configuration is changed by this implementation.

The small Admin Dispatch panel uses an authenticated configuration read and
`POST /api/admin/toll-validation/estimate`. The POST additionally requires the
canonical Origin, JSON and no query parameters. Inputs have an exact allowlist:
request UUID, two US addresses, optional via point, future New York departure,
optional later return departure, fixed Suburban identity and actual fuel type.
Browser-supplied prices, pass lists, TLC status, verification flags, credentials,
reservation IDs and arbitrary provider URLs are rejected.

The metadata is the confirmed 2025 Chevrolet Suburban, NJ E-ZPass Business,
2Ax, NJ OL, **not TLC licensed**. Gasoline/diesel must be selected explicitly.
Only supported emissions and `US_NJ_EZPASSNJ` are sent as Google modifiers.
Business/plate/class facts are not assertions that Google calculates the actual
commercial rate. The tool never assumes the TLC Per-Trip Charge Plan.

Each distinct address is resolved once using the existing strict server Places
lookup. Both directions reuse the verified Place IDs and any via point, but get
separate Routes requests and departure times. No autocomplete requests are made
while typing. A via point is only a routing constraint: the panel displays the
Google-returned route summary and instructions, and keeps the requested crossing
explicitly **not independently verified**. It never infers a tunnel from address
text or claims individual toll components were verified. Directions without
instruction evidence are labeled accordingly. Google Maps attribution is shown
beside the provider content without loading a new map SDK.

The original route-level USD amount is parsed with the existing integer-cent
parser and displayed without manual additions or deductions. Route/leg totals
are not summed together. An explicit valid zero is displayed as Google's zero
estimate; an omitted advisory is "not reported", not a verified $0. An indicated
toll with invalid, missing, non-USD or ambiguous prices remains unknown. All
commercial, CRZ coverage, first-entry/calendar-day, delayed-credit and Mid-Tier
limitations remain visible. Same-state operating costs may be investigated,
while their customer toll additions remain waived. This service does not invoke
customer quote, booking, Stripe, refund or reservation-storage functions. The
eligible EWR special remains $150 inclusive, independent of validation results.

Manual debit/credit entries stay in page memory, separately for each direction.
Settled subtotal = settled debits minus settled credits; difference = that
subtotal minus the unchanged original Google total. Pending entries are excluded
and flagged; invalid decimals prevent a numerical difference. Unknown Google
amounts have no variance. Actual route/date/time, daily-entry context and credit
reconciliation are recorded as manual observations, never billing authority.
Negative net totals, a mismatched date/time and still-future departures retain
review messages. No amount is automatically appended to a fare or charged later.

The panel has no database, file, browser-storage or background-history writes.
It clears route/comparison fields on logout and page exit; route edits invalidate
old responses. A copyable text summary lets the operator manually record a
chosen estimate if needed later. Leaving the page loses the comparison. No
account, tag, plate number or payment credentials are requested; only the generic
NJ OL plate category is metadata. No GPS tracking or coordinate history is added.
The endpoint logs only existing generic error metadata, never input bodies,
provider payloads, addresses or API keys.

Retries with the same UUID/input/admin session reuse a result (or safe failure)
for two minutes in a bounded, transient memory cache; changed input under that
UUID is rejected. Logout clears completed results, expired results are pruned,
and no result is shared between admin sessions. One request at a time is allowed
per admin and client IP, with two active estimates total. Existing process-local
controls enforce five requests/minute per IP and twenty/hour per IP, admin and
process. These limits and retry memory reset on restart and are not distributed
across workers. They are not a guaranteed Cloud billing cap. A provider request
already running can finish after a browser abort; it is not automatically retried.
Authorization is rechecked between provider calls and before returning results.

### Validation API costs (global list pricing checked 2026-10-30)

Toll calculation uses Compute Routes Enterprise: $15/1,000 successful requests at
the first paid tier, with 1,000 free monthly events. The existing Places lookup's
field mask uses Text Search Pro: $32/1,000, with 5,000 free monthly events. The
caps are shared with the billing account's existing usage for each SKU; contract,
volume, tax and subscription terms can change actual costs. A Routes request is
charged once at its applicable SKU, not Pro plus Enterprise.

| Requested analysis | Places calls | Routes calls | If every call is billable |
| --- | ---: | ---: | ---: |
| One direction | 2 | 1 | $0.079 |
| Both directions | 2 | 2 | $0.094 |
| One direction plus distinct via point | 3 | 1 | $0.111 |
| Both directions plus distinct via point | 3 | 2 | $0.126 |

Configuration reads, manual comparisons, cached retries and text route displays
make no extra Google requests. There is no new Render service, map-load SKU or
database migration. Existing Routes/Places API access and billing are used;
Google permission failures remain generic errors and never trigger configuration
changes. New estimates require an explicit action; the tool does not auto-refresh.
Historical driving departure times cannot be queried, so a future request is not
presented as a recreation of an old trip.

- [Google SKU triggers](https://developers.google.com/maps/billing-and-pricing/sku-details)
- [Google global pricing](https://developers.google.com/maps/billing-and-pricing/pricing)
- [Routes limitations](https://developers.google.com/maps/documentation/routes/calculate_toll_fees)
- [Routes attribution](https://developers.google.com/maps/documentation/routes/policies)

Tests use synthetic Google/Stripe responses and the existing isolated local
`ER_TEST_DATABASE_URL`. Live Google estimates, settled transaction matching and
commercial/congestion accuracy are not established by those tests. Commit,
deployment and any admin-feature activation require the operator's separate
approval; automatic customer toll charging remains disabled.
