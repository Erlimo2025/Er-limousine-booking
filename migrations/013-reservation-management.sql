-- Reservation-management credentials and decisions are separate from booking records.
CREATE TABLE IF NOT EXISTS er_reservation_management_access (
  booking_id uuid PRIMARY KEY REFERENCES er_reservations(id) ON DELETE CASCADE,
  link_hash text NOT NULL UNIQUE CHECK (link_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > issued_at),
  used_at timestamptz,
  window_started_at timestamptz NOT NULL CHECK (window_started_at <= issued_at),
  issued_count integer NOT NULL CHECK (issued_count BETWEEN 1 AND 4),
  grant_hash text UNIQUE CHECK (grant_hash ~ '^[0-9a-f]{64}$'),
  grant_expires_at timestamptz,
  CHECK ((grant_hash IS NULL) = (grant_expires_at IS NULL))
);

CREATE TABLE IF NOT EXISTS er_reservation_management_requests (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES er_reservations(id) ON DELETE RESTRICT,
  customer_id uuid REFERENCES er_customers(id) ON DELETE RESTRICT,
  client_request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pickup_schedule', 'locations', 'cancellation')),
  details jsonb NOT NULL CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 2500),
  trip_hash text NOT NULL CHECK (trip_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  reviewed_at timestamptz,
  reviewer_id uuid,
  UNIQUE (booking_id, client_request_id),
  CHECK ((status = 'pending' AND reviewed_at IS NULL AND reviewer_id IS NULL)
      OR (status <> 'pending' AND reviewed_at IS NOT NULL AND reviewed_at >= created_at AND reviewer_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS er_reservation_management_pending
  ON er_reservation_management_requests(booking_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS er_reservation_management_history
  ON er_reservation_management_requests(booking_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS er_reservation_management_queue
  ON er_reservation_management_requests(status, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION er_reservation_management_request_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Reservation request history is immutable';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'declined')
    OR ROW(NEW.id, NEW.booking_id, NEW.customer_id, NEW.client_request_id, NEW.kind, NEW.details, NEW.trip_hash, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.booking_id, OLD.customer_id, OLD.client_request_id, OLD.kind, OLD.details, OLD.trip_hash, OLD.created_at)
  THEN
    RAISE EXCEPTION 'Reservation request history is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS er_reservation_management_request_history ON er_reservation_management_requests;
CREATE TRIGGER er_reservation_management_request_history
  BEFORE UPDATE OR DELETE ON er_reservation_management_requests
  FOR EACH ROW EXECUTE FUNCTION er_reservation_management_request_history();

REVOKE ALL ON er_reservation_management_access, er_reservation_management_requests FROM PUBLIC;
INSERT INTO er_schema_migrations(version) VALUES (13) ON CONFLICT DO NOTHING;
