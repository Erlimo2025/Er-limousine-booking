-- Existing accounts retain their IDs, access, and unverified legacy status.
ALTER TABLE er_customers ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS er_customer_enrollments (
 browser_hash text PRIMARY KEY CHECK(browser_hash ~ '^[a-f0-9]{64}$'),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 full_name text NOT NULL CHECK(char_length(full_name) BETWEEN 2 AND 120),
 normalized_email text NOT NULL CHECK(char_length(normalized_email) BETWEEN 3 AND 254),
 display_email text NOT NULL CHECK(char_length(display_email) BETWEEN 3 AND 254),
 normalized_phone text NOT NULL CHECK(normalized_phone ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
 password_hash text NOT NULL CHECK(char_length(password_hash) BETWEEN 1 AND 255),
 expires_at timestamptz NOT NULL,
 draft_expires_at timestamptz NOT NULL,
 confirmation_attempts integer NOT NULL DEFAULT 0 CHECK(confirmation_attempts BETWEEN 0 AND 8),
 delivery_state text NOT NULL CHECK(delivery_state IN ('pending','sent','failed')),
 CHECK(expires_at<=draft_expires_at)
);
CREATE INDEX IF NOT EXISTS er_customer_enrollments_expiry ON er_customer_enrollments(draft_expires_at);

CREATE TABLE IF NOT EXISTS er_customer_email_challenges (
 customer_id uuid PRIMARY KEY REFERENCES er_customers(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 normalized_email text NOT NULL CHECK(char_length(normalized_email) BETWEEN 3 AND 254),
 expires_at timestamptz NOT NULL,
 delivery_state text NOT NULL CHECK(delivery_state IN ('pending','sent','failed'))
);
CREATE INDEX IF NOT EXISTS er_customer_email_challenges_expiry ON er_customer_email_challenges(expires_at);

CREATE TABLE IF NOT EXISTS er_customer_enrollment_limits (
 scope text NOT NULL CHECK(scope IN ('source','email')),
 identity_hash text NOT NULL CHECK(identity_hash ~ '^[a-f0-9]{64}$'),
 attempts integer NOT NULL CHECK(attempts>0),
 expires_at timestamptz NOT NULL,
 next_allowed_at timestamptz NOT NULL,
 PRIMARY KEY(scope,identity_hash)
);
CREATE INDEX IF NOT EXISTS er_customer_enrollment_limits_expiry ON er_customer_enrollment_limits(expires_at);

REVOKE ALL ON er_customer_enrollments,er_customer_email_challenges,er_customer_enrollment_limits FROM PUBLIC;
INSERT INTO er_schema_migrations(version) VALUES(19) ON CONFLICT DO NOTHING;
