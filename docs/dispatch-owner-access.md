# Dispatch owner access — M-02 Phase 2

This is the owner-only first release. It provides one privately provisioned owner identity, authenticator-app MFA, single-use recovery codes, database-backed sessions and shared authentication limits, owner session controls, and a protected Audit Log. Staff invitations and custom roles are not implemented. Customer identities never acquire Dispatch authority.

## Configuration and private provisioning

The existing application database connection policy remains in force. Apply the reviewed migration through the existing deployment/migration process before enabling owner access. The provisioning command does not run migrations, start the application or workers, or call providers.

- `DISPATCH_OWNER_ENABLED=true` enables the owner login and rejects the old shared login and its process-local sessions. Without this explicit setting, the existing shared-login behavior is retained for compatibility; do not mistake that mode for MFA-protected access.
- `DISPATCH_MFA_KEY` must be a privately generated base64-encoded 32-byte encryption key, stored as an application secret outside the database and source control. All instances must use the same key. Keep a protected recoverable copy and test its restore procedure. Losing the key requires controlled emergency recovery and replacement MFA enrollment. Do not print the key or include it in reports, shell history, screenshots, or support messages.
- The owner login address is supplied during private setup. There is no default address, default password, public registration, or public bootstrap/reset endpoint.

From an authorized private terminal with approved database/environment configuration, run:

```text
node scripts/provision-dispatch-owner.cjs
```

The command prompts for display name, login address, a password of at least 14 characters, and the exact confirmation `PROVISION ONE OWNER`. Password entry is hidden and terminal line history is disabled, so a later prompt cannot recall a masked password. It refuses to provision a second owner, even if the existing account is disabled. It neither emails credentials nor prints them. `--stdin` accepts a bounded JSON input for controlled automation and synthetic fixtures only; never put credentials in command arguments, a committed file, terminal transcript, or CI log.

First sign-in verifies the password and grants only a short-lived enrollment challenge. The owner enters the displayed manual setup key into an authenticator app, verifies its six-digit code, and securely saves the eight recovery codes. No reservation or report API is authorized until MFA enrollment completes. Setup secrets and recovery codes are shown only for their designated setup response, use no-store responses, and are not retained in browser storage. Closing the page before saving recovery codes requires regenerating them after a fresh password/code check.

Authenticator seeds are encrypted using authenticated AES-256-GCM with owner-specific associated data. Passwords use the repository's bounded scrypt implementation. Recovery codes contain 96 random bits each and are stored only as hashes. OTPAuth 9.4.1 implements the TOTP algorithm; this change does not invent an OTP algorithm. Accepted codes cover the current step and at most the previous step, reject future codes, and cannot be reused across instances. If a code was just used to sign in, wait for the authenticator's next code before a sensitive account action.

## Sessions and shared limits

Owner sessions use a separate random HttpOnly cookie, Secure and `__Host-` in production, SameSite Strict, with no credential in localStorage/sessionStorage. PostgreSQL stores only the token hash. Sessions retain the existing eight-hour absolute and 30-minute idle deadlines. Passive Charts/session expiry checks must not extend the idle deadline.

Successful MFA immediately consumes the five-minute authentication challenge and clears its pending setup secret. A non-authenticating association between that challenge hash and the issued session hash remains until the session's absolute expiry, or earlier revocation. Logout revokes the session, any pending challenge, and a completed session linked to a retained challenge, so a delayed sign-in response cannot restore access after logout. This metadata does not extend the challenge's authentication lifetime or expose bearer values.

Login, MFA, and recovery attempt budgets are atomic in the shared database, not per process. The source budget is checked before the identity budget. Login allows 30 source/20 identity attempts per 15 minutes; MFA allows 30 source/8 identity attempts per five minutes; recovery allows 20 source/8 identity attempts per 15 minutes. Counters include successful verification attempts and enrollment setup calls. Cooldown is automatic; there is no public unlock or hidden credential bypass. Expired attempt counters are pruned in batches of at most 250 per request, skipping locked rows and preserving live budgets. Authentication metadata cleanup does not touch reservations, payments, or customer records.

The owner can list sessions and sign out every other session after a fresh password and unused authenticator code. The bounded list shows up to 50 sessions. An incorrect fresh confirmation shows an error without signing out a still-valid owner session; expired or revoked sessions require sign-in. Revocation is shared across instances. Authorization is rechecked at protected operation boundaries, before sensitive queue responses, and between CSV batches. A revocation cannot undo a committed operation, erase information already delivered, or recall a downloaded file. A database outage fails protected access closed.

## Recovery with a saved recovery code

Choose **Lost access to your authenticator?**, enter the login address, password, and one saved recovery code, then choose **Start recovery**. A valid code is consumed atomically. All existing owner sessions, pending login challenges, and old recovery codes are revoked. The browser receives a restricted enrollment challenge, not Dispatch access. Enroll a replacement authenticator and save the newly issued recovery codes before returning to Dispatch.

The old factor cannot establish a new login while recovery is pending. A stolen password alone cannot start replacement enrollment. If the recovery challenge expires or its browser cookie is lost, contact the authorized operator for controlled emergency recovery; do not restore the shared credential as a workaround. Recovery codes cannot recover a forgotten password on their own. There is no email-only MFA reset or security-question fallback in this phase.

## Emergency recovery and operator evidence

Before production use, the owner must designate the trusted infrastructure operator, establish a secure recovery-log location and access policy, and agree an independent owner-verification procedure. These are operational requirements, not capabilities the application can establish on its own. Do not accept an unsolicited email, caller claim, or a supplied login address alone as authority.

After independently verifying ownership and recording approval and evidence references in the secure recovery log, the authorized operator runs:

```text
node scripts/provision-dispatch-owner.cjs --recover
```

The command requires the existing address, a replacement password entered privately, a secure evidence reference, and the exact confirmation `RESET OWNER MFA AND REVOKE ALL SESSIONS`. It clears the old factor and recovery codes, increments the authentication version, revokes all sessions/challenges, and requires new MFA enrollment. It does not recover or expose the former password, seed, or codes. The application audit records the operator-initiated reset and affected account reference, without falsely naming an authenticated owner as the operator. Record its printed operational reference, operator identity, owner-verification evidence references, time, reason, and outcome in the secure recovery log. Do not duplicate credentials or identity documents there.

The reset and revocation are transactional. If the command fails, investigate the generic operational failure through authorized channels. A lost database connection must not result in an unprotected owner login. The owner must be notified through the previously agreed verified contact process; this phase does not claim to send automatic recovery emails.

## Owner controls and Audit Log

The owner navigation adds **Owner account** (the owner-only version of the mockup's Staff Access) and **Audit Log** to the existing Dispatch dashboard. Owner account shows the owner identity, MFA state and sessions, with fresh-verification controls for signing out other sessions and regenerating recovery codes. Invitations, staff-role editing and account deletion are deferred.

The Audit Log is owner-only, no-store, bounded and cursor-paginated. Filters accept fixed action codes, staff identity and New York dates. Entries show time, verified account identity where known, action, optional opaque record reference, and the actual outcome. It is not a customer activity or payment ledger. A completed payment recheck is not proof of payment; a completed CSV export means the server finished its response, not proof of receipt by a device. Failed, denied and interrupted outcomes remain distinct.

New security entries persist immutable owner IDs as well as session actor UUIDs. The non-secret actor-to-owner linkage is retained after session revocation/pruning so existing feature-specific audit records remain attributable. Existing feature histories are not all copied into the new list. Historical shared-credential events cannot be retrospectively assigned to a person and are not imported from Render. The Audit Log's coverage-start value describes the earliest retained entry, not proof that no events are missing before or after it.

Application event APIs provide no edit, deletion or export controls. Database update/delete triggers protect the event rows against ordinary mutation; a privileged database operator can still change infrastructure/schema, so this is not a tamperproof external archive. Security events retain allowlisted fields only: no password, MFA seed/code, recovery code, bearer cookie/token/hash, raw URL/search, customer contact, exact itinerary, payment identifier, provider payload, or raw error text. Names are resolved through the protected owner account rather than copied into operational console logs.

Auth/session security actions record successful changes in their database transaction. Existing Phase 1 business-mutation logs remain after-persistence, and new general security events are appended through a best-effort sink. A post-commit audit sink error does not reverse the business action or falsely report it as failed. CSV network completion and an audit insert cannot be one atomic transaction: use one idempotent terminal event per request/action, retain sanitized operational fallback, and investigate collection gaps. Render collection/access/retention is still unverified.

## Staging acceptance before retiring shared access

Use a separate staging hostname and fresh isolated database, synthetic owner/customer credentials and reservations, staging-only encryption key/enrollment, and mocked or test providers. Never restore production customer records for this rehearsal. Obtain separate authorization before configuring or deploying staging or production.

1. Rehearse the migration and privately provision the synthetic owner. Verify provisioning a second owner is rejected.
2. Enable owner mode. Confirm the old shared credential and any retained legacy session are rejected; owner mode must not leave an alternate shared-login path.
3. From clean desktop and mobile browsers, verify no Dispatch API works before enrollment/MFA. Enroll, save recovery codes, sign out and sign in again. Check keyboard/focus, manual key handling, error messages and no secret browser storage.
4. Verify wrong, expired, future and reused TOTP codes fail; exercise concurrent verification on two app instances. Test shared login, MFA and recovery limits and cooldown. Wrong fresh verification on account controls must show an error while retaining a valid session; revocation must still require sign-in.
5. Sign in on both instances. Revoke the other session; confirm it fails on either instance while the current session works. Repeat for API mutation and multi-batch export boundaries. Restart an instance and verify sessions/limits/revocation remain shared.
6. Rehearse lost-phone recovery from a clean browser. Verify no access before replacement enrollment, a used code cannot replay (including simultaneous use), every old session/factor/code fails, and new recovery codes work. Expire a restricted recovery challenge and confirm password-only login cannot bypass recovery.
7. Rehearse total-loss emergency recovery with the authorized operator and synthetic verification evidence. Confirm the command's evidence reference, transaction, audit record, notification/runbook step, new password and enrollment, and denial of all previous sessions/factors/codes.
8. Verify unauthorized, customer, guest and incomplete-MFA requests cannot read sessions/audits or use Dispatch. Verify forged client names/actor IDs cannot change attribution. Check pagination/filter/date bounds, redaction, append-only behavior, and sink/database failures.
9. Rerun existing Dispatch, ownership, booking, archive, CSV, payment/refund/recovery and browser regressions. Confirm pricing, promotions, signed settlement and customer driver privacy remain unchanged.
10. Obtain owner acceptance. Before a separately approved production cutover, establish the real private owner address, encryption-key custody/recovery, emergency operator and log, approved audit-retention policy, and staging/deployment configuration. Provision and verify production-specific MFA/recovery privately. Enabling owner mode retires shared access and invalidates legacy authority; verify that gate and remove obsolete shared credential configuration in the separately approved rollout.

Do not roll back to a deployment/configuration that silently reenables shared access. A rollback plan must preserve the authentication gate and database compatibility or fail Dispatch access closed while an authorized recovery is performed.

## Local separate-process verification

With an explicitly isolated loopback PostgreSQL test database configured through the existing `ER_TEST_DATABASE_URL` fixture policy, run:

```text
node --test --test-concurrency=1 tests/dispatch-owner-processes.test.cjs
```

This suite forks two separate Node processes running the actual server through the existing synthetic Google/Stripe/email harness. Each process has its own PostgreSQL pool against the same isolated schema. It verifies distinct process IDs, MFA-authenticated access through both workers, retained and revoked cookie replay after worker restarts, and shared identity/source budgets for login, MFA and recovery. Child environments contain synthetic fixture configuration only; provider calls remain mocked. Cleanup stops every child and removes only its synthetic schema.

This local test does not verify Render's load balancer, proxy configuration, deployment settings or log access/retention. Repeat the staging checklist on the chosen staging infrastructure before approving production cutover.

## Outstanding owner decisions

The owner still must choose the audit retention period (distinct from reservation five-year review and ledger retention), staging environment, private production login address, secure encryption-key custody, emergency recovery operator/verification process, and secure audit/recovery-log access. No audit cleanup job or retention period is enabled in this phase. No production owner is enrolled by this implementation.

Bounded queries and authentication limits do not establish a storage-retention policy or a maximum lifetime log size. Before rollout, establish storage monitoring and a reviewed retention/access process, including how to investigate repeated denied requests and audit delivery gaps.
