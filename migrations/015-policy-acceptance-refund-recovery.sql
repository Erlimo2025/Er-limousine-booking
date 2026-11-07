-- Preserve policy evidence and schedule recovery for existing managed refunds.
CREATE FUNCTION er_reservation_policy_acceptance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.record->'cancellationPolicyAcceptance' IS DISTINCT FROM NEW.record->'cancellationPolicyAcceptance'
  THEN RAISE EXCEPTION 'Booking policy acceptance is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER er_reservation_policy_acceptance_immutable BEFORE UPDATE OF record ON er_reservations
  FOR EACH ROW EXECUTE FUNCTION er_reservation_policy_acceptance_immutable();

ALTER TABLE er_managed_cancellations
  ADD COLUMN reconciliation_attempts integer NOT NULL DEFAULT 0 CHECK (reconciliation_attempts>=0),
  ADD COLUMN last_attempt_at timestamptz,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN escalated_at timestamptz;

CREATE OR REPLACE FUNCTION er_managed_cancellation_authority_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cancellation history is immutable'; END IF;
  IF (to_jsonb(OLD) - ARRAY['state','stripe_refund_id','first_submitted_at','submission_count','evidence','updated_at','confirmed_at',
    'reconciliation_attempts','last_attempt_at','next_attempt_at','escalated_at'])
    IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['state','stripe_refund_id','first_submitted_at','submission_count','evidence','updated_at','confirmed_at',
    'reconciliation_attempts','last_attempt_at','next_attempt_at','escalated_at'])
    OR (OLD.stripe_refund_id IS NOT NULL AND OLD.stripe_refund_id IS DISTINCT FROM NEW.stripe_refund_id)
    OR (OLD.first_submitted_at IS NOT NULL AND OLD.first_submitted_at IS DISTINCT FROM NEW.first_submitted_at)
    OR NEW.submission_count<OLD.submission_count OR NEW.reconciliation_attempts<OLD.reconciliation_attempts
    OR (OLD.last_attempt_at IS NOT NULL AND (NEW.last_attempt_at IS NULL OR NEW.last_attempt_at<OLD.last_attempt_at))
    OR (OLD.escalated_at IS NOT NULL AND OLD.escalated_at IS DISTINCT FROM NEW.escalated_at)
    OR (OLD.confirmed_at IS NOT NULL AND OLD.confirmed_at IS DISTINCT FROM NEW.confirmed_at)
  THEN RAISE EXCEPTION 'Cancellation settlement authority is immutable'; END IF;
  RETURN NEW;
END $$;

UPDATE er_managed_cancellations SET next_attempt_at=updated_at
  WHERE state IN ('prepared','submitted_unknown','provider_identified');
ALTER TABLE er_managed_cancellation_events ADD COLUMN actor_id uuid;
CREATE INDEX er_managed_cancellation_due ON er_managed_cancellations(next_attempt_at,created_at,id)
  WHERE state IN ('prepared','submitted_unknown','provider_identified');

INSERT INTO er_schema_migrations(version) VALUES(15);
