# Reservation payment choices

Reservations use the existing PostgreSQL row ownership, booking access credentials and server quote calculation. Saved cards are not selectable or charged.

## Booking and payment
The final booking step offers Reserve & Pay Now and Reserve & Pay Later with the quoted total visible. Both use /api/checkout and the same booking fingerprint/action lock. paymentChoice is only an intent (now or later), never price authority.

Pay Now reserves the trip then opens Stripe Checkout. Pay Later stores the authoritative quote with awaiting_payment/unpaid and a server-owned deferredPayment flag, without creating a Checkout session. The existing reservation-status page shows Payment Pending and Complete Payment. Stripe cancellation returns to that status page without deleting the reservation.

Customer completion: POST /api/customer/trips/:id/payment, authenticated session, exact canonical Origin, JSON empty body, safe Fetch Metadata, rate limited and no-store. Full record lookup includes customer_id and reservation ID in SQL. No browser amount, owner, discount or provider ID is accepted.

Guest completion: POST /api/booking/:id/checkout, same mutation protections and a valid existing high-entropy booking cookie. ID/contact fields are not credentials. Guest reservations remain unowned, including matching account emails/phones. Completion from a different browser without that cookie is unavailable; secure recovery/claiming would require a separate review.

Payment completion uses only the stored fare. It performs no new Google lookup, fare calculation or EWR identity selection; those were authenticated/verified at reservation creation. Booking and Checkout retries never transfer ownership. Only the signed webhook marks a reservation Paid; API reconciliation records provider evidence and session association while retaining unpaid state and claims until the webhook arrives. Return URL flags cannot mark a trip paid.

## Retries
The same fingerprint lock serializes reservation and payment creation across workers. Duplicate reservation payloads reuse the original reservation only with the booking credential. My Trips grants payment access independently through SQL account ownership; it does not grant arbitrary booking-token access.

An open, unpaid Checkout session with matching reservation, mode, amount and currency is reused. Complete/processing/paid provider states block another charge. Only a verified expired/unpaid session permits replacing the Checkout session on the same reservation. Lost responses reuse the durable provider idempotency key; aged indeterminate outcomes fail closed and may require operator reconciliation.

## FIRST15
FIRST15 remains exactly 15%, with existing EWR special exclusion and formulas unchanged. A new Pay Later FIRST15 reservation and its hashed contact claims are committed atomically under the existing claim lock. Failed competing creation rolls back the reservation.

The server-owned deferredPayment flag retains the claim while the reservation is payable, including no submitted Checkout, dispatch updates and verified Checkout expiry. Paid states release claims; paid ledger eligibility remains permanent. A cancelled deferred reservation releases its claim only when no Checkout was submitted or when provider reconciliation conclusively establishes unpaid expiry. Cancellation alone never releases an open/ambiguous payment claim. Existing Pay Now claim rules remain, and later completion must acquire/revalidate FIRST15 eligibility before opening another session.

FIRST15 Pay Later holds expire after 24 hours from reservation creation. Unsubmitted reservations are cancelled under the same reservation action lock before eligibility is released. Open/indeterminate payment authority is never released merely because time passed: it must first be expired and verified unpaid or conclusively reconciled. Separate bounded expiry and submitted-reconciliation batches prevent abandoned reservations from starving provider recovery. This is a temporary eligibility hold, not account ownership or a verification of the supplied email/phone.

No migration is required. The flag uses the existing JSONB reservation structure; ownership remains outside JSONB. Migrations 001–007 are unchanged.

## UI privacy
My Trips shows Complete Payment only for unpaid, noncancelled reservations. Status-page and account restoration fetch actual server state. Reservation text uses safe DOM text nodes. Authenticated/status responses are no-store/no-referrer. The existing hash-based confirmation-page CSP is updated for the changed local inline script without broader permissions.

All automated tests use mocked Stripe/Google and a separate isolated local PostgreSQL regression database. No production database/provider calls are required.

## Cancellation and exceptional payment
Admin status changes share the same nonblocking database action lock as Checkout; a concurrent cancellation gets a retryable conflict rather than mutating the reservation mid-submission. The storage layer rejects unlocked cancellation transitions. An open session is retrieved, validated and expired before cancellation releases its claim. Cancellation cannot erase an ambiguous attempt.

A signed late-payment event still records funds received but preserves cancelled booking status and marks paymentReviewRequired for operator review. Admin UI shows that fixed review badge; customer status and My Trips say payment was received for a cancelled trip and request contact. No automatic refund or automatic trip re-confirmation is introduced.

Generic Checkout attempts now also persist submission uncertainty and immutable parameters. A later provider rejection never clears an earlier ambiguous attempt; retries reuse its exact idempotency identity. Only a first, known pre-execution rejection can safely retire an unsubmitted generic attempt.

## Payment verification display
Status and My Trips responses expose only paymentVerificationPending, derived from verified server/provider evidence. This is display state, never Paid authority. While verification is pending, the customer sees “We’re confirming your payment. You do not need to pay again.” and no Complete Payment action. Signed webhook completion remains the only payment transition to Paid. Client fields and return URL parameters cannot set either state.

## Local regression isolation
The supported `npm test` command serializes test files. PostgreSQL integration files share one ER_TEST_DATABASE_URL and use separate schemas, but the production advisory locks (migration, FIRST15 and booking action locks) are database-wide, not schema-scoped. Identical synthetic bookings in different schemas can therefore conflict, and concurrent migration/claim work can contend. Do not change production locking to accommodate test fixtures.

A concurrent full-suite run is useful diagnostically, but passing one run does not establish isolation. Use `node --test tests/*.test.cjs` for that optional check. Each file still exercises explicit concurrent workers/requests internally under the supported serial command. The concurrent-only storage/teardown failures reproduced once in a two-file PostgreSQL/payment group (EWR storage errors followed by an already-ended-pool teardown error), but three repeats and the current full concurrent suite passed. Their exact initiating error has not been established. A direct two-search-path action-lock probe did confirm a 409 conflict across schemas; serialization avoids that demonstrated isolation limitation without changing production code.
