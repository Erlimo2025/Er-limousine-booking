-- Existing rows stay unowned; never infer ownership from reservation JSON/contact data.
ALTER TABLE er_reservations ADD COLUMN IF NOT EXISTS customer_id uuid;
ALTER TABLE er_reservations ADD COLUMN IF NOT EXISTS scheduled_start_at timestamptz;
ALTER TABLE er_reservations ADD COLUMN IF NOT EXISTS scheduled_end_at timestamptz;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='er_reservations'::regclass AND conname='er_reservations_customer_fk') THEN
  ALTER TABLE er_reservations ADD CONSTRAINT er_reservations_customer_fk FOREIGN KEY(customer_id) REFERENCES er_customers(id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='er_reservations'::regclass AND conname='er_reservations_schedule_check') THEN
  ALTER TABLE er_reservations ADD CONSTRAINT er_reservations_schedule_check CHECK (
   (scheduled_start_at IS NULL AND scheduled_end_at IS NULL AND customer_id IS NULL) OR
   (scheduled_start_at IS NOT NULL AND scheduled_end_at IS NOT NULL AND scheduled_end_at>=scheduled_start_at));
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS er_reservations_customer_schedule ON er_reservations(customer_id,scheduled_end_at,id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS er_reservations_customer_created ON er_reservations(customer_id,created_at DESC,id) WHERE customer_id IS NOT NULL;
INSERT INTO er_schema_migrations(version) VALUES(6) ON CONFLICT DO NOTHING;
