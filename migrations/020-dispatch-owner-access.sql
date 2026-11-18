-- Dedicated Dispatch identities: customer accounts never acquire Dispatch access.
CREATE TABLE IF NOT EXISTS er_dispatch_owners (
 id uuid PRIMARY KEY,
 singleton boolean NOT NULL DEFAULT true UNIQUE CHECK(singleton),
 display_name text NOT NULL CHECK(char_length(display_name) BETWEEN 2 AND 120),
 normalized_email text NOT NULL UNIQUE CHECK(char_length(normalized_email) BETWEEN 3 AND 254),
 password_hash text NOT NULL,
 account_status text NOT NULL DEFAULT 'active' CHECK(account_status IN ('active','disabled')),
 auth_version integer NOT NULL DEFAULT 1 CHECK(auth_version>0),
 mfa_cipher text,
 recovery_pending boolean NOT NULL DEFAULT false,
 last_totp_step bigint,
 created_at timestamptz NOT NULL,
 last_sign_in_at timestamptz
);
CREATE TABLE IF NOT EXISTS er_dispatch_sessions (
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 owner_id uuid NOT NULL REFERENCES er_dispatch_owners(id),
 actor_id uuid NOT NULL UNIQUE,
 auth_version integer NOT NULL,
 created_at timestamptz NOT NULL,
 last_seen_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS er_dispatch_sessions_owner ON er_dispatch_sessions(owner_id);
-- Non-secret linkage survives session revocation/pruning and retains attribution
-- for pre-existing feature audit rows whose actor_id identifies a session.
CREATE TABLE IF NOT EXISTS er_dispatch_actor_identities (
 actor_id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES er_dispatch_owners(id),
 created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS er_dispatch_challenges (
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 owner_id uuid NOT NULL REFERENCES er_dispatch_owners(id),
 auth_version integer NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('mfa','enroll')),
 pending_cipher text,
 -- A consumed challenge cannot authenticate again. Retain only its session
 -- digest until that session expires so logout can cancel a late sign-in reply.
 completed_session_hash text CHECK(completed_session_hash ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS er_dispatch_challenges_expiry ON er_dispatch_challenges(expires_at);
CREATE TABLE IF NOT EXISTS er_dispatch_recovery_codes (
 owner_id uuid NOT NULL REFERENCES er_dispatch_owners(id),
 code_hash text NOT NULL CHECK(code_hash ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(owner_id,code_hash)
);
CREATE TABLE IF NOT EXISTS er_dispatch_auth_limits (
 scope text NOT NULL CHECK(scope IN ('login_source','login_identity','mfa_source','mfa_identity','recovery_source','recovery_identity')),
 identity_hash text NOT NULL CHECK(identity_hash ~ '^[a-f0-9]{64}$'),
 attempts integer NOT NULL CHECK(attempts>0),
 reset_at timestamptz NOT NULL,
 PRIMARY KEY(scope,identity_hash)
);
CREATE INDEX IF NOT EXISTS er_dispatch_auth_limits_expiry ON er_dispatch_auth_limits(reset_at);
CREATE TABLE IF NOT EXISTS er_dispatch_audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 occurred_at timestamptz NOT NULL,
 reference_id uuid NOT NULL,
 staff_id uuid REFERENCES er_dispatch_owners(id),
 actor_id uuid,
 record_id uuid,
 action text NOT NULL CHECK(char_length(action) BETWEEN 1 AND 64),
 outcome text NOT NULL CHECK(char_length(outcome) BETWEEN 1 AND 32),
 UNIQUE(reference_id,action)
);
CREATE INDEX IF NOT EXISTS er_dispatch_audit_page ON er_dispatch_audit_events(occurred_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS er_dispatch_audit_staff ON er_dispatch_audit_events(staff_id,occurred_at DESC,id DESC);
CREATE OR REPLACE FUNCTION er_dispatch_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Dispatch audit events are append only'; END $$;
DROP TRIGGER IF EXISTS er_dispatch_audit_no_change ON er_dispatch_audit_events;
CREATE TRIGGER er_dispatch_audit_no_change BEFORE UPDATE OR DELETE ON er_dispatch_audit_events FOR EACH ROW EXECUTE FUNCTION er_dispatch_audit_immutable();
REVOKE ALL ON er_dispatch_owners,er_dispatch_sessions,er_dispatch_actor_identities,er_dispatch_challenges,er_dispatch_recovery_codes,er_dispatch_auth_limits,er_dispatch_audit_events FROM PUBLIC;
INSERT INTO er_schema_migrations(version) VALUES(20) ON CONFLICT DO NOTHING;
