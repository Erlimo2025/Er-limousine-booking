CREATE TABLE IF NOT EXISTS er_customer_recovery (
 challenge_hash text PRIMARY KEY CHECK(challenge_hash ~ '^[a-f0-9]{64}$'),
 customer_id uuid REFERENCES er_customers(id) ON DELETE CASCADE,
 identity_hash text NOT NULL CHECK(identity_hash ~ '^[a-f0-9]{64}$'),
 code_verifier text NOT NULL CHECK(code_verifier ~ '^[a-f0-9]{64}$'),
 reset_hash text UNIQUE CHECK(reset_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 verified_at timestamptz,
 consumed_at timestamptz,
 failed_attempts integer NOT NULL DEFAULT 0 CHECK(failed_attempts BETWEEN 0 AND 5),
 delivery_state text NOT NULL CHECK(delivery_state IN ('pending','sent','failed')),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '10 minutes')
);
CREATE INDEX IF NOT EXISTS er_customer_recovery_customer ON er_customer_recovery(customer_id);
CREATE INDEX IF NOT EXISTS er_customer_recovery_expiry ON er_customer_recovery(expires_at);
CREATE TABLE IF NOT EXISTS er_customer_recovery_limits (
 scope text NOT NULL CHECK(scope IN ('phone','client')),
 identity_hash text NOT NULL CHECK(identity_hash ~ '^[a-f0-9]{64}$'),
 requests integer NOT NULL CHECK(requests>0),
 reset_at timestamptz NOT NULL,
 last_sent_at timestamptz,
 PRIMARY KEY(scope,identity_hash)
);
REVOKE ALL ON er_customer_recovery,er_customer_recovery_limits FROM PUBLIC;
INSERT INTO er_schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING;
