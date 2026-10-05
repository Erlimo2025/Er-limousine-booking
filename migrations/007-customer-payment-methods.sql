-- Executed inside the existing migration transaction/advisory lock.
CREATE TABLE IF NOT EXISTS er_customer_payment_mappings (
 customer_id uuid PRIMARY KEY REFERENCES er_customers(id) ON DELETE RESTRICT,
 stripe_customer_id text UNIQUE CHECK(stripe_customer_id ~ '^cus_[A-Za-z0-9_]{1,120}$'),
 provisioning_id uuid NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','submitted_unknown','ready','review_required')),
 livemode boolean,
 first_submitted_at timestamptz,
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 last_setup_at timestamptz,
 CHECK((state='ready')=(stripe_customer_id IS NOT NULL)),
 CHECK((stripe_customer_id IS NULL)=(livemode IS NULL))
);
CREATE TABLE IF NOT EXISTS er_customer_payment_setups (
 id uuid PRIMARY KEY,
 customer_id uuid NOT NULL REFERENCES er_customer_payment_mappings(customer_id) ON DELETE RESTRICT,
 stripe_setup_id text UNIQUE CHECK(stripe_setup_id ~ '^seti_[A-Za-z0-9_]{1,120}$'),
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','submitted_unknown','identified','succeeded','cancelled','review_required')),
 consent_at timestamptz NOT NULL,
 first_submitted_at timestamptz,
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 CHECK(expires_at>created_at),
 CHECK(state NOT IN ('identified','succeeded') OR stripe_setup_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS er_customer_payment_setup_active ON er_customer_payment_setups(customer_id)
 WHERE state IN ('prepared','submitted_unknown','identified','review_required');
CREATE INDEX IF NOT EXISTS er_customer_payment_setup_owner ON er_customer_payment_setups(customer_id,created_at DESC);
CREATE TABLE IF NOT EXISTS er_customer_payment_limits (
 identity_hash text PRIMARY KEY CHECK(identity_hash ~ '^[a-f0-9]{64}$'),
 attempts integer NOT NULL CHECK(attempts>0),
 reset_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS er_customer_payment_limits_expiry ON er_customer_payment_limits(reset_at,identity_hash);
REVOKE ALL ON er_customer_payment_mappings,er_customer_payment_setups,er_customer_payment_limits FROM PUBLIC;
INSERT INTO er_schema_migrations(version) VALUES(7) ON CONFLICT DO NOTHING;
