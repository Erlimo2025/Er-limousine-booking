# Reusable toll-route coverage — implementation review

The original draft review identified exact route hashes and endpoint Place-ID
manifests as unsuitable for general address-based bookings. The replacement is
now **implemented in working code** on `codex/official-toll-tariffs`. It is not
activated or independently production-verified. See the [implementation guide](official-toll-tariffs.md)
for the exact schema, supported scope and release requirements.

## What changed

`services/toll-road-network.js` matches the complete server-fetched path to
reusable public road links and their facilities. Different address pairs,
provider sampling and known free-road detours can share the same infrastructure.
The quote still binds verified endpoint states/IDs, but neither customer address
is preapproved in the network dataset.

Exact convex-cell clipping, direction, graph connectivity and progress checks
replace whole-route approval. Missing or ambiguous links, unsupported roads,
incomplete ticket-road entry/exit, stale evidence and unsupported tariffs return
manual review before a new reservation or Checkout session.

The PA calculator retains its published 2026 schedule. An additional facility
table engine handles separately evidenced NJTA/MTA class/pass/entry-exit/time
rates. No real NJTA/MTA commercial tariff table or certified road network is
invented or included. Google aggregates are never added to component costs.

Congestion entries and credit connectors are tied to the actual matched path.
Queens Midtown/Hugh L. Carey can supply their own eligible credit, independently
of the PA crossing name. Daily context belongs to the actual vehicle/day; future
or stale history and browser claims cannot establish it. The disclosed first-entry
estimate policy still needs separate operator acceptance.

## Synthetic validation coverage

Tests exercise many NJ pickup/NYC destination combinations, point resampling,
known detours, gaps between covered vertices, ambiguous parallel links,
disconnected topology, directionality, entry/exit completeness, weekday/weekend
and rush-hour rates, NJTA reverse differences, NYC tunnel credit sources,
unknown/invalid money or class evidence, expiry and bounded file loading.

HTTP tests verify server cents, FIRST15 order, both reservation/payment choices,
stored totals, repeated payment sessions, legacy v1 and new network snapshots,
unknown-road denial and receipt/refund/ownership regressions. These tests do not
claim a real vehicle class, agency account, road survey or settled bill was verified.

## Real-route acceptance preparation

The [2026 acceptance package](toll-acceptance/2026/README.md) contains actual
public NJOGIS candidate geometry, official PA/NJTA/MTA rate/map references,
explicit coverage gaps, a 45-case planned matrix and the exact private account
evidence checklist. None of its geometry, vehicle facts or real-route outcomes
is approved. It is deliberately not a runtime-loadable catalog. The detailed
MTA NYC tunnel credit terms and later daily-credit settlement are unresolved
acceptance blockers. No algorithm, fare or production configuration is changed
by preparing those artifacts.

## Production evidence still required

* A sourced/licensed and independently reviewed public road/facility network,
  correct PA portals, excluded-road/local-street transitions and credit connectors.
* Complete actual additional-road tariffs, authority class mapping and NJ-issued
  tag eligibility. Unknown roads remain review cases.
* Physical Class 1, readable tag, standard daily/non-TLC plan and actual dispatched
  vehicle/assignment evidence. NJ Business/OL/2Ax labels are insufficient.
* A trustworthy daily/credit context or separately accepted estimate policy,
  plus calibrated timing bounds and matching settled transaction comparisons.
* Controlled non-production booking/reservation/Stripe test-mode acceptance before
  separate production approval.

Current scope supports one unique Lincoln/Holland/GWB traversal per direction.
Other PA crossings, unexplained repeated facilities and paths outside verified
network coverage remain manual review. Engine support for a facility is not a
claim that production evidence for it exists.

Same-state added tolls remain waived; regular interstate routes account for all
covered segments. Hourly behavior is unchanged. Eligible EWR → Manhattan SUV
remains exactly **$150 including tolls**. Existing accepted reservations, payments,
refunds, cancellation and ownership rules remain intact.

Both flags remain disabled by default. No merge, deployment, migration, Render
setting change, live provider request or production data access is part of this work.
