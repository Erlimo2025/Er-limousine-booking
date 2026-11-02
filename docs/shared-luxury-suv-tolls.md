# Shared Luxury SUV customer toll estimate

The operator approved one advance-estimate pricing category for Chevrolet
Suburban, Cadillac Escalade and future configured Luxury SUV members. This is a
customer rate model. It is not evidence of an individual vehicle's actual
E-ZPass class, readable tag, commercial billing rate or congestion-plan enrollment.
The business absorbs differences from settled tolls; no later supplement is
charged to the customer.

## Server configuration

Both existing entries in `pricing.vehicleRates` have:

```js
tollPricingCategory: 'luxury_suv'
```

Their base, mileage, time, minimum, hourly, capacity and luggage values are
unchanged. A single `pricing.tollPricingCategories.luxury_suv` definition supplies
the operator-approved model: NJ E-ZPass, the published 2026 PA Class 1 tariff
basis, standard daily Manhattan congestion pricing and an eligible peak crossing
credit assumption. GASOLINE is the shared Google pricing-model input, not a
statement of each member's physical fuel type. The optional `none` credit
assumption models no eligible credit for every member equally.

No toll dollar amount is configured here. The existing route geometry,
direction, crossing-time window, PA/MTA schedules, route-level Google estimate,
congestion overlap safeguards and fare allowance determine the estimate. The
same selected route and provider data use identical modifiers and arithmetic
for every member. Provider estimates may refresh over time for all vehicles;
this is not a permanent fixed toll or a promise of exact settlement.

The shared category takes precedence over per-vehicle estimate inputs in
`TOLL_VEHICLE_PROFILES_JSON`. Missing or malformed category configuration does
not borrow a vehicle's private profile: approved interstate routes use Tolls
Included. Unknown geometry/prices, unsupported tariff dates and other existing
estimate failures retain that fallback. Outside approved NJ/NYC coverage still
requires manual review. Same-state added tolls remain zero. Hourly behavior stays
unchanged. The qualifying $150 EWR special remains Suburban-only and all-inclusive.

Both feature flags remain disabled by default. This PR changes no Render setting,
credential or environment value and does not activate customer charging. The
admin estimate-only service stays separate and unchanged.

## Future vehicles

When a future vehicle is approved and added through the normal booking fleet
onboarding, assign `tollPricingCategory: 'luxury_suv'` in its server rate entry.
No new toll algorithm, copied per-vehicle estimate profile or eligibility
certificate is needed. Category resolution is generic and tested with future
vehicle keys. Existing booking/storage/UI vehicle allowlists are deliberately
preserved; this change does not expose arbitrary new vehicle IDs to customers.

## Evidence, snapshots and compatibility

Normalized category profiles always carry `verified: false`,
`commercialRatesVerified: false`, `congestionCoverageVerified: false` and
`actualVehicleEligibilityVerified: false`. They have no official fleet proof.
The stricter `ROUTE_TOLLS_MODE=verified` still requires its existing separate
vehicle/account/road evidence and cannot use this shared estimate as proof.

The saved quote records a small server-owned category/model snapshot, explicitly
labelled `operator_approved_customer_estimate`. It contains no plate, tag,
account identifier or GPS history. The snapshot is bound into quoteRevision;
category changes require a new review before a new reservation. Customer quote
responses continue to expose only the existing safe totals/status, while the
internal model remains available for audit. No database migration is needed.

Previously accepted per-vehicle and legacy quotes remain valid and payable at
their saved amounts. Completing or retrying payment never needs current category
configuration or recalculates tolls. If charging is separately activated later,
retain this snapshot reader in any rollback after new category quotes have been
accepted; do not strip or reprice stored snapshots. Disabling charging affects
new quotes, not legitimate completion of existing reservations.

## Validation

`tests/shared-suv-tolls.test.cjs` compares both SUVs across weekday/weekend/peak/
overnight and directional trips, route-dependent provider totals, round trips,
same-state waivers, hourly fares, FIRST15, unknown/missing estimates, invalid
configuration and forged JSON. It checks both payment choices, snapshot integrity,
legacy payment compatibility and isolated PostgreSQL restart behavior.

`tests/browser/shared-suv-tolls.cjs` compares actual Step 3 rows and both reserve
flows for the two SUVs on identical routes at 320, 390 and 1440px. Existing
three-step and Complete Payment browser suites also remain part of validation.
Run suites sequentially on Windows using the documented installed Playwright
module and local Chromium/Edge executable. All provider responses, vehicle inputs
and geolocation in tests are synthetic; no real E-ZPass or vehicle eligibility is
certified and no live Stripe or production database is used.
