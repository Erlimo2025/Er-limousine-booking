CREATE TABLE IF NOT EXISTS er_schema_migrations (
  version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS er_reservations (
  id uuid PRIMARY KEY,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (record->>'id' = id::text)
);
CREATE INDEX IF NOT EXISTS er_reservations_created ON er_reservations (created_at DESC);
CREATE INDEX IF NOT EXISTS er_reservations_checkout ON er_reservations ((record->>'checkoutFingerprint'));
CREATE TABLE IF NOT EXISTS er_storage_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN ('legacy_import')),
  inserted_count integer NOT NULL, skipped_count integer NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS er_payment_ledger (
  booking_id uuid PRIMARY KEY, amount_cents bigint NOT NULL CHECK(amount_cents > 0),
  currency text NOT NULL, stripe_session_id text, paid_at timestamptz NOT NULL,
  retain_until timestamptz NOT NULL, legal_hold boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS er_paid_ride_eligibility (
  booking_id uuid PRIMARY KEY, email_hash text, phone_hash text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS er_paid_ride_email ON er_paid_ride_eligibility (email_hash);
CREATE INDEX IF NOT EXISTS er_paid_ride_phone ON er_paid_ride_eligibility (phone_hash);
REVOKE ALL ON er_reservations, er_storage_audit, er_payment_ledger, er_paid_ride_eligibility, er_schema_migrations FROM PUBLIC;
INSERT INTO er_schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS er_first_ride_claims (
  identity_hash text PRIMARY KEY CHECK(identity_hash ~ '^[a-f0-9]{64}$'),
  booking_id uuid NOT NULL REFERENCES er_reservations(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS er_first_ride_claim_booking ON er_first_ride_claims(booking_id);
REVOKE ALL ON er_first_ride_claims FROM PUBLIC;
INSERT INTO er_schema_migrations (version) VALUES (2) ON CONFLICT DO NOTHING;
