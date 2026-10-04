-- Runs inside the existing migration transaction/advisory lock. Preserve migration 004.
ALTER TABLE er_customer_recovery ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'sms';
ALTER TABLE er_customer_recovery ADD COLUMN IF NOT EXISTS email_token_hash text;
ALTER TABLE er_customer_recovery ALTER COLUMN code_verifier DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS er_customer_recovery_email_token ON er_customer_recovery(email_token_hash);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='er_customer_recovery'::regclass AND conname='er_recovery_method_check') THEN
  ALTER TABLE er_customer_recovery ADD CONSTRAINT er_recovery_method_check CHECK (
   (method='sms' AND email_token_hash IS NULL AND code_verifier IS NOT NULL) OR
   (method='email_link' AND code_verifier IS NULL AND email_token_hash ~ '^[a-f0-9]{64}$' AND email_token_hash IS NOT NULL));
 END IF;
END $$;
ALTER TABLE er_customer_recovery_limits DROP CONSTRAINT IF EXISTS er_customer_recovery_limits_scope_check;
ALTER TABLE er_customer_recovery_limits ADD CONSTRAINT er_customer_recovery_limits_scope_check CHECK(scope IN ('phone','client','email'));
-- SMS credentials, including already verified grants, must never survive the transition.
UPDATE er_customer_recovery SET consumed_at=COALESCE(consumed_at,CURRENT_TIMESTAMP),reset_hash=NULL WHERE method='sms';
INSERT INTO er_schema_migrations(version) VALUES(5) ON CONFLICT DO NOTHING;
