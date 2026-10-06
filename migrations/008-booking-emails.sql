-- Runs inside the existing migration transaction/advisory lock.
CREATE TABLE IF NOT EXISTS er_booking_email_outbox (
 id uuid PRIMARY KEY,
 booking_id uuid NOT NULL REFERENCES er_reservations(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('reservation_created','customer_reservation_created','payment_confirmed','admin_payment_confirmed')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','review_required')),
 payload jsonb CHECK(payload IS NULL OR (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=65536)),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 claim_token uuid,
 lease_until timestamptz,
 first_submitted_at timestamptz,
 next_attempt_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 sent_at timestamptz,
 UNIQUE(booking_id,kind),
 CHECK((state='sending')=(claim_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK(state<>'sent' OR (sent_at IS NOT NULL AND payload IS NULL))
);
-- Keep repeated local application of this not-yet-deployed migration compatible.
ALTER TABLE er_booking_email_outbox DROP CONSTRAINT IF EXISTS er_booking_email_outbox_kind_check;
ALTER TABLE er_booking_email_outbox ADD CONSTRAINT er_booking_email_outbox_kind_check CHECK(kind IN ('reservation_created','customer_reservation_created','payment_confirmed','admin_payment_confirmed'));
CREATE INDEX IF NOT EXISTS er_booking_email_due ON er_booking_email_outbox(next_attempt_at,id) WHERE state IN ('pending','sending');
REVOKE ALL ON er_booking_email_outbox FROM PUBLIC;
INSERT INTO er_schema_migrations(version) VALUES(8) ON CONFLICT DO NOTHING;
