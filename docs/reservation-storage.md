# Reservation storage and deployment

## Required deployment configuration

PostgreSQL is the only runtime reservation store, in production and development. There is no JSON or in-memory fallback. Set DATABASE_URL privately in the server environment; never paste connection strings into Git, documentation, shell arguments, browser code, or support output. .env.example intentionally leaves it blank.

Render deployment uses the Internal Database URL on Render's private network. Only when RENDER=true and the URL hostname is a Render database name (dpg-...), either single-label or ending in the exact .internal suffix does the application use this private-network policy: no sslmode, or sslmode=disable, uses the documented non-TLS internal connection; sslmode=require requires TLS with Render's self-signed certificate, scoped strictly to that internal host; verify-ca/verify-full still require certificate verification and fail if it cannot be provided. External/public hosts always require verified TLS, including sslmode=require; sslmode=disable is rejected. Ambiguous SSL override parameters/modes are rejected rather than silently weakening TLS. No global TLS setting is modified. DATABASE_URL remains the only credential source. A missing/malformed URL, connection failure or failed migration prevents the server from listening. Runtime storage failures return generic 503 responses, never connection strings or raw database errors. This hostname classification requires the server environment to be trusted and the service/database to share Render's account and region; it does not discover or prove infrastructure placement.

Install using pnpm install --frozen-lockfile. The pg driver is the only new runtime dependency. Existing dependency versions and customer pricing are unchanged.

The initial SQL migration runs transactionally under a database advisory lock before the server listens. It is idempotent and never imports or deletes customer records. Migration failure rolls back and prevents startup. For later schema changes add versioned migrations rather than modifying production tables manually.

Use a dedicated database/schema and a non-superuser application role. Limit it to reservation SELECT/INSERT/UPDATE, required ledger/audit access and schema migration permissions; do not share owner credentials with unrelated services or humans. PUBLIC table access is revoked by the migration. For stricter separation, run migrations with a restricted deployment role and grant the runtime role only the table/sequence privileges it needs. Do not grant DELETE, TRUNCATE or unrestricted schema privileges to routine operators. Ensure no other writer bypasses the application transaction/lock protocol.

## Transactions and reconciliation

Reservation creation and its booking-spam budget check are one transaction guarded by a short advisory transaction lock. Updates select the latest row FOR UPDATE and commit only that row, preserving concurrent webhook/admin changes. All reservation values use SQL parameters.

Checkout uses a PostgreSQL session advisory lock keyed by the existing checkout fingerprint. Another process gets a generic retryable 409 while that action is in progress. The original in-process request sharing remains. The attempt/key/quote are committed before Stripe; ambiguous errors keep the same Stripe idempotency key, including after worker restart. Network calls are outside SQL transactions. A dedicated checked-out connection holds the action lock and is reused for its SQL work; it is unlocked/released afterward or discarded if cleanup fails. A crashed connection releases its lock automatically. Do not use transaction-mode connection pooling for session advisory locks; use a direct PostgreSQL connection or session-mode pooling.

A paid webhook transaction also writes a minimal payment ledger and paid-ride identity hashes. Neither upcoming trips nor payment/eligibility metadata is removed. Payment ledger writes are idempotent by booking ID. FIRST15 checks this ledger of paid identities using the same normalized email/phone matching as before. Hashes are sensitive pseudonymous data, not anonymous data.

## Explicit legacy import

The application never reads or rewrites data/bookings.json. Preserve a protected copy before deployment. To import, privately configure DATABASE_URL and run:

    pnpm db:import data/bookings.json

Run once during a controlled migration window, before opening the replacement deployment to customers. The command validates the entire array first, then imports in one transaction. Duplicate IDs are skipped without modifying the database record, even when the source is older. Paid legacy records populate payment/eligibility ledgers. Invalid records, repeated IDs in the source, database failures or audit-write failures abort the import. Output contains counts/generic failure only; the source is never modified. Existing records lacking reservation access metadata remain inaccessible to public customers; import does not invent access tokens. Legacy unsupported vehicles/invalid fares require manual review, not automatic repricing or silent omission.

Verify counts through a restricted operator connection, reconcile paid bookings against Stripe, and retain the protected source until reconciliation is approved. Do not import on every startup. All prior application instances using JSON must be stopped before cutover.

## Retention policy

Operational reservation data, accounting data and eligibility data serve different purposes and are stored separately. Reservation records remain stored after completion, cancellation or administrative archiving. The current application has no automated disposal or redaction based on the review checkpoints below.

Keep accounting, payment, tax, insurance, transportation and contractual records according to applicable obligations. The payment ledger calculates its seven-year `retain_until` marker from the recorded payment timestamp, falling back to booking creation when that timestamp is missing. The marker is a business setting and does not authorize or trigger deletion. The ledger also has a `legal_hold` field. Its presence does not enforce holds across related records or copies. The import audit records counts and timestamps without customer payloads. The existing seven-year import-audit guidance is separate from the payment ledger marker and should be checked against applicable obligations.

Retain minimal normalized identity hashes and booking references for FIRST15 while the business relies on first-ride eligibility enforcement. Access remains restricted. There is no automatic expiry for those eligibility records.

## Proposed customer data retention and privacy lifecycle

**Local draft — pending final owner and legal review before publication or implementation.** The checkpoints below are approved for review of individual records. The draft adds no runtime behavior.

### Record review checkpoints

| Records | When staff review |
| --- | --- |
| Completed reservations | Five years after the final scheduled trip date. |
| Cancelled reservations | Five years after the final scheduled trip date. Preserve payment, refund, dispute and accounting evidence when required. |
| Abandoned unpaid bookings | Once 30 days have passed since abandonment was confirmed, the final scheduled trip leg has elapsed, and applicable payment and dispute checks are complete. Exclude active or upcoming bookings and unresolved or uncertain payments. |

A checkpoint starts a manual review. It does not cancel, archive, redact or delete a booking or remove it from My Trips. Existing operational cancellation rules remain separate. The business owner approves retention decisions and any eventual disposal. Review active service needs, financial evidence, open complaints, disputes, refunds, chargebacks and any applicable obligations or holds before making a decision. Retain the evidence and frozen Checkout parameters needed for payment reconciliation and safe retries. Any future batch cleanup would require a separately approved, audited transaction that excludes active, upcoming, held and payment-pending records, preserves accounting and eligibility evidence, and limits batch logs to counts.

Stored business records and customer-visible trip history serve different purposes. My Trips queries records linked to the account by trip schedule and paginates the results. There is no five-year rule in the current My Trips query. This establishes neither a guaranteed five years of customer-visible history nor indefinite access. Account ownership and current access rules still apply. Archiving changes visibility in Dispatch while retaining the underlying record. Eligible guests can seek fresh verification for some retained older trips.

Expired access links and sessions can no longer be used even when metadata remains. The application prunes some expired verification records. There is no general account-erasure workflow. Guest contact information saved at the customer's choice remains in the browser until forgotten or cleared.

### Legal holds and copies

The business owner authorizes placement and release of each legal hold. Authorized staff document the scope, reason, relevant records, dates, owner decisions and release in a secure log. Preserve relevant records and prevent intentional deletion while the hold is active. Consider linked records, exports, backups, mailbox copies and provider-held records where required and technically possible. Confirm the controls or assistance available for provider-held copies before relying on them. Local changes do not automatically reach provider or mailbox copies.

Limit access to precise locations, contact details, financial evidence, exports and backups to staff who need it. Keep reservation ownership, guest verification, Dispatch authorization and Charts protections intact. Before using a restore, reconcile payments and reapply applicable holds and prior retention decisions. A restore can reintroduce records that were previously minimized.

### Customer access and reviews

Completed-trip customer booking responses omit the driver phone number. Cancelled-trip customer booking responses omit driver assignment details. Authorized Dispatch retains operational access, and underlying records remain stored. The owner reports that ER Limousine does not currently assign reservations to independent chauffeurs or outside limousine companies. Authorized staff and service providers still receive data needed for their roles.

Published reviews exclude structured contact, itinerary, reservation and payment fields. Customers can voluntarily put personal information in free-text comments. Screening and staff moderation reduce that risk. Removing a review from publication changes its visibility and can leave the review and moderation records stored. A request to remove a review from public display is separate from a request about the underlying records.

### Providers, cookies and tracking

- Stripe processes payments and card entry. New ordinary Checkout sessions use generic service descriptions. Some Dispatch payment links and historical frozen attempts may include pickup, destination and scheduled trip information. Keep the payment references and attempt evidence needed for reconciliation.
- Google Places, Geocoding and Routes support address suggestions, place selection, address lookup and route calculations. An optional current-location lookup sends coordinates after the customer chooses to share them and grants browser permission.
- Resend delivers transactional customer and staff emails. Message content can include reservation details, payment links or access links. Some local outboxes retain content for retries and clear it in terminal states. Delivery metadata and external copies may remain. The repository documents that Resend click and open tracking should stay disabled. Verify the provider setting separately.
- Render hosts the application and PostgreSQL. Confirm deployed logging, ingress, retention, backup coverage, access, encryption, recovery windows and restore procedures with the provider.
- Yahoo hosts the proposed privacy request mailbox for manual intake. Customer messages sent to that address can be processed and stored by Yahoo. Confirm mailbox permissions and retention separately.

When a customer chooses to set up a saved payment card, the website loads Stripe.js to securely handle the setup. Authorized ER Limousine Dispatch staff can view internal trip and payment reports through Business Analytics. These reports are used only for internal business operations.

The repository audit found no implemented advertising pixels or visitor analytics tags. Injected tags, external tracking and provider-side telemetry remain unverified. Functional cookies support sign-in, verification, recovery, quotes and booking access. Browser storage supports optional remembered guest contact details and a temporary saved-card setup reference. Verify provider retention, deletion and contract terms before making claims about those practices.

### Manual privacy requests

1. Authorized ER Limousine staff monitor [erlimousinellc@yahoo.com](mailto:erlimousinellc@yahoo.com). Staff acknowledge requests promptly and track applicable legal response deadlines. The mailbox is a manual intake process.
2. Verify identity and authority as appropriate before disclosing or deleting information. Collect only the information needed to verify and respond. Do not ask for passwords, private links or full card details.
3. Check the relevant records and copies, open service or financial obligations, and legal holds. The business owner reviews every request and approves the final decision and response.
4. Authorized staff communicate securely and record the request and outcome in a secure, access-restricted log. Confirm the operational location and access controls for the case log and the continuity plan for owner review.

### M-08C Phase 1 owner retention review inventory

Phase 1 provides a local, owner-operated inventory and a manual review procedure. The original M-08C finding was unavailable during the audit, so this phase does not establish closure of the entire finding. The owner establishes who may run the command, the secure location and access controls for its output and the manual review log, and the evidence required for a final decision.

Use the existing privately configured `DATABASE_URL` for an authorized database role with read access. The command follows the application's connection and TLS policy. It does not load a local `.env` file. Keep credentials out of command arguments, shell history, output and review logs. For routine operation, use a dedicated read-only database role. Schema migrations must already have been applied through the normal deployment process.

Run from the repository root with the existing Node dependencies installed:

```sh
node scripts/review-reservation-retention.cjs --limit 100
```

The command returns one JSON page. For a reproducible checkpoint calculation, pass an explicit UTC instant with milliseconds:

```sh
node scripts/review-reservation-retention.cjs --as-of 2026-11-17T17:00:00.000Z --limit 100
```

Continue using the returned `nextCursor` with the same `asOf` value, for example `--as-of 2026-11-17T17:00:00.000Z --limit 100 --cursor <nextCursor>`. Treat the cursor as report metadata. It does not grant reservation access. Each page uses a read-only repeatable-read database transaction, stable UUID keyset ordering, a maximum of 250 output records, a 12-second statement timeout and a 5-second lock timeout. The command runs no migrations, application workers or provider requests and writes no application records. Its `asOf` sets the calendar review date; financial and linked-record evidence reflects the database when the page is read. A paginated run is an inventory, and records can change between pages.

Routine output omits customer contacts, exact locations, trip notes, access credentials, payment identifiers and frozen provider payloads. Store any saved report outside the repository, public directories, shared downloads and unprotected email. The owner must establish an access-restricted location before saving reports. Use protected Dispatch views to inspect the reservation's details.

#### Dates, outcomes and limitations

- Completed and cancelled reservations reach their five-year checkpoint from the verified final scheduled New York date. Round trips use the return leg. Hourly trips use the service-end date, including the later date when service crosses midnight. A February 29 anniversary falls on March 1 if the fifth year has no February 29. The date must agree with the stored schedule. Missing or inconsistent legacy dates, nonexistent spring-forward times and ambiguous fall-back times require investigation.
- The checkpoint date and whether it has been reached are separate from financial and hold blockers. `Review due` means the date supports an owner review. `Defer` identifies an existing local blocker, `Evidence required` identifies unavailable or inconsistent evidence, and `Not yet due` means the date threshold has not been reached. Active, upcoming and in-progress service stays outside the due shortlist. No result authorizes disposal.
- The current schema has no general record of owner-confirmed abandonment. The live report cannot calculate the 30-day abandoned-unpaid checkpoint and reports that confirmation is required where applicable. Unpaid status, creation date, expired FIRST15 holds, cancellation, elapsed pickup and archive status do not establish abandonment. Test-only classification inputs demonstrate the timing rule without creating an application workflow or accepting imported dates as proof.
- Recorded ledger holds and retention markers remain distinct from the five-year checkpoint. A false or missing ledger hold does not clear disputes, other holds or external obligations. Pending or uncertain Checkout, payment reviews, unpaid or partially paid balances, refunds and evidence gaps require investigation. An unpaid fare is not proof that a debt remains enforceable; its treatment requires owner review. Confirmed full or partial refunds still require preservation of the associated financial evidence. The command does not contact Stripe to discover external activity.
- Linked counts and states identify records that need checking. They do not certify that every external copy is known. Verify exports, staff mailboxes, the privacy mailbox, provider-held records and applicable Render backups and logs separately. A restore can reintroduce earlier data or access state.

#### Manual owner review procedure

1. Generate a page using authorized read access. Record the policy version, report time and checkpoint `asOf`. Secure the report and continue its cursor until the required scope is covered. Keep exception and deferred records visible for follow-up.
2. Locate the booking by reference in authenticated Dispatch, including its archived view when needed. Verify the actual reservation status, the final scheduled leg and account or guest association. Do not infer completion or abandonment from elapsed time or archival.
3. Check accepted fare, verified payments, frozen attempts, current payment reviews, refunds, open requests and related history. Use authorized provider records to check disputes or other activity absent locally. Check accounting, tax, transportation, insurance, contractual and legal needs with the appropriate advisers.
4. Check holds across the reservation, financial records and linked copies. The business owner authorizes hold placement and release. Staff record the authority and scope and preserve relevant evidence while any hold is active. Confirm provider or backup capabilities before relying on them.
5. Rerun the inventory before recording a final decision. Compare the reservation version or fingerprint, date basis, local financial evidence and linked states. Reinspect a changed record and refresh external evidence. A report alone does not freeze the reservation or its related records.
6. The owner records a decision to retain, defer or investigate, the rationale and a next review date in the secure manual log. Record confirmed abandonment and its verification evidence there when established. Its absence must not be replaced by an inferred date.
7. Review relevant export, mailbox, provider and backup copies and restoration implications. Record evidence references securely rather than copying itineraries, private access links or payment identifiers. Any later disposal or minimization requires a separately approved scope and implementation that preserves required financial and audit evidence.

Use this minimal manual log template in the owner-established secure location:

| Field | What to record |
| --- | --- |
| Booking reference and policy version | Reference used in Dispatch and the inventory policy version. |
| Date basis and checkpoint | Verified final scheduled date or confirmed abandonment date, source, checkpoint and `asOf`. |
| Owner, reviewer and review time | Responsible people and the timestamp of the review. |
| Version or fingerprint | Inventory value rechecked before the decision, plus any changes investigated. |
| Categories checked | Service, payments, refunds, disputes, obligations, holds, access, requests, reviews, communications and linked copies, as applicable. |
| Evidence references | Access-controlled references to verification evidence, without duplicating contacts, locations, credentials or financial identifiers. |
| Decision and reason | Retain, defer or investigate, with the business owner's rationale and approval. |
| Next review date | Follow-up date chosen by the owner and any evidence still required. |
| Hold authority | Placement or release approval, scope and dates where applicable. |

### Approved future notice links

The owner approved links in the website footer, booking flow, customer registration, customer login and My Trips dashboard, along with the existing customer review form link. The review form link already exists. Implement the additional links in a separate approved phase after document review.

### Approval before use

Qualified advisers should confirm New Jersey and New York privacy applicability, consumer rights and deadlines, appropriate identity verification, and treatment of sensitive location and sharing. Review security, breach notification and disposal duties, as well as tax, transportation, insurance, contractual and other recordkeeping obligations. [New Jersey privacy statute](https://pub.njleg.state.nj.us/Bills/2022/PL23/266_.HTM) · [New Jersey sensitive-data amendment](https://pub.njleg.gov/Bills/2026/AL26/25_.HTM) · [New York security protections](https://www.nysenate.gov/legislation/laws/GBS/899-BB) · [New York breach notification](https://www.nysenate.gov/legislation/laws/GBS/899-AA) · [IRS recordkeeping guidance](https://www.irs.gov/businesses/small-businesses-self-employed/how-long-should-i-keep-records) · [NYC TLC trip records guidance](https://www.nyc.gov/site/tlc/tlc-online/fhv-trip-record-submission.page)

Before publishing or implementing changes, verify Render backup and log settings, provider retention and deletion capabilities, Resend click and open tracking, and any external tracking or injected tags. Revisit the notice against confirmed practices and qualified legal review.

## Protected backups and recovery

Provider-managed encryption at rest and encrypted backups are required infrastructure settings; JSONB is not application-level field encryption. Use a production database plan with protected backups/PITR where available, restricted backup/export access, and tested restore procedures. Confirm coverage, retention, recovery point/restore targets and alerting with the provider. This code neither enables nor proves those settings. No claim is made that production backups are currently enabled.

Protect any export with encryption and restricted filesystem permissions. Keep exports outside public/ and Git. The ignore rules cover designated database export/backup directories and common dump formats; do not force-add ignored data. Restore into an isolated private database first and reconcile Stripe before reopening booking.

## Tests

pnpm test runs the existing security suite plus storage failure/validation tests using explicitly injected isolated storage. Runtime configuration cannot select that adapter.

The PostgreSQL integration tests additionally require ER_TEST_DATABASE_URL in the test process environment, pointing only to an isolated database whose name starts with er_test_. They reset that test database's reservation tables and must never target production. They test actual transactions, competing connections, locks, rollback, ledgers and mocked Stripe/Google flows. Test output never prints the URL.

Provider references: [Render PostgreSQL connections](https://render.com/docs/postgresql-creating-connecting), [Render backups/PITR](https://render.com/docs/postgresql-backups). Transaction implementation follows [node-postgres transactions](https://node-postgres.com/features/transactions) and [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html).

## Atomic FIRST15 checkout claims

The er_first_ride_claims table stores only normalized email/phone SHA-256 hashes, booking ID and creation timestamp. Unique identity hashes and a short database transaction advisory lock serialize the paid-eligibility check and claim across workers. Both identity matches follow the existing email OR phone rule. Payment updates/claim cleanup use the same lock before row locking, preventing eligibility/payment races and lock-order inversions. No database transaction is held while Google or Stripe is called; checkout/reconciliation retain only the existing session-level action advisory lock. Different customers can perform external checkout calls independently.

An authenticated same-booking retry reuses its claim and persisted Stripe idempotency key while the original future trip and provider retry window remain valid. Only a provably unsubmitted attempt or an allowlisted first-submission pre-execution rejection can release a claim without a verified expired/unpaid session. Ambiguous errors keep the claim and attempt; independent server/admin reconciliation can inspect them even after pickup passes. Closing the browser/cancelling navigation does not prove nonpayment. Open or payment-processing sessions keep the claim. Submitting a different booking cannot release another booking's claim; independent reconciliation requires conclusive provider evidence and transactional rechecks. Local clock expiry alone never releases it. Paid webhooks atomically persist paid identity eligibility and remove claims, so future FIRST15 is rejected permanently. No cleanup deletes eligibility/payment data. Runtime credentials additionally require SELECT/INSERT/DELETE on the claims table; migration privileges remain necessary at startup.


## FIRST15 ambiguous-attempt reconciliation (new audit finding 2)

FIRST15 remains 15%. Unverified customer identity remains the separately accepted risk; reconciliation does not verify identity or relax atomic claims.

Future FIRST15 attempts use existing reservation JSONB, with no schema migration. A versioned attempt contains a random nonsecret correlation reference, the existing idempotency key, immutable server-generated creation parameters, first-submission time, submission count, last reconciliation time, state and a fixed evidence category. Only necessary existing booking/price/URL data is repeated in the immutable parameters to preserve exact retries; no credentials or reservation access tokens enter the parameters or Stripe metadata. The correlation reference is included in server-controlled Stripe metadata and grants no access.

States are prepared, submitted_unknown, session_identified, confirmed_paid, confirmed_unpaid and review_required. Submission is durably marked before the provider call. Each FIRST15 SDK call disables hidden network retries; ownership-proven application retries use the same persisted parameters/key within the original valid-trip and supported idempotency window. A later validation error never clears an earlier ambiguous submission. An aged unresolved attempt is not recreated with a possibly pruned Stripe key.

A bounded server worker runs every five minutes. It inspects up to ten claimed reservations, prioritizing those least recently checked. The original PostgreSQL action lock excludes concurrent checkout/reconciliation for the attempt; another worker skips a busy action. Provider calls occur outside database transactions. Individual inspection calls have ten-second timeouts and no SDK network retries. Missing-session inspection is capped at ten pages of 100 sessions, with a thirty-second between-call budget. Exhausted budgets, provider failures and incomplete scans remain unresolved.

Saved sessions must match their exact ID, booking, mode, amount, currency and FIRST15 metadata; versioned attempts additionally require their exact correlation reference and expiration. Without an ID, fully paginated inspection may positively recover a uniquely matching correlated session, which is then retrieved and revalidated. Contact similarity and timing alone never establish association. Empty scans, conflicting candidates, mismatches and legacy attempts without correlation enter review_required, retaining claims. No negative scan proves noncreation.

Claims may automatically be removed only for: (1) a versioned prepared attempt durably proven unsubmitted, (2) a first and only submission with a narrowly classified pre-execution parameter rejection and no earlier ambiguous call, or (3) an exactly verified expired/unpaid session. Finalization rechecks the attempt key/state, session association, paid eligibility and owned claim under the existing FIRST15 advisory lock and reservation row lock. Paid outcomes use the existing atomic paid ledger/eligibility path. Transaction failures roll back; paid webhooks cannot be overwritten by stale reconciliation.

Reconciliation does not apply trip-date validation, so it can inspect past pickups. It never creates a session, changes trip times, extends expiration, expires another customer's open session, or returns a Checkout URL. Open/processing sessions retain claims until provider evidence becomes terminal. After confirmed unpaid resolution, a completely new future booking passes the ordinary validation and FIRST15 rules.

There is no customer recovery endpoint or release override. The existing authenticated admin page shows FIRST15 reconciliation status and a narrowly scoped Check FIRST15 payment state button. The endpoint uses existing admin sessions/CSRF protections, no-store responses and ten checks per minute per client. It returns only a generic acknowledgement; sanitized errors/reference IDs remain unchanged. Customer contacts or reservation cookies do not grant admin authority. Submitting a new booking cannot cause another claim to be inspected, expired or released.

Review-required cases need operator investigation through restricted Stripe tooling/support. Use the nonsecret booking/attempt references to locate conclusive provider evidence, then rerun the protected check if a matching session becomes discoverable. There is no blind release button, and operators must not delete claims directly or infer nonpayment from missing events/empty listings. Legacy ambiguous cases without conclusive provider evidence remain explicitly flagged and protected; this implementation cannot guarantee automatic resolution for every Stripe-indeterminate outcome. Any future evidence-backed operator resolution procedure requires separate review.
