# Phase 1 customer account foundation

Customer accounts are independent of admin sessions, guest reservations and FIRST15. No booking fields are autofilled or linked to an account in Phase 1. FIRST15 remains 15% with its existing eligibility, atomic claims and EWR exclusion.

## Storage and migration

Migration 003-customer-accounts.sql runs inside the existing startup transaction and migration advisory lock. It creates er_customers, er_customer_sessions and er_customer_auth_limits, with unique normalized email/phone constraints, session foreign keys and indexes. Public database access is revoked. The deployment role must have the existing migration/schema privileges; runtime requires SELECT/INSERT/UPDATE/DELETE on these tables. No new database credential is needed. Production infrastructure permissions are not asserted to be configured.

## Credentials and sessions

Passwords accept 10–128 Unicode characters (maximum 512 UTF-8 bytes). They use asynchronous Node crypto.scrypt with N=65536, r=8, p=2, a random 16-byte salt and a 64-byte result. The stored format includes scrypt/v1 and parameters; hashes are compared using timingSafeEqual. Unknown accounts undergo the same bounded scrypt work with a dummy hash. At most two password jobs run concurrently per process to limit memory use.

Session tokens use 32 random bytes. Only SHA-256 token hashes are stored in PostgreSQL. The browser receives the token solely in an HttpOnly, SameSite=Strict, Path=/ cookie, Secure with a __Host- prefix in production. Absolute lifetime is 30 days; usage does not extend it. Logout deletes the current session, login revokes the prior browser session, and disabled accounts cannot authenticate. Sessions survive worker restarts. No tokens or passwords enter browser storage, URLs, logs or API JSON.

Customer mutations require same-origin browser metadata and JSON, using the existing origin protection. All customer responses and account HTML are no-store. Login/profile errors use the existing generated reference IDs and sanitized logging.

## Abuse controls

Registration: 10 requests per IP per 15 minutes. Login: 30 requests per IP per 15 minutes. Customer APIs: 120 requests per IP per minute. In addition, a PostgreSQL atomic counter allows 20 attempts per normalized-email hash per 15 minutes across workers, whether or not the account exists. These counts include successful attempts and reset after the fixed window. No plaintext identity is stored in throttle records.

## Deferred work

Local Phase 2 adds password-recovery infrastructure with a mocked SMS provider; production recovery remains disabled pending provider and policy review. See customer-recovery.md. SMS/email enrollment verification, profile editing, trip history, account-to-booking association and account-based promotion eligibility remain deferred. Contact ownership remains unverified. Expired session rows and expired throttle rows are unusable; they currently remain in storage. A future reviewed retention job can purge expired authentication metadata without deleting customers, reservations or payment records. Provider-managed database backups and restricted database access remain required as documented for reservation storage.

Tests use synthetic identities and isolated local PostgreSQL; Stripe and Google remain mocked.
