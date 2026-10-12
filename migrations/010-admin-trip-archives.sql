-- Dispatch visibility only. Historical reservation JSON and ownership stay untouched.
ALTER TABLE er_reservations ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE er_reservations ADD COLUMN IF NOT EXISTS archived_by uuid;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='er_reservations'::regclass AND conname='er_reservations_archive_pair') THEN
  ALTER TABLE er_reservations ADD CONSTRAINT er_reservations_archive_pair CHECK ((archived_at IS NULL) = (archived_by IS NULL));
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS er_reservations_archived_schedule ON er_reservations(scheduled_start_at,id) WHERE archived_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS er_admin_trip_archive_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 booking_id uuid NOT NULL REFERENCES er_reservations(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('archive','restore')),
 actor_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL,
 changed boolean NOT NULL,
 UNIQUE(booking_id,request_id)
);
CREATE INDEX IF NOT EXISTS er_admin_trip_archive_events_booking ON er_admin_trip_archive_events(booking_id,id);
CREATE OR REPLACE FUNCTION er_admin_trip_archive_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Archive audit events are immutable'; END $$;
DROP TRIGGER IF EXISTS er_admin_trip_archive_event_immutable ON er_admin_trip_archive_events;
CREATE TRIGGER er_admin_trip_archive_event_immutable BEFORE UPDATE OR DELETE ON er_admin_trip_archive_events FOR EACH ROW EXECUTE FUNCTION er_admin_trip_archive_event_immutable();
REVOKE ALL ON er_admin_trip_archive_events FROM PUBLIC;
INSERT INTO er_schema_migrations(version) VALUES(10) ON CONFLICT DO NOTHING;
