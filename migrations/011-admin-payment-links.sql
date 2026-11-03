-- Additive only; the existing startup migration transaction owns this change.
CREATE TABLE IF NOT EXISTS er_admin_payment_links (
 id uuid PRIMARY KEY,
 booking_id uuid NOT NULL REFERENCES er_reservations(id) ON DELETE RESTRICT,
 stripe_session_id text NOT NULL UNIQUE CHECK(stripe_session_id ~ '^cs_[A-Za-z0-9_]{1,180}$'),
 expires_at timestamptz NOT NULL,
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL,
 copied_by uuid,
 copied_at timestamptz,
 email_requested_by uuid,
 email_requested_at timestamptz,
 state text NOT NULL DEFAULT 'not_requested' CHECK(state IN ('not_requested','pending','sending','sent','review_required','inactive')),
 payload jsonb CHECK(payload IS NULL OR (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=65536)),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 claim_token uuid,
 lease_until timestamptz,
 first_submitted_at timestamptz,
 next_attempt_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 sent_at timestamptz,
 UNIQUE(booking_id,stripe_session_id),
 CHECK((state='sending')=(claim_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK((copied_at IS NULL)=(copied_by IS NULL)),
 CHECK((email_requested_at IS NULL)=(email_requested_by IS NULL)),
 CHECK(state NOT IN ('pending','sending') OR (payload IS NOT NULL AND email_requested_at IS NOT NULL)),
 CHECK(state<>'sent' OR (sent_at IS NOT NULL AND payload IS NULL))
);
CREATE INDEX IF NOT EXISTS er_admin_payment_links_due ON er_admin_payment_links(next_attempt_at,id) WHERE state IN ('pending','sending');
REVOKE ALL ON er_admin_payment_links FROM PUBLIC;
INSERT INTO er_schema_migrations(version) VALUES(11) ON CONFLICT DO NOTHING;
