-- Additive follow-up to 013. The original fare and original payment ledger are never rewritten.
ALTER TABLE er_reservation_management_requests DROP CONSTRAINT er_reservation_management_requests_kind_check;
ALTER TABLE er_reservation_management_requests ADD CONSTRAINT er_reservation_management_requests_kind_check
  CHECK (kind IN ('pickup_schedule', 'locations', 'cancellation', 'amendment'));

CREATE TABLE er_reservation_change_previews (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES er_reservations(id) ON DELETE CASCADE,
  revision text NOT NULL CHECK (revision ~ '^[a-f0-9]{64}$'),
  reservation_revision text NOT NULL CHECK (reservation_revision ~ '^[a-f0-9]{64}$'),
  details jsonb NOT NULL CHECK (jsonb_typeof(details)='object' AND octet_length(details::text)<=2500),
  expires_at timestamptz NOT NULL
);
CREATE INDEX er_reservation_change_previews_expiry ON er_reservation_change_previews(expires_at);

CREATE TABLE er_managed_cancellations (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL UNIQUE REFERENCES er_reservations(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  terms_revision text NOT NULL CHECK (terms_revision ~ '^[a-f0-9]{64}$'),
  origin text NOT NULL CHECK (origin IN ('guest','account','dispatch')),
  review_request_id uuid UNIQUE REFERENCES er_reservation_management_requests(id) ON DELETE RESTRICT,
  reviewer_id uuid,
  verification_note text CHECK (char_length(verification_note) BETWEEN 10 AND 240),
  pickup_at timestamptz NOT NULL,
  fare_cents bigint NOT NULL CHECK (fare_cents BETWEEN 1 AND 9007199254740991),
  captured_cents bigint NOT NULL CHECK (captured_cents IN (0,fare_cents)),
  fee_percent smallint NOT NULL CHECK (fee_percent IN (0,10,25,50)),
  fee_cents bigint NOT NULL CHECK (fee_cents=(fare_cents*fee_percent+50)/100),
  amount_cents bigint NOT NULL CHECK (amount_cents=captured_cents-fee_cents),
  currency text NOT NULL CHECK (currency='usd'),
  stripe_session_id text CHECK (stripe_session_id ~ '^cs_[A-Za-z0-9_]{1,180}$'),
  payment_intent_id text CHECK (payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,180}$'),
  charge_id text CHECK (charge_id ~ '^ch_[A-Za-z0-9_]{1,180}$'),
  idempotency_key text NOT NULL UNIQUE CHECK (idempotency_key='er-managed-cancel-' || id::text),
  state text NOT NULL CHECK (state IN ('no_refund','prepared','submitted_unknown','provider_identified','confirmed','review_required','failed')),
  stripe_refund_id text UNIQUE CHECK (stripe_refund_id ~ '^re_[A-Za-z0-9_]{1,180}$'),
  first_submitted_at timestamptz,
  submission_count integer NOT NULL DEFAULT 0 CHECK (submission_count>=0),
  evidence text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  CHECK ((origin='dispatch' AND fee_percent=50 AND review_request_id IS NOT NULL AND reviewer_id IS NOT NULL AND verification_note IS NOT NULL)
    OR (origin<>'dispatch' AND fee_percent<>50 AND review_request_id IS NULL AND reviewer_id IS NULL AND verification_note IS NULL)),
  CHECK ((state='no_refund' AND amount_cents=0 AND captured_cents=0 AND stripe_session_id IS NULL AND payment_intent_id IS NULL AND charge_id IS NULL)
    OR (state<>'no_refund' AND amount_cents>0 AND captured_cents=fare_cents AND stripe_session_id IS NOT NULL AND payment_intent_id IS NOT NULL AND charge_id IS NOT NULL)),
  CHECK (state<>'confirmed' OR confirmed_at IS NOT NULL),
  CHECK (state NOT IN ('provider_identified','confirmed','failed') OR stripe_refund_id IS NOT NULL),
  CHECK ((submission_count=0)=(first_submitted_at IS NULL))
);
CREATE INDEX er_managed_cancellation_reconciliation ON er_managed_cancellations(updated_at,id)
  WHERE state IN ('prepared','submitted_unknown','provider_identified');

CREATE TABLE er_managed_cancellation_events (
  id uuid PRIMARY KEY,
  cancellation_id uuid NOT NULL REFERENCES er_managed_cancellations(id) ON DELETE RESTRICT,
  state text NOT NULL,
  evidence text NOT NULL,
  stripe_event_id text UNIQUE CHECK (stripe_event_id ~ '^evt_[A-Za-z0-9_]{1,180}$'),
  created_at timestamptz NOT NULL
);
CREATE TRIGGER er_managed_cancellation_event_immutable BEFORE UPDATE OR DELETE ON er_managed_cancellation_events
  FOR EACH ROW EXECUTE FUNCTION er_customer_trip_event_immutable();

CREATE FUNCTION er_managed_cancellation_authority_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cancellation history is immutable'; END IF;
  IF (to_jsonb(OLD) - ARRAY['state','stripe_refund_id','first_submitted_at','submission_count','evidence','updated_at','confirmed_at'])
    IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['state','stripe_refund_id','first_submitted_at','submission_count','evidence','updated_at','confirmed_at'])
    OR (OLD.stripe_refund_id IS NOT NULL AND OLD.stripe_refund_id IS DISTINCT FROM NEW.stripe_refund_id)
    OR (OLD.first_submitted_at IS NOT NULL AND OLD.first_submitted_at IS DISTINCT FROM NEW.first_submitted_at)
    OR NEW.submission_count<OLD.submission_count
    OR (OLD.confirmed_at IS NOT NULL AND OLD.confirmed_at IS DISTINCT FROM NEW.confirmed_at)
  THEN RAISE EXCEPTION 'Cancellation settlement authority is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER er_managed_cancellation_authority_immutable BEFORE UPDATE OR DELETE ON er_managed_cancellations
  FOR EACH ROW EXECUTE FUNCTION er_managed_cancellation_authority_immutable();

-- Keep a settled cancellation closed even when an older application is running.
CREATE FUNCTION er_managed_cancellation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.record->>'status'='cancelled'
    AND (NEW.record->>'status' IS DISTINCT FROM 'cancelled' OR NEW.record->'quote' IS DISTINCT FROM OLD.record->'quote')
    AND EXISTS (SELECT 1 FROM er_managed_cancellations WHERE booking_id=OLD.id)
  THEN RAISE EXCEPTION 'Managed cancellation cannot be reopened or repriced'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER er_managed_cancellation_guard BEFORE UPDATE OF record ON er_reservations
  FOR EACH ROW EXECUTE FUNCTION er_managed_cancellation_guard();

REVOKE ALL ON er_reservation_change_previews, er_managed_cancellations, er_managed_cancellation_events FROM PUBLIC;
INSERT INTO er_schema_migrations(version) VALUES(14);
