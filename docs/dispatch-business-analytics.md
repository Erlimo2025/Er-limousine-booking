# Dispatch Business Analytics

Open **Business Analytics** in authenticated ER Dispatch. The date picker and quick filters use New York calendar dates and include the entire end date. Weeks run Monday through Sunday. This Week, This Month and This Year include the rest of the calendar period so upcoming rides appear. Reset returns to This Month and clears the trip report filters.

## Calculation dates

| Metric | Date basis and calculation |
| --- | --- |
| Total bookings received | Reservation creation date. Quotes without a saved reservation are excluded. |
| Gross accepted booking value | Stored accepted fares of bookings received in the period, including unpaid and cancelled bookings. |
| Completed rides | Scheduled pickup date of reservations currently marked Completed. Passing pickup time alone has no effect. |
| Cancelled rides | Scheduled pickup date of reservations currently marked Cancelled. |
| Upcoming rides | Scheduled pickup date of future Confirmed, Assigned or Driver En Route reservations. |
| Pending reservations | Scheduled pickup date of reservations currently Awaiting Payment. |
| Pending, approved and declined customer requests | Date the change or cancellation request was submitted, grouped by its current decision status. Requests are separate from bookings. |
| Gross completed-trip value | Accepted fare of Completed rides scheduled in the period. The monthly chart uses this same basis. |
| Actual payments collected | Verified USD amounts from the local payment ledger, grouped by the date payment was recorded after Stripe confirmation. |
| Completed refunds | Confirmed USD refund amounts by the date the application confirmed the Stripe refund. The same Stripe refund ID counts once across refund tables. Attempts last confirmed as pending or failed are excluded. A submitted refund with an unknown outcome or reported success awaiting local confirmation makes the affected period's refund and net totals Unavailable. |
| Net collected payments | Actual payments collected minus completed refunds for the same period. A later refund can make this number negative in a period with little or no capture activity. |
| Unpaid collectible balances | Lifetime verified captures deducted from the accepted fare of noncancelled reservations scheduled in the period. A refund never creates a new balance due. |
| Average completed-trip fare | Gross completed-trip value divided by the number of Completed rides, rounded to the nearest cent. |
| Cancellation rate | Cancelled reservations divided by all reservations scheduled for pickup in the period. |

Status, balance and request metrics use the records as they exist when the report is run. A later Dispatch update can change a historical pickup or request cohort. A round trip is one reservation, grouped by its outbound pickup. Archived reservations still count.

The comparison label shows the preceding dates and the basis used. **Equivalent calendar periods** use the same number of full calendar months for whole-month selections, including full years across leap years. **Equal calendar-day lengths** use the same number of preceding New York calendar days for other selections, including ranges that cross a daylight-saving change.

Growth uses the difference between the two period totals divided by the prior total, rounded to the nearest 0.01 percentage point. A positive total after a zero baseline displays **No prior activity**. Equal totals display **No change**. Very small changes that round to zero retain their direction. Missing values display **Unavailable**.

Activity charts are daily for up to 31 days, weekly for 32–120 days, and monthly for longer ranges. The completed-fare chart always uses months. Ranges longer than ten years omit months with no recorded activity in the charts. Summary and export continue to cover the whole selection.

## Financial evidence and limitations

- Accepted fares come from stored reservation snapshots. The report never reprices a trip.
- The capture ledger has one row per reservation. A capture needs a matching Stripe Checkout session, an explicit payment timestamp matching the ledger, USD, and a reservation created through the application with a stored schedule. Legacy imports can populate the ledger with a booking-time fallback. Those rows are excluded from verified cash and the affected totals are Unavailable. When an unverified payment has no recorded payment date, it can affect periods between booking and the current day.
- Confirmed refunds use provider-verified evidence in the legacy refund and managed cancellation tables. Conflicting provider IDs and unresolved evidence are reported as Unavailable. A managed cancellation can record the amount already refunded without individual refund dates. The known prior amount can be reflected in that trip's lifetime refunded amount when it can be combined safely. A period that could contain the undated refund shows Unavailable for refunds and net collected.
- A trip report row shows the lifetime capture and refund amounts for that reservation. The summary cash figures show only in-period capture and refund activity. The amounts can differ for a range when payment, pickup and refund occur on different dates.
- The current payment ledger does not track multiple independent captures for one reservation. Analytics can report a recorded amount below the accepted fare as a partial payment. Separate Stripe-only captures, refunds, chargebacks, payouts and processing fees require reconciliation against Stripe when their evidence is absent locally. No profit, expense or bank settlement figures are inferred.
- An empty capture or refund period with no known gaps displays zero. An unavailable value reflects a known gap. Empty averages and cancellation rates are also Unavailable.

## Access and exports

Analytics uses the existing authenticated Dispatch session. The report and CSV use the applied date range and the same trip search, filters and sort. Pagination affects only the screen. The export includes all matching rows and escapes spreadsheet formula text. Pickup and destination are sensitive operational data. Keep downloaded CSVs private.

Analytics uses read-only PostgreSQL transactions on the existing schema. It has no Stripe calls, new credentials or database migration.
