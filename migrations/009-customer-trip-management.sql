-- Existing startup migration transaction/advisory lock owns this migration.
CREATE TABLE IF NOT EXISTS er_customer_trip_events (
 id uuid PRIMARY KEY,
 booking_id uuid NOT NULL REFERENCES er_reservations(id) ON DELETE RESTRICT,
 customer_id uuid NOT NULL REFERENCES er_customers(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('pickup_time_changed','customer_cancelled')),
 old_start_at timestamptz NOT NULL,
 new_start_at timestamptz NOT NULL,
 old_end_at timestamptz NOT NULL,
 new_end_at timestamptz NOT NULL,
 details jsonb NOT NULL CHECK(jsonb_typeof(details)='object' AND octet_length(details::text)<=4096),
 created_at timestamptz NOT NULL,
 UNIQUE(booking_id,customer_id,request_id),
 UNIQUE(id,booking_id)
);
CREATE INDEX IF NOT EXISTS er_customer_trip_events_history ON er_customer_trip_events(booking_id,created_at,id);
CREATE OR REPLACE FUNCTION er_customer_trip_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Trip event history is immutable'; END $$;
DROP TRIGGER IF EXISTS er_customer_trip_event_immutable ON er_customer_trip_events;
CREATE TRIGGER er_customer_trip_event_immutable BEFORE UPDATE OR DELETE ON er_customer_trip_events FOR EACH ROW EXECUTE FUNCTION er_customer_trip_event_immutable();

ALTER TABLE er_booking_email_outbox ADD COLUMN IF NOT EXISTS event_id uuid;
ALTER TABLE er_booking_email_outbox DROP CONSTRAINT IF EXISTS er_booking_email_outbox_kind_check;
ALTER TABLE er_booking_email_outbox ADD CONSTRAINT er_booking_email_outbox_kind_check CHECK(kind IN ('reservation_created','customer_reservation_created','payment_confirmed','admin_payment_confirmed','customer_pickup_time_updated','admin_pickup_time_updated','customer_trip_cancelled','admin_trip_cancelled','customer_refund_confirmed','admin_refund_confirmed','customer_refund_review','admin_refund_review'));
ALTER TABLE er_booking_email_outbox DROP CONSTRAINT IF EXISTS er_booking_email_outbox_booking_id_kind_key;
CREATE UNIQUE INDEX IF NOT EXISTS er_booking_email_original_event ON er_booking_email_outbox(booking_id,kind) WHERE event_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS er_booking_email_trip_event ON er_booking_email_outbox(event_id,kind) WHERE event_id IS NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='er_booking_email_outbox'::regclass AND conname='er_booking_email_trip_event_fk') THEN
  ALTER TABLE er_booking_email_outbox ADD CONSTRAINT er_booking_email_trip_event_fk FOREIGN KEY(event_id,booking_id) REFERENCES er_customer_trip_events(id,booking_id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='er_booking_email_outbox'::regclass AND conname='er_booking_email_event_scope') THEN
  ALTER TABLE er_booking_email_outbox ADD CONSTRAINT er_booking_email_event_scope CHECK((event_id IS NULL)=(kind IN ('reservation_created','customer_reservation_created','payment_confirmed','admin_payment_confirmed')));
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS er_reservation_refunds (
 id uuid PRIMARY KEY,
 booking_id uuid NOT NULL UNIQUE REFERENCES er_reservations(id) ON DELETE RESTRICT,
 customer_id uuid NOT NULL REFERENCES er_customers(id) ON DELETE RESTRICT,
 trip_event_id uuid NOT NULL,
 stripe_session_id text NOT NULL CHECK(stripe_session_id ~ '^cs_[A-Za-z0-9_]{1,180}$'),
 payment_intent_id text NOT NULL CHECK(payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,180}$'),
 charge_id text NOT NULL CHECK(charge_id ~ '^ch_[A-Za-z0-9_]{1,180}$'),
 amount_cents bigint NOT NULL CHECK(amount_cents>0),
 currency text NOT NULL CHECK(currency='usd'),
 idempotency_key text NOT NULL UNIQUE CHECK(idempotency_key='er-refund-' || id::text),
 state text NOT NULL CHECK(state IN ('prepared','submitted_unknown','provider_identified','confirmed','review_required','failed')),
 stripe_refund_id text UNIQUE CHECK(stripe_refund_id ~ '^re_[A-Za-z0-9_]{1,180}$'),
 first_submitted_at timestamptz,
 submission_count integer NOT NULL DEFAULT 0 CHECK(submission_count>=0),
 evidence text NOT NULL CHECK(evidence IN ('prepared','submitted','provider_pending','provider_succeeded_awaiting_webhook','provider_failed','provider_canceled','ambiguous_provider_error','idempotency_window_expired','webhook_pending','webhook_confirmed','webhook_failed','webhook_canceled')),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 confirmed_at timestamptz,
 FOREIGN KEY(trip_event_id,booking_id) REFERENCES er_customer_trip_events(id,booking_id) ON DELETE RESTRICT,
 FOREIGN KEY(booking_id) REFERENCES er_payment_ledger(booking_id) ON DELETE RESTRICT,
 CHECK(state<>'confirmed' OR confirmed_at IS NOT NULL),
 CHECK(state NOT IN ('provider_identified','confirmed','failed') OR stripe_refund_id IS NOT NULL),
 CHECK((submission_count=0)=(first_submitted_at IS NULL))
);
DO $refund_schema$
DECLARE constraint_name text;
BEGIN
 FOR constraint_name IN SELECT conname FROM pg_constraint WHERE conrelid='er_reservation_refunds'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%confirmed_at%'
 LOOP EXECUTE format('ALTER TABLE er_reservation_refunds DROP CONSTRAINT %I',constraint_name); END LOOP;
END;
$refund_schema$;
ALTER TABLE er_reservation_refunds ADD CONSTRAINT er_reservation_refund_confirmed_timestamp CHECK(state<>'confirmed' OR confirmed_at IS NOT NULL);
ALTER TABLE er_reservation_refunds DROP CONSTRAINT IF EXISTS er_reservation_refunds_evidence_check;
ALTER TABLE er_reservation_refunds ADD CONSTRAINT er_reservation_refunds_evidence_check CHECK(evidence IN ('prepared','submitted','provider_pending','provider_succeeded_awaiting_webhook','provider_failed','provider_canceled','ambiguous_provider_error','idempotency_window_expired','webhook_pending','webhook_confirmed','webhook_failed','webhook_canceled'));
CREATE INDEX IF NOT EXISTS er_reservation_refund_reconciliation ON er_reservation_refunds(updated_at,id) WHERE state IN ('prepared','submitted_unknown','provider_identified');
CREATE OR REPLACE FUNCTION er_reservation_refund_authority_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.id,OLD.booking_id,OLD.customer_id,OLD.trip_event_id,OLD.stripe_session_id,OLD.payment_intent_id,OLD.charge_id,OLD.amount_cents,OLD.currency,OLD.idempotency_key,OLD.created_at)
  IS DISTINCT FROM (NEW.id,NEW.booking_id,NEW.customer_id,NEW.trip_event_id,NEW.stripe_session_id,NEW.payment_intent_id,NEW.charge_id,NEW.amount_cents,NEW.currency,NEW.idempotency_key,NEW.created_at)
  OR (OLD.stripe_refund_id IS NOT NULL AND OLD.stripe_refund_id IS DISTINCT FROM NEW.stripe_refund_id)
  OR (OLD.first_submitted_at IS NOT NULL AND OLD.first_submitted_at IS DISTINCT FROM NEW.first_submitted_at)
  OR NEW.submission_count<OLD.submission_count
  OR (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at)
 THEN RAISE EXCEPTION 'Refund authority is immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS er_reservation_refund_authority_immutable ON er_reservation_refunds;
CREATE TRIGGER er_reservation_refund_authority_immutable BEFORE UPDATE ON er_reservation_refunds FOR EACH ROW EXECUTE FUNCTION er_reservation_refund_authority_immutable();
CREATE TABLE IF NOT EXISTS er_reservation_refund_events (
 id uuid PRIMARY KEY,
 refund_id uuid NOT NULL REFERENCES er_reservation_refunds(id) ON DELETE RESTRICT,
 state text NOT NULL CHECK(state IN ('prepared','submitted_unknown','provider_identified','confirmed','review_required','failed')),
 evidence text NOT NULL CHECK(evidence IN ('prepared','submitted','provider_pending','provider_succeeded_awaiting_webhook','provider_failed','provider_canceled','ambiguous_provider_error','idempotency_window_expired','webhook_pending','webhook_confirmed','webhook_failed','webhook_canceled')),
 stripe_event_id text CHECK(stripe_event_id ~ '^evt_[A-Za-z0-9_]{1,180}$'),
 created_at timestamptz NOT NULL
);
ALTER TABLE er_reservation_refund_events DROP CONSTRAINT IF EXISTS er_reservation_refund_events_evidence_check;
ALTER TABLE er_reservation_refund_events ADD CONSTRAINT er_reservation_refund_events_evidence_check CHECK(evidence IN ('prepared','submitted','provider_pending','provider_succeeded_awaiting_webhook','provider_failed','provider_canceled','ambiguous_provider_error','idempotency_window_expired','webhook_pending','webhook_confirmed','webhook_failed','webhook_canceled'));
CREATE UNIQUE INDEX IF NOT EXISTS er_reservation_refund_webhook_event ON er_reservation_refund_events(stripe_event_id) WHERE stripe_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS er_reservation_refund_history ON er_reservation_refund_events(refund_id,created_at,id);
DROP TRIGGER IF EXISTS er_reservation_refund_event_immutable ON er_reservation_refund_events;
CREATE TRIGGER er_reservation_refund_event_immutable BEFORE UPDATE OR DELETE ON er_reservation_refund_events FOR EACH ROW EXECUTE FUNCTION er_customer_trip_event_immutable();
REVOKE ALL ON er_customer_trip_events FROM PUBLIC;
REVOKE ALL ON er_reservation_refunds,er_reservation_refund_events FROM PUBLIC;
INSERT INTO er_schema_migrations(version) VALUES(9) ON CONFLICT DO NOTHING;
