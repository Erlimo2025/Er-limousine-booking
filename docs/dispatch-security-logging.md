# Dispatch security logging — M-02 Phase 1

The server emits additional structured JSON security events through its existing console error output. These are best-effort operational logs. They are not a new database audit table, a verified log archive or an alerting service. Render log collection, access, retention and alerting still require owner verification.

## Event fields and identity

Every event contains `timestamp`, the server-generated request `referenceId`, `operation: "admin"`, `category: "dispatch_security"`, and fixed `action` and `outcome` codes. Where available, `actorId` is the existing server-owned Dispatch login-session UUID. Reservation actions can include an opaque reservation UUID as `recordId`. Export events do not include record references or filters.

The actor UUID identifies a session authenticated under the shared Dispatch credential. It does not identify a named staff member. A new login receives a different UUID; there is no new staff account, identity assertion or individual revocation mechanism. The UUID is not the session cookie, token or token hash. Client-supplied staff names, request-reference headers and actor fields do not establish audit identity.

Only permitted codes and valid UUID references are serialized. Credentials, cookies, tokens, token hashes, raw URLs, search terms, request/response payloads, customer contacts, exact locations, trip notes, payment identifiers and raw error messages are excluded. A record UUID remains linkable operational metadata: access to these logs should be restricted. Use protected Dispatch views for the underlying business information.

## Covered actions

| Action | Meaning and outcomes |
| --- | --- |
| `dispatch_sign_in` | `succeeded` after the server creates the session; `denied` for rejected access; `failed` for an unsuccessful operation. |
| `dispatch_logout` | `succeeded` after the identified session is removed; `unchanged` when no session was present. Rejected requests are `denied`. |
| `reservation_status_update` | `succeeded` after the requested status change persists; `unchanged` when the requested status was already present. Validation/storage failure is `failed`; rejected access is `denied`. |
| `driver_assignment_update` | `succeeded` after changed assignment fields persist; `unchanged` when the permitted assignment fields are identical. Failed/denied operations do not receive a success event. Assignment values are never logged. |
| `reservation_cancellation` | `succeeded` after cancellation persists; `unchanged` when the reservation is already cancelled. Failed/denied cancellation attempts do not receive a success event. |
| `payment_recheck` | `completed` after the awaited manual check finishes, including its existing cooldown or no-op behavior. Exceptions are `failed`; rejected access is `denied`. This event is not proof of payment, provider confirmation or a new financial mutation. |
| `financial_csv_export` | Exactly one terminal event: `completed`, `failed`, `interrupted` or `denied`, as described below. |

Successful mutation events are emitted only after the corresponding storage promise resolves. An event describes that persisted action, not guaranteed receipt of an HTTP response. The existing cancellation flow can commit cancellation before a later assignment update fails. In that case the cancellation success remains valid and the assignment receives no false success. The logging patch does not combine or change those existing transactions.

Denial/failure events retain the existing sanitized error diagnostics. Logging sink exceptions or rejected writes do not change authentication, responses or a committed business action; delivery therefore is not guaranteed solely by executing the application code.

## Financial CSV stream outcomes

The existing authorization, report selection, sorting, pagination, CSV fields, amounts, formula protection and response behavior remain in place. No search query, date filter, CSV row or financial identifier is copied into a security event.

- `completed`: the authorized export traversal and writes finished, and the response emitted `finish`. This means the server completed its output stream; it does not prove the customer device received or retained a file.
- `denied`: access, origin or rate-limit checks rejected the request before the export handler began.
- `failed`: invalid export input or a known storage/write failure prevented normal completion.
- `interrupted`: the response closed early, the request was aborted, or session revocation/expiry stopped an export after initial authorization. A revoked export stopped before its first chunk is still interrupted, rather than a completed download.

The completion and close listeners share one finalizer, so normal `finish` followed by `close` does not produce two terminal events. A connection that closes before a later storage error is observed is recorded as interrupted.

## Existing durable records and remaining M-02 work

Archive/restore, payment-link delivery bookkeeping, review moderation, reservation-request decisions and managed-refund operator rechecks retain their existing feature-specific audit records. This phase does not add duplicate security events to those workflows or change their records. Payment-link bookkeeping remains a record of creation/latest copy/email-request state, not a complete immutable history of every click. Completion invitations remain distinct from general status-change history.

Named staff accounts, individually revocable access, MFA, separate viewing/export/operational/financial permissions, replica-wide sessions and login budgets, and verified Render log retention/access remain open under M-02. The server still has one shared Dispatch authority. This phase does not claim that the original finding is fully closed.

## Validation

Use the existing synthetic security and analytics fixtures plus the focused formatter tests. PostgreSQL integration tests require a separate, verified loopback test database through `ER_TEST_DATABASE_URL`; never use customer records for these checks. Relevant suites cover attribution, redaction, denials, failed or partially persisted operations, export completion/interruption, existing audit records, customer access and payment behavior. Run the full supported Node test suite before release.

## Owner-only Phase 2 mode (local implementation)

See [Dispatch owner access](dispatch-owner-access.md) for private provisioning, MFA, recovery, database-backed sessions, the owner Audit Log and the staging cutover checklist. When explicitly enabled, this mode rejects the shared login and legacy session authority. Deployment and real owner enrollment require separate authorization.

New owner-mode events retain the non-secret session `actorId` and add a stable `staffId`. Existing shared-session events cannot be retrospectively assigned to an individual. New feature-specific audit rows retain their existing session actor; a durable actor-to-owner mapping preserves the named association after revocation.

Owner authentication and recovery successes are stored with their database transaction. The existing post-persistence operational event sink also appends minimized events to the Audit Log in owner mode, deduplicated by request and action. Network finish and a subsequent database append cannot be atomic: abrupt process/storage failure can leave a collection gap. The application does not label a committed business action failed merely because a later log write failed, and an Audit Log entry does not prove delivery to the downloading device. Existing feature-specific histories remain in their protected workflows.

No automatic audit deletion or retention period is introduced. Security-event retention is a separate owner decision from reservation review checkpoints and ledger markers. Staff invitations, custom roles, individual staff management, and verified Render collection/access/retention remain deferred.
