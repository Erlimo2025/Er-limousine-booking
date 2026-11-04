# Customer reviews and administrator approval

This local feature adds invitations for completed trips, one private feedback
page, a compact collapsed Customer Reviews panel in Dispatch, and a homepage
section that is hidden until approved feedback exists. It does not integrate
Google Reviews or publish an average, sample review or invented rating.

## Completion and invitation authority

Only an authenticated Admin Dispatch transition from an eligible non-completed,
non-cancelled status to `completed` can create an invitation. The existing
reservation action lock is retained. PostgreSQL inserts the invitation in the
same transaction as the status update and rechecks the current administrator's
authority. A unique reservation constraint prevents duplicates across requests,
workers, restarts and later completion transitions. Pickup dates, imports, old
Completed rows, browser claims and payment webhooks do not create invitations.
There is no historical backfill. Completing a cancelled record using the legacy
status endpoint does not create an invitation or change existing status rules.

The invitation's delivery recipient is the reservation email at completion. It
cannot be overridden by a request or inferred from an account with matching
email/phone. Neither a review nor an invitation changes account ownership,
reservation credentials, trip data, prices, payments or refunds. Payment is not
a new eligibility condition; an administrator can complete an unpaid legitimate
trip using the existing workflow.

## Hash-only tokens and email delivery

The existing Resend provider and `createBookingEmails` worker process a separate
durable queue in `er_review_invitations`, through the existing startup/timer
`runBookingEmails` loop. Original booking/payment emails and the Admin payment
link queue are unchanged. No separate provider, scheduler, paid service or live
email is introduced for local validation.

One additional **server-only** setting is required before invitation delivery:
`REVIEW_INVITATION_SECRET`, a cryptographically random 32-byte key encoded as
canonical base64url (43 characters). Generate and store it privately at release;
do not commit it, send it to the browser or paste it into logs. This task does
not set production environment variables. Existing `BOOKING_EMAILS_ENABLED`,
Resend API key/from address and `SITE_URL` continue to govern delivery. Missing
or malformed invitation-key configuration, or disabled booking email delivery,
leaves invitations pending and does not prevent completion or affect payment.

A random UUID invitation ID and the independent 256-bit key produce a 256-bit
HMAC-SHA-256 token bound to that invitation and reservation. Invitation/delivery
records store only SHA-256 of the bearer token, never the generated token, review
URL or rendered invitation email payload. The same token/message is reconstructed
in memory after restart, preserving provider idempotency without storing a
recoverable bearer credential. This is a pseudorandom keyed token, not an
account login, booking-access token or payment link.

The worker freezes the recipient at completion and token hash/expiry at first
submission. Tokens expire 30 days after the first delivery attempt. Delivery
uses the same reservation-bound invitation UUID as its stable provider message
key, the existing 60-second lease, exponential retry delay and 23-hour ambiguity
window. Known failures, lost responses and worker recovery retry the identical
message. Delivery older than that window, or a key mismatch after rotation,
requires review instead of generating another invitation. Keep the key, sender
and site origin stable while deliveries are pending. Sent invitation hashes
remain usable until expiry even if the key is subsequently rotated. Automatic
reissue/resend after expiry or delivery review is intentionally not included.

Queued invitations are suppressed for used, expired, cancelled or reactivated
trips. A message already submitted to the email provider cannot be recalled;
both review validation and submission still recheck the current Completed state.
Email delivery failure does not modify the reservation or payment state.

## Feedback, moderation and public output

`/review.html#token=…` receives the token in the URL fragment, which is not sent
to the server in a request URL or Referer. The page immediately removes it from
the displayed history entry and holds it only in memory; no storage or account
cookie is created. Opening the page or email scanning does not consume it.
The no-store/no-referrer/noindex page exposes no private booking information.
The form has unselected 1–5 native radio controls, an optional plain-text comment
up to 2,000 characters, and the discreet `/privacy.html` link before submission.
The policy explains approval/publication, displayed names, delivery and retention.
It opens separately with no opener/referrer so reading it preserves the form.
The form has no public-posting checkbox or publication disclaimer sentence.

`POST /api/reviews/invitation` accepts only a token and returns eligibility,
never customer/trip details. `POST /api/reviews` accepts only token, integer
rating 1–5 and optional comment. Controls, direction overrides and HTML markup
are rejected. Both require exact Origin, JSON, Fetch Metadata checks and rate
limits. One review is accepted atomically per invitation/reservation; valid
duplicate submissions acknowledge success without editing the first feedback.
Every original rating/comment is immutable and starts Pending.

Admin-only endpoints list Pending, Published or Held reviews with bounded
keyset pagination, moderate a versioned review, and read its audit history.
Publication/removal require explicit confirmation; private handling requires a
reason (spam, authenticity, privacy, inappropriate content or customer request).
Publication records that the original feedback was reviewed for authenticity.
The UI instructs administrators to apply the same rules to positive and negative
ratings. There is no rating filter, score-based ordering, automatic approval or
admin editing of customer ratings/comments. Holding/removing never deletes them.

Current admin cookie authorization is checked before and within moderation
transactions, including after writes. Expected versions, row locks and immutable
request-ID audit events prevent stale/conflicting actions and duplicate replay.
The recorded actor is the existing Dispatch session audit ID; the shared-admin
credential architecture is unchanged and does not supply individual staff names.
Original review/invitation authority and moderation events have database triggers
preventing edits/deletion. An expired or revoked admin session has no authority.

Public output is limited to published, currently completed-trip reviews: rating,
optional comment, first name/last initial (or Anonymous) and an opaque review ID.
It excludes reservation references, customer contact details, routes, payment
data, token hashes and moderation information. The API returns at most ten rows
per page; the homepage requests six. It uses no-store responses, bounded cursors,
safe `textContent` rendering and no aggregate or structured-data rating claims.
Administrators must inspect comments for private information before publishing;
the original text is never silently rewritten. Ineligible trips are hidden from
public results even if previously approved.

## Publication privacy screening

The server screens stored comments for recognizable email addresses, phone or
long numeric identifiers, contact links/handles, private references/credentials,
labeled personal/financial identifiers, and common street-address patterns.
Examples include SSN/card-number shapes, IBAN-shaped values, passport/license
references, labeled birth dates, reservation references, UUIDs, Stripe references
and long token-shaped strings. A bounded normalization step recognizes full-width
text, zero-width separators and common `[at]`/`[dot]` or encoded email forms.
Normalization is used only for screening; it never changes stored feedback.
No external detection service, customer data upload or matched-value logging is
introduced. Matching shapes do not establish that a number/credential is valid.
Sensitive text entered by a customer is retained in the restricted original
review record as required; screening does not scrub private database storage.
Those originals need the same restricted access and retention handling as other
private review data. Customers should not enter credentials or private details.

The private Admin response adds computed `privacyBlocked` and `privacyReasons`
metadata with generic reason labels. Dispatch shows a privacy warning and
disables Approve & Publish. There is no override, edit, automatic redaction or
resubmission feature. Flagged feedback starts Pending like other reviews; it
can be held with the existing privacy reason and remains private. Original
ratings/comments and moderation history are retained unchanged. A later safe
resolution requires a separately reviewed change; staff cannot clear the flag.

Every publication request rechecks the current stored comment inside the row-
locked PostgreSQL moderation transaction, before processing idempotent replay
or writing a publication/audit event. A flagged request returns a fixed privacy
error without reflecting sensitive values or changing the review/version.
Reenabling a disabled button, using an older client, replaying an earlier request
ID, changing rating-related inputs or racing other moderation requests cannot
bypass the check. The detector receives only the comment, never the rating.

Public reads screen again, suppressing flagged prior-version publications even
if their stored status is Published. Public responses never include screening
metadata or matched values. Reads inspect at most 200 candidate rows plus one
lookahead per request, preserving bounded keyset pagination through hidden rows.
The homepage can skip up to five initially empty pages to find safe publications;
if none is found in that bounded scan, the review section stays hidden. The
public display, review form, email system, database schema and original booking/
payment behavior are unchanged by this fix. Migration 012 needs no alteration.

**Automated detection cannot guarantee finding every sensitive detail.** It can
miss unusual/obfuscated contacts, context-dependent information, personal names,
unrecognized addresses or identifiers. Conservative matching can also flag
benign text. Manual, rating-neutral authenticity/spam/privacy moderation remains
required for every review, including those with no automated flag. False
positives stay private; there is no bypass. These checks do not certify a
comment as anonymous or safe merely because no pattern matched.

## Migration and rollback

Additive migration **012-customer-reviews.sql** runs inside the existing startup
migration transaction and advisory lock. It adds three review-only tables:
`er_review_invitations` (completion proof, token hash and delivery metadata),
`er_customer_reviews` (original feedback and current moderation state), and
`er_review_moderation_events` (append-only actor/action/reason/version history).
It preserves all existing reservation, payment, refund, customer and email-outbox
tables and data. It performs no historical rewrite, deletion or automatic invite
backfill. Public database privileges are revoked on the new tables.

Rollback should retain the additive tables and audit records. Previous code can
operate on existing reservation/payment schemas and will ignore the new queues.
Reverting the review endpoints makes previously issued review links unavailable;
plan a clear temporary response for those links rather than deleting feedback.
Never delete review/audit history or undo payments as a rollout/rollback step.

## Validation and remaining operating requirements

Tests use synthetic reservations, mocked Google/Stripe/Resend and an isolated
localhost PostgreSQL database. No test sends a real customer email, charges a
card, certifies actual customer feedback or reads production data. Browser tests
cover 320/390/1440px, empty/public states, low ratings, no default selection,
optional comments, confirmations, removal, privacy separation, safe rendering,
CSP and unchanged booking steps. Existing booking/payment browser suites are
also run sequentially.

Before release, configure the new private key and confirm existing Resend sender
configuration, review the public policy, and perform a controlled real-device
invitation test. Inbox deliverability and email-client fragment-link handling
cannot be established by mocked tests. Mailbox possession is the authority for
guest feedback; an incorrect stored email or a forwarded invitation still needs
authenticity moderation. Retention/deletion requests need operator handling;
this feature retains original feedback and audit history by design. Moderation
must remain consistent across ratings; software cannot establish a moderator's
intent. No production configuration has been changed by this implementation.

## Local validation — November 3, 2026

| Selection | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Targeted reviews/email/Admin/payment/security | 245 | 0 | 0 |
| Separate isolated PostgreSQL | 60 | 0 | 0 |
| Full sequential regression | 706 | 0 | 0 |
| Separate CSP/security headers | 5 | 0 | 0 |
| Complete Chromium browser matrix | 143 | 0 | 0 |
| Focused review/privacy browser checks | 9 | 0 | 0 |

Selections overlap and must not be added as a count of distinct tests. The
browser matrix includes nine review cases and 134 existing cases. The focused
focused recheck also opens the policy separately and then submits the preserved
form. All selections ran sequentially. PostgreSQL used the existing isolated
localhost test cluster and a non-superuser test role. Provider calls were mocked;
real inbox delivery, actual customer authenticity and physical iPhone/Android
email-client behavior were not claimed as verified.

The first development run caught a timestamp parameter-type error in the new
PostgreSQL publication update and an invalid-rating test fixture that supplied
a default rating. Both were corrected without weakening validation. Final
results above contain no failing or skipped tests. Screenshot review also
corrected scoped review-section spacing and contrast; existing site CSS remains
unchanged. The scope/credential audit confirms unchanged checkout/webhook code,
pricing, customer authentication, refunds, existing emails and Admin payment
links. No credentials, temporary test files or production configuration are in
the changed file set. No files have been staged, committed, pushed or deployed.

## Changed files (24)

Application/schema:

- `migrations/012-customer-reviews.sql`
- `public/admin.html`
- `public/admin.js`
- `public/admin-reviews.js`
- `public/index.html`
- `public/customer-reviews.css`
- `public/customer-reviews.js`
- `public/privacy.html`
- `public/review.html`
- `routes/customer-reviews.js`
- `server.js`
- `services/customer-reviews.js`
- `storage/customer-reviews.js`
- `storage/postgres.js`

Tests/fixtures:

- `tests/browser/customer-reviews.cjs`
- `tests/customer-reviews.test.cjs`
- `tests/customer-trip-management.test.cjs`
- `tests/helpers/customer-review-memory.cjs`
- `tests/helpers/memory-storage.cjs`
- `tests/helpers/review-fixtures.cjs`
- `tests/security-abuse.test.cjs`
- `tests/seo.test.cjs`
- `tests/storage-postgres.test.cjs`

Documentation: `docs/customer-reviews.md`.

## Privacy-fix change scope

The privacy fix further edits nine files within the existing 24-file uncommitted
feature; no new file, migration, setting, dependency or service is introduced:

- `services/customer-reviews.js`: pure privacy screening, private flags and bounded public projection.
- `storage/customer-reviews.js`: authoritative row-locked publication check and independently filtered public reads.
- `public/admin-reviews.js`: warning, disabled approval and safe disabled-state restoration after errors.
- `public/admin.html`: manual-review reminder in the existing review panel.
- `public/customer-reviews.js`: bounded initial paging through suppressed older publications.
- `tests/helpers/customer-review-memory.cjs`: isolated model of the same publication and public-read protections.
- `tests/customer-reviews.test.cjs`: detector coverage, every star rating, no override/resubmission bypass, stale/replayed/concurrent approvals, public isolation and PostgreSQL regression cases.
- `tests/browser/customer-reviews.cjs`: privacy warnings, forced-button server denial, immutable held feedback and safe pagination at 320/390/1440px.
- `docs/customer-reviews.md`: screening rules, limitations and final results.

All final selections above passed with no failed or skipped tests. The isolated
PostgreSQL cluster was stopped after testing. The scope/credential audit and
`git diff --check` passed. All 24 files remain unstaged; HEAD is unchanged. The
review form, public policy, existing CSS, pricing, payment logic, email provider/
templates and migration 012 retain their previous local implementations.
