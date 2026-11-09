-- Protect the policy recorded at booking alongside historical acceptance evidence.
CREATE OR REPLACE FUNCTION er_reservation_policy_acceptance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.record->'cancellationPolicyAcceptance' IS DISTINCT FROM NEW.record->'cancellationPolicyAcceptance'
  THEN RAISE EXCEPTION 'Booking policy acceptance is immutable'; END IF;
  IF OLD.record->'cancellationPolicyAtBooking' IS DISTINCT FROM NEW.record->'cancellationPolicyAtBooking'
  THEN RAISE EXCEPTION 'Booking cancellation policy is immutable'; END IF;
  RETURN NEW;
END $$;

INSERT INTO er_schema_migrations(version) VALUES(17);
