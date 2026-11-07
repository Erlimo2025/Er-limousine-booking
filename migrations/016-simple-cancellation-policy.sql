-- Keep existing settlements and immutable payment records readable.
ALTER TABLE er_managed_cancellations
  ADD COLUMN refunded_before_cents bigint NOT NULL DEFAULT 0 CHECK (refunded_before_cents BETWEEN 0 AND captured_cents);
DO $$
DECLARE item record; found integer:=0;
BEGIN
  FOR item IN SELECT conname FROM pg_constraint
    WHERE conrelid='er_managed_cancellations'::regclass AND contype='c'
      AND regexp_replace(pg_get_expr(conbin,conrelid),'[[:space:]()]','','g')='amount_cents=captured_cents-fee_cents'
  LOOP
    EXECUTE format('ALTER TABLE er_managed_cancellations DROP CONSTRAINT %I',item.conname);
    found:=found+1;
  END LOOP;
  IF found<>1 THEN RAISE EXCEPTION 'Expected one original managed refund amount constraint'; END IF;
END $$;
ALTER TABLE er_managed_cancellations ADD CONSTRAINT er_managed_remaining_amount
  CHECK (amount_cents=captured_cents-fee_cents-refunded_before_cents);

DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT conname FROM pg_constraint
    WHERE conrelid='er_managed_cancellations'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%state%no_refund%'
      AND pg_get_constraintdef(oid) LIKE '%stripe_session_id%'
  LOOP EXECUTE format('ALTER TABLE er_managed_cancellations DROP CONSTRAINT %I',item.conname); END LOOP;
END $$;
ALTER TABLE er_managed_cancellations ADD CONSTRAINT er_managed_refund_source
  CHECK ((state='no_refund' AND amount_cents=0 AND
      ((captured_cents=0 AND stripe_session_id IS NULL AND payment_intent_id IS NULL AND charge_id IS NULL)
      OR (captured_cents=fare_cents AND refunded_before_cents=captured_cents AND stripe_session_id IS NOT NULL AND payment_intent_id IS NOT NULL AND charge_id IS NOT NULL)))
    OR (state<>'no_refund' AND amount_cents>0 AND captured_cents=fare_cents
      AND stripe_session_id IS NOT NULL AND payment_intent_id IS NOT NULL AND charge_id IS NOT NULL));

CREATE FUNCTION er_managed_cancellation_no_new_fees() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fee_percent<>0 OR NEW.fee_cents<>0 OR NEW.origin='dispatch'
  THEN RAISE EXCEPTION 'New cancellation settlements cannot retain a fee'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER er_managed_cancellation_no_new_fees BEFORE INSERT ON er_managed_cancellations
  FOR EACH ROW EXECUTE FUNCTION er_managed_cancellation_no_new_fees();

ALTER TABLE er_reservation_management_requests
  ADD COLUMN cancellation_applied_at timestamptz,
  ADD COLUMN cancellation_status_before text,
  ADD CONSTRAINT er_owner_cancellation_decision CHECK
    ((cancellation_applied_at IS NULL AND cancellation_status_before IS NULL) OR
     (kind='cancellation' AND status='approved' AND cancellation_applied_at=reviewed_at
      AND cancellation_status_before IN ('awaiting_payment','confirmed','assigned','driver_en_route','passenger_on_board','completed')));

CREATE OR REPLACE FUNCTION er_managed_cancellation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.record->>'status'='cancelled'
    AND (NEW.record->>'status' IS DISTINCT FROM 'cancelled' OR NEW.record->'quote' IS DISTINCT FROM OLD.record->'quote')
    AND (EXISTS (SELECT 1 FROM er_managed_cancellations WHERE booking_id=OLD.id)
      OR EXISTS (SELECT 1 FROM er_reservation_management_requests WHERE booking_id=OLD.id AND cancellation_applied_at IS NOT NULL))
  THEN RAISE EXCEPTION 'Managed cancellation cannot be reopened or repriced'; END IF;
  RETURN NEW;
END $$;
INSERT INTO er_schema_migrations(version) VALUES(16);
