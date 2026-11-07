# Reservation self-service release and rollback

Manage My Reservation uses existing account sessions and verified guest access. Viewing, payment status, ordinary Dispatch requests and authorized Complete Payment stay available regardless of the new controls. Existing My Trips keeps its pickup-time editing and eligible full-refund path at least 24 hours before pickup. Started trips require owner review there as well.

| Server setting | Default | Enables |
| --- | --- | --- |
| `RESERVATION_SELF_SERVICE_ENABLED` | Off | Server-priced change previews and cancellation previews with owner-review requests |
| `RESERVATION_AUTO_CANCELLATIONS_ENABLED` | Off | Confirmed, no-fee automatic cancellations at least 24 hours before pickup under the accepted simple policy |

Only the literal value `true` enables either control. Booking consent, processing of previously committed refund obligations, the Dispatch recovery list, provider rechecks and signed Stripe webhooks operate independently. Turning off new actions must not orphan existing obligations.

## Accepted cancellation terms

New Pay Now and Pay Later reservations, including guest reservations, require an unchecked-by-default acceptance in Step 3. The quote provides the current text and version, `ER-CANCELLATION-24H-2026-1`. Checkout requires explicit acceptance of that exact version and stores the server-generated timestamp and complete policy snapshot on the reservation. Booking confirmation, customer booking emails and My Trips show the accepted terms. Migration 015 prevents changing that evidence. Owned retries and Complete Payment continue using the accepted reservation.

| Time/status | Customer action | Reservation and refund |
| --- | --- | --- |
| At least 24 elapsed hours before pickup, service not started | Review the expected refund and explicitly confirm cancellation | Cancel without a fee. For eligible paid reservations, refund all verified remaining refundable payment. Unpaid reservations cancel without a refund. |
| Less than 24 elapsed hours before pickup | Confirm Request Cancellation | Reservation remains active pending owner review. Approval cancels; decline leaves it active. Any refund requires a separate owner decision. No automatic fee. |
| Started or completed service | Request authorized owner review | No automatic cancellation or refund. An authorized owner decision is required. |
| Missing or earlier policy acceptance, uncertain payment or refund evidence | Request Dispatch review | Do not impose new terms, cancel automatically or guess a refund. |

Exactly 24 hours qualifies. One second inside the boundary requires owner review. The server uses elapsed milliseconds, its current clock and the authoritative New York pickup instant, including daylight saving transitions. Status indicating service has started overrides a future scheduled pickup.

The server retrieves the original payment, captured charge and complete refund list. Only settled, matching prior refunds are subtracted; pending, malformed, incomplete or inconsistent evidence requires review. The expected refund is the remaining eligible amount in integer USD cents. The customer confirms it before cancellation. A changed reservation, payment, remaining balance or cutoff invalidates an old confirmation. The worker independently rechecks refundable funds before submission. A fully refunded paid booking can cancel without creating another refund.

The retired proposal remains readable only to preserve any historical acceptance and already-created obligations. No new percentage fees or operational no-show settlements can be created. Legacy bookings without the simple policy retain applicable existing My Trips terms or go to Dispatch; no historical consent is inferred. Existing recorded financial obligations are reconciled at their original amounts.

Owner approval and the cancellation status/audit record commit together under the reservation action lock. For unpaid trips, an existing Checkout must be verified and retired first; ambiguous provider state blocks the decision. Approval never initiates a refund. Refunding an owner-approved exception is a separate authorized financial decision through the company's existing reviewed process. Repeated decisions cannot repeat cancellation or change an already-recorded decision.

Have NJ and NY counsel review cancellation terms, disclosure, retention, started/completed-trip decisions and refund obligations before production release or activation. Legal review is not represented as completed.

Change previews continue using existing booking pricing and short-lived server-owned snapshots. Every amendment still requires Dispatch follow-up. Automatic application remains unavailable without a verified vehicle/chauffeur availability source and a payment ledger supporting additional captures and adjustments.

## Refund recovery

Cancellation and its refund obligation commit in one database transaction. A worker checks due obligations at startup and every minute. Each attempt durably records its timestamp and next due time before calling Stripe. Retry delays are 1, 5, then 15 minutes, then at most hourly until the 24-hour escalation threshold. These are recovery intervals; Stripe settlement timing may vary.

The worker retrieves a known refund by ID. Without an ID, it lists refunds for the stored charge and matches the reservation, operation, charge, payment intent, amount and currency. It submits only after verifying the charge and remaining funds. Previously verified settled refunds are recorded separately and are never refunded again. A newly conflicting refund or uncertain balance requires review. The full-route pricing snapshot and original capture remain unchanged.

Uncertain submissions retain the same durable operation and Stripe idempotency key. The worker will not repeat a POST at or beyond 23 hours from the first submission marker. Retrieval/listing can confirm a refund when its webhook is absent. Signed refund webhooks are checked against current provider state, handling missing, delayed, duplicate and out-of-order delivery. Confirmed payment status remains webhook-controlled.

Dispatch shows initiated, unverified, pending, confirmed, failed and reconciliation-required states. Due-time scheduling prevents old failures from starving newer obligations. Failed or stalled cases remain visible, with timings and immutable audit events. Authenticated operators may recheck provider evidence without initiating another refund. A previously successful refund can fail later; retain the compatible receiver.

For unresolved cases, compare Dispatch with Stripe's charge/refund history in the same account and follow the company's approved manual controls. Do not issue a replacement while an earlier operation or refundable balance is uncertain. Preserve the durable record and document any external action. Existing Stripe configuration is reused; no new service or secret is required.

## Migrations, staged deployment and rollback

1. Keep both controls off. Complete counsel review and an isolated PostgreSQL/Stripe test-mode rehearsal. Confirm the existing webhook subscription includes the required refund events.
2. After separate release approval, deploy a compatible build with both controls off. Startup applies migrations 013–016 through the existing transaction/advisory-lock mechanism. Migration 013 adds guest verification and requests; 014 adds previews, settlements and audits; 015 protects consent and adds durable recovery scheduling; 016 preserves old settlement rows, records verified prior refunds, disallows new retained fees and records owner-applied cancellations. No accepted fare, historical consent or payment is rewritten.
3. Verify browser assets, booking consent, email, My Trips, ordinary payments, migrations, workers and signed webhook handling. Enable priced previews only after separate approval.
4. Enable automatic no-fee cancellations only after all gates and separate owner approval. All workers must understand migration 016 and the simple policy first. A build that still creates percentage settlements is not an activation or rollback target.
5. For rollback, disable new actions and retain a compatible worker and webhook receiver until every obligation and potential later provider failure is resolved. Preserve schema, consent, accepted fares, source-payment records and audit history. The old production build can operate ordinary bookings against the additive schema, but cannot be the sole refund receiver: it may acknowledge managed-refund events without recording them. Do not roll back to the retired proposal to generate new settlements.