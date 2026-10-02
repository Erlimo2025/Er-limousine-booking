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

There is deliberately no automated deletion or redaction in this change. A retention deadline is a review date, never permission to delete. This prevents accidental loss of upcoming trips, active reservations, disputes, refunds, accounting records or FIRST15 eligibility.

- Operational trip/contact/dispatch data: review for minimization 90 days after completed/cancelled service and the final scheduled leg. Abandoned unpaid reservations: review after 30 days and after their final scheduled date, only if no payment/reconciliation remains pending. Active/upcoming reservations are excluded.
- Accounting/payment ledger: retain at least 7 years from payment. The database records retain_until and a legal_hold flag; disputes, refunds or legal requirements extend retention. The business must approve any longer legally required period before removal.
- FIRST15/security eligibility: retain minimal normalized identity hashes and booking reference while FIRST15 first-ride enforcement operates; no automatic expiry. Keep access limited and do not expose hashes publicly.
- Import audit: retain counts/timestamps at least 7 years; it contains no customer payload.

Operational reservation data, accounting data and eligibility data have separate tables/purposes. Full operational records currently remain intact until an authorized, audited minimization process is approved. Any future cleanup must be transactional, exclude active/upcoming/legal-hold/payment-pending records, preserve accounting/eligibility records and log counts only. The application does not claim to fulfill deletion requests automatically.

## Protected backups and recovery

Provider-managed encryption at rest and encrypted backups are required infrastructure settings; JSONB is not application-level field encryption. Use a production database plan with protected backups/PITR where available, restricted backup/export access, and tested restore procedures. Confirm coverage, retention, recovery point/restore targets and alerting with the provider. This code neither enables nor proves those settings. No claim is made that production backups are currently enabled.

Protect any export with encryption and restricted filesystem permissions. Keep exports outside public/ and Git. The ignore rules cover designated database export/backup directories and common dump formats; do not force-add ignored data. Restore into an isolated private database first and reconcile Stripe before reopening booking.

## Tests

pnpm test runs the existing security suite plus storage failure/validation tests using explicitly injected isolated storage. Runtime configuration cannot select that adapter.

The PostgreSQL integration tests additionally require ER_TEST_DATABASE_URL in the test process environment, pointing only to an isolated database whose name starts with er_test_. They reset that test database's reservation tables and must never target production. They test actual transactions, competing connections, locks, rollback, ledgers and mocked Stripe/Google flows. Test output never prints the URL.

Provider references: [Render PostgreSQL connections](https://render.com/docs/postgresql-creating-connecting), [Render backups/PITR](https://render.com/docs/postgresql-backups). Transaction implementation follows [node-postgres transactions](https://node-postgres.com/features/transactions) and [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html).

## Atomic FIRST15 checkout claims

The er_first_ride_claims table stores only normalized email/phone SHA-256 hashes, booking ID and creation timestamp. Unique identity hashes and a short database transaction advisory lock serialize the paid-eligibility check and claim across workers. Both identity matches follow the existing email OR phone rule. Payment updates/claim cleanup use the same lock before row locking, preventing eligibility/payment races and lock-order inversions. No lock is held while Google or Stripe is called. Different customers can perform external checkout calls independently.

A same-booking retry reuses its claim and persisted Stripe idempotency key. Definitive Stripe creation failures clear the attempt and release the claim transactionally. Ambiguous errors keep both: retry the original booking to reconcile Stripe safely. Closing the browser/cancelling navigation does not prove nonpayment. Open or payment-processing sessions keep the claim. A different booking can release an old claim only after Stripe confirms the exact stored session is expired and unpaid; local clock expiry alone never releases it. Paid webhooks atomically persist paid identity eligibility and remove claims, so future FIRST15 is rejected permanently. No cleanup deletes eligibility/payment data. Runtime credentials additionally require SELECT/INSERT/DELETE on the claims table; migration privileges remain necessary at startup.
