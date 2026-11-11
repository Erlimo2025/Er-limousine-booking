-- A customer-facing label, separate from the UUID used by all relationships.
ALTER TABLE er_reservations
  ADD COLUMN booking_reference text,
  ADD CONSTRAINT er_reservations_booking_reference_format
    CHECK (booking_reference IS NULL OR (length(booking_reference) = 9 AND booking_reference ~ '^ER-[0-9]{6}$')),
  ADD CONSTRAINT er_reservations_booking_reference_key UNIQUE (booking_reference);

CREATE INDEX er_reservations_missing_booking_reference
  ON er_reservations (created_at, id) WHERE booking_reference IS NULL;

CREATE FUNCTION er_keep_booking_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.booking_reference IS NOT NULL AND OLD.booking_reference IS DISTINCT FROM NEW.booking_reference
  THEN RAISE EXCEPTION 'Booking reference is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER er_keep_booking_reference
  BEFORE UPDATE OF booking_reference ON er_reservations
  FOR EACH ROW EXECUTE FUNCTION er_keep_booking_reference();

INSERT INTO er_schema_migrations(version) VALUES(18);
