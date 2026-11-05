# Toll timing diagnosis — local correction, November 5, 2026

The operator reports three November 4 production quote failures with HTTP 422
and `tollReason: timing_inconsistent`. The public booking script matches
`905255b`. Direct Render log/UI access is unavailable in this session. The
reported reason identifies the combined timing guard, but cannot retrospectively
distinguish its individual conditions. No customer response bodies or locations
were collected. Per-request timing totals remain unconfirmed.

## Proven handling defects

Google describes traffic-aware `duration` as the current/predicted traffic ETA
and `staticDuration` as the historical baseline. It does not promise the first
is larger. Rejecting a shorter traffic ETA is therefore an unsupported ordering
assumption. See [Google traffic preferences](https://developers.google.com/maps/documentation/routes/config_trade_offs).

The old guard also allowed only one second between the route static duration
and the sum of independently reported step durations. Quantization can accumulate
across steps. Synthetic responses reproduce both rejection branches separately;
these examples are not captures of the production Orange route.

## Bounded correction

- Retain required finite, positive route durations and finite nonnegative step
  durations. Missing step timing is not interpreted as zero.
- Retain the six-hour bound and strict geometry, crossing and USD-money checks.
- Bound cumulative rounding/truncation by one reported unit of precision per
  step and route value, retaining the pre-existing one-second minimum. This
  bounded compatibility rule does not assume Google's internal rounding method.
  Gross differences or discrepancies beyond that budget still require review.
- If traffic is faster or an accepted rounding discrepancy exceeds one second,
  use the whole interval from departure to the largest reported route/step ETA
  as the crossing/entry window. Do not scale individual steps or invent exact
  crossing timestamps. Do not add a second traffic allowance to that interval.
- The existing advance estimator selects the upper applicable published tariff
  within the window. Calendar-day uncertainty remains manual review. A widened
  window crossing MTA periods also requires review, so a peak fee is never paired
  with an uncertain crossing credit. The stricter
  verified engine still rejects a window spanning different tariffs.

This can conservatively select a higher published tariff near a peak boundary.
It does not change any tariff, fare formula, toll allowance, discount, or Google
aggregate-versus-component rule. Normally consistent timings retain their prior
step windows. Accepted snapshots and payment amounts remain immutable.

Unrecoverable timing now has distinct allowlisted diagnostic reasons:
`timing_static_invalid`, `timing_travel_invalid`, `timing_route_limit`, and
`timing_step_sum_mismatch`. Missing/invalid step timing remains `timing_missing`.
Only these fixed categories are logged, with no raw timing payload or customer
information. These diagnostics require an approved later deployment; this local
change does not alter production settings or expose additional API data.

The $150 qualifying EWR special, same-state waiver, hourly behavior, stored
reservations and Stripe flows are unchanged. Unknown toll money, provider
failures, uncertain crossings, unsupported tariff dates and congestion overlap
still block new bookings. Production confirmation remains necessary before
claiming which branch caused the three reported failures or that the live route
has recovered. No classification or commercial toll coverage is newly verified.
