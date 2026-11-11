# Intermediate stops

Step 1 supports up to three ordered intermediate stops on one-way and single-direction airport bookings in the existing New Jersey and NYC service area. Round trips and hourly bookings retain their existing pricing and booking flows. The stop editor requires an autocomplete selection. The server resolves each selected Place ID, validates a specific routable place and uses the returned address. It rejects a repeated place ID, normalized address or point within 15 meters of a previously selected stop or trip endpoint. Adjacent stops that cannot be distinguished safely can be arranged through Dispatch.

Google Routes receives one ordered list of stopovers, without waypoint optimization. A stopped quote requires one driving leg for every pair of consecutive waypoints and valid selected-route metrics. The server uses the route's total driving distance and driving duration. Waiting is calculated separately. Each quote or checkout revalidation can make up to two endpoint lookups, three Place Details lookups and one Routes request. Verified endpoints are shared with toll eligibility. [Google Routes intermediate waypoint documentation](https://developers.google.com/maps/documentation/routes/intermed_waypoints)

## Waiting and fare

The customer selects 5, 10, 15, 20 or 30 minutes per stop. Each stop includes its own first five minutes. The server adds the billable minutes from each stop and multiplies by the applicable whole-cent rate.

| Scheduled stops | Planned minutes | Free minutes | Billable minutes | Waiting charge for either vehicle |
| --- | ---: | ---: | ---: | ---: |
| 5 minutes | 5 | 5 | 0 | $0.00 |
| 10 minutes | 10 | 5 | 5 | $7.50 |
| 15 minutes | 15 | 5 | 10 | $15.00 |
| 20 minutes | 20 | 5 | 15 | $22.50 |
| 30 minutes | 30 | 5 | 25 | $37.50 |
| 10 and 15 minutes | 25 | 10 | 15 | $22.50 |
| Three 30-minute stops | 90 | 15 | 75 | $112.50 |

The approved rate for both the Chevrolet Suburban (`suv`) and Cadillac Escalade ESV (`escalade`) is 150 US cents per billable minute. The optional server-only setting uses the following exact JSON.

```dotenv
BOOKING_STOP_WAITING_RATES_CENTS_JSON={"suv":150,"escalade":150}
```

An unset or blank setting uses those approved defaults. An explicit malformed setting, or an explicit map that omits the selected vehicle or gives it an invalid rate, blocks billable waiting for that vehicle. Five-minute stops remain available. Set a different positive whole-cent override only after the owner approves that rate. The waiting setting applies to scheduled stop waits. The driving-minute and hourly rates are separate.

Discounts, existing surcharges and any existing gratuity calculation apply to the normal driving fare as before. Scheduled billable waiting is then added once in integer cents. The $150 EWR-to-Manhattan Suburban offer remains the nonstop price. Selecting a stop gives the customer a regular fare quote and explains the offer exclusion. Regular FIRST15 eligibility still applies to the driving fare.

The existing pickup/destination-state rule controls toll eligibility, including a same-state waiver when an intermediate stop crosses a state line. For eligible tolls, the existing calculator or Google backup uses the complete selected route. The primary estimator accounts for planned waits when assessing downstream crossing times. Google provides one aggregate estimate for its driving route and does not accept scheduled dwell durations. Its backup estimate may therefore differ when a wait shifts a toll crossing into another time window. Neither estimate is added to the other. Unverifiable route or toll evidence retains the existing review requirement.

Waiting durations are estimates. An actual overrun cannot alter a saved fare or charge a saved card through this feature. It needs a separately authorized Dispatch adjustment and customer payment authorization.

## Accepted snapshot and rollback

The existing reservation JSON stores a versioned stop plan in the accepted quote. It contains verified route Place IDs and addresses, the original departure time, ordered waiting durations and the applied rate and charge. For stopped trips, the checkout revision binds the plan to the selected route metrics and fare. The preceding build rejects that stopped-trip revision instead of accepting a direct-route quote from a stale tab. Checkout recalculates the server quote before accepting a new booking. A change to the itinerary or amount requires a new quote, and an unaccepted quote becomes unusable when the scheduled pickup time arrives. An accepted reservation keeps its original amount for payment and retries, even if the waiting-rate configuration changes. Customer and Dispatch views show the same saved stops. Book Again copies the itinerary and requests a fresh quote.

The existing fare breakdown carries a billable stop wait as an additional surcharge. Its established arithmetic and toll revision are preserved for compatibility with the preceding application. There is no schema migration or backfill.

- Before any stopped reservations are accepted, a rollback can use the preceding build. Customers with an open stopped quote need to refresh and request a new quote.
- Once stopped reservations exist, use a rollback build that rejects new stopped quotes and submissions and retains stop display for accepted reservations, email confirmations and Dispatch. Keep the saved reservation JSON and Stripe records in place.
- In the isolated rollback rehearsal, the preceding build paid a stopped Pay Later reservation at its exact accepted total, with toll pricing both enabled and disabled. It rejected an in-flight stopped quote in both cases. The preceding build omits itinerary fields from its customer and Dispatch screens.

Requested stop changes use the existing secure reservation request queue. A customer can request a new itinerary, different waits, or removal of all stops. Dispatch decisions record approval or rejection. Confirming a request does not alter the accepted stop plan, reprice the reservation, or move funds.