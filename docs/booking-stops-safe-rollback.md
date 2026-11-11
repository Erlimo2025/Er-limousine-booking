# Add a Stop rollback review

This compatibility build is based on `c272ddf32cd77c119387d17320badc942fa62354`. It reads the accepted version 1 stop snapshots written by PR #11 at `39fba97cf1ced80c17770ade58788b36b85de1ec`. Both builds use the existing reservation record and migrations. Keep the tested compatibility build available as the rollback target before accepting stopped bookings. The original `c272ddf` build omits their itineraries from customer and Dispatch views.

The compatibility build keeps normal bookings and stored-fare payment and refund flows available. It rejects new quotes and checkouts containing intermediate stops, including submissions from a stale tab. Accepted stop order, waiting minutes, rate, charge, fare and ER booking reference remain on the reservation. Book Again is unavailable for stopped trips. Stop changes require Dispatch review.

## Owner Render preflight

| Check | Record for release review |
| --- | --- |
| Production service and live build | Confirm the service for `erlimousineservice.com` and record its full Live Git SHA from Events. Verify the currently approved build separately from GitHub `main`. |
| Deployment settings | Record the production branch, Auto-Deploy setting, and status of service and Blueprint pull request previews. Confirm which Git events could trigger a deployment. |
| Effective stop waiting rate | Check `BOOKING_STOP_WAITING_RATES_CENTS_JSON` in the PR #11 build's runtime configuration. Unset or blank uses the approved 150 cents per billable minute for both vehicles. A populated override must match `{"suv":150,"escalade":150}`. Report whether it matches. The compatibility build uses the stored charge and rate for accepted trips. |
| Effective toll settings | Record whether `ROUTE_TOLLS_ENABLED` is true and the effective `ROUTE_TOLLS_MODE`. Check against the current approved production policy. |
| Automatic reservation controls | Confirm `RESERVATION_SELF_SERVICE_ENABLED` and `RESERVATION_AUTO_CANCELLATIONS_ENABLED` are effectively OFF. |

Account for linked environment groups and application-loaded configuration. Report only the SHA, settings above and whether the waiting-rate override matches. Keep credentials and unrelated values private.

After separate owner approval, identify the exact tested rollback commit and confirm it can be selected or deployed before releasing PR #11. If rollback is needed after accepting stopped bookings, deploy that compatibility build. Keep the database and refund/webhook processing in place. Check a previously accepted itinerary in authorized customer and Dispatch views and confirm pending payment and refund reconciliation remain healthy.

## Controlled Google verification

Run this separately after the owner authorizes billable requests. Use the approved PR #11 build in an isolated environment with a restricted test credential for Places API (New) and Routes API. Cap request usage before testing. Use fictional reservations at public landmarks and no production data. Stop at the quote screen for each successful route.

1. Use Places autocomplete and Place Details for a same-state case such as Orange Public Library → Newark Penn Station → Liberty State Park and an interstate case such as Orange Public Library → Newark Penn Station → Times Square. Check that the selected stop resolves to its intended public address. Try an invalid stop and confirm it cannot be quoted.
2. Verify the route legs follow the selected stop order. Reorder or remove a stop and verify that a new quote is required. Check that mileage and driving time describe the same selected route and exclude the planned dwell. Compare a 5-minute stop and a 15-minute stop to verify 0 and 10 billable minutes, respectively.
3. Check that the NJ/NJ route follows the existing same-state toll policy. On the NJ/NY route, verify the applicable custom or Google toll source and one toll addition. Include a peak/off-peak case if available within the approved request budget. Treat the Google amount as an advance estimate. Confirm the $150 Suburban special remains limited to eligible nonstop EWR–Manhattan quotes.
4. Record the synthetic scenario, ordered waypoint count, route-leg count, distance, driving minutes, wait cents, toll source/status and accepted quote total. For unavailable pricing or routing, verify the quote fails safely. Keep credentials and provider response bodies out of the report.

[Google Places Autocomplete](https://developers.google.com/maps/documentation/places/web-service/place-autocomplete) · [Google Routes intermediate waypoints](https://developers.google.com/maps/documentation/routes/intermed_waypoints) · [Google Routes toll estimates](https://developers.google.com/maps/documentation/routes/calculate_toll_fees)