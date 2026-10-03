-- Runs inside the existing migration transaction and advisory lock.
CREATE TABLE IF NOT EXISTS er_customers (
 id uuid PRIMARY KEY,
 full_name text NOT NULL CHECK(char_length(full_name) BETWEEN 2 AND 120),
 normalized_email text NOT NULL UNIQUE CHECK(char_length(normalized_email)<=254),
 display_email text NOT NULL,
 normalized_phone text NOT NULL UNIQUE CHECK(normalized_phone ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
 display_phone text NOT NULL,
 password_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 account_status text NOT NULL DEFAULT 'active' CHECK(account_status IN ('active','disabled'))
);
CREATE TABLE IF NOT EXISTS er_customer_sessions (
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 customer_id uuid NOT NULL REFERENCES er_customers(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 last_used_at timestamptz NOT NULL DEFAULT now(),
 CHECK(expires_at>created_at)
);
CREATE INDEX IF NOT EXISTS er_customer_sessions_customer ON er_customer_sessions(customer_id);
CREATE INDEX IF NOT EXISTS er_customer_sessions_expiry ON er_customer_sessions(expires_at);
-- Shared counters prevent rotating IPs/workers from bypassing identity throttling.
CREATE TABLE IF NOT EXISTS er_customer_auth_limits (
 identity_hash text PRIMARY KEY CHECK(identity_hash ~ '^[a-f0-9]{64}$'),
 attempts integer NOT NULL CHECK(attempts>0),
 reset_at timestamptz NOT NULL
);
REVOKE ALL ON er_customers,er_customer_sessions,er_customer_auth_limits FROM PUBLIC;
INSERT INTO er_schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
