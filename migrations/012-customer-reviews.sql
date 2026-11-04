-- Additive only. Run inside the existing startup migration transaction/lock.
CREATE TABLE IF NOT EXISTS er_review_invitations (
 id uuid PRIMARY KEY,
 booking_id uuid NOT NULL UNIQUE REFERENCES er_reservations(id) ON DELETE RESTRICT,
 completed_by uuid NOT NULL,
 completed_at timestamptz NOT NULL,
 recipient text NOT NULL CHECK(length(recipient) BETWEEN 3 AND 200),
 token_hash text UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz,
 used_at timestamptz,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','review_required','inactive')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 claim_token uuid,
 lease_until timestamptz,
 first_submitted_at timestamptz,
 next_attempt_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 sent_at timestamptz,
 UNIQUE(id,booking_id),
 CHECK((token_hash IS NULL)=(expires_at IS NULL)),
 CHECK((state='sending')=(claim_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK(state<>'sent' OR sent_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS er_review_invitation_due ON er_review_invitations(next_attempt_at,id) WHERE state IN ('pending','sending');
CREATE TABLE IF NOT EXISTS er_customer_reviews (
 id uuid PRIMARY KEY,
 invitation_id uuid NOT NULL UNIQUE,
 booking_id uuid NOT NULL UNIQUE,
 customer_name text NOT NULL CHECK(length(customer_name)<=161),
 display_name text NOT NULL CHECK(length(display_name)<=50),
 rating smallint NOT NULL CHECK(rating BETWEEN 1 AND 5),
 comment text NOT NULL DEFAULT '' CHECK(length(comment)<=2000),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','published','held')),
 version integer NOT NULL DEFAULT 0 CHECK(version>=0),
 submitted_at timestamptz NOT NULL,
 published_at timestamptz,
 first_published_at timestamptz,
 FOREIGN KEY(invitation_id,booking_id) REFERENCES er_review_invitations(id,booking_id) ON DELETE RESTRICT,
 CHECK((status='published')=(published_at IS NOT NULL)),
 CHECK(published_at IS NULL OR first_published_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS er_customer_review_view ON er_customer_reviews(status,submitted_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS er_customer_review_public ON er_customer_reviews(published_at DESC,id DESC) WHERE status='published';
CREATE TABLE IF NOT EXISTS er_review_moderation_events (
 id uuid PRIMARY KEY,
 review_id uuid NOT NULL REFERENCES er_customer_reviews(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('publish','hold','remove')),
 reason text NOT NULL CHECK(reason IN ('authentic_feedback','spam','authenticity','privacy','inappropriate_content','customer_request')),
 from_status text NOT NULL CHECK(from_status IN ('pending','published','held')),
 to_status text NOT NULL CHECK(to_status IN ('published','held')),
 expected_version integer NOT NULL CHECK(expected_version>=0),
 version integer NOT NULL CHECK(version=expected_version+1),
 created_at timestamptz NOT NULL,
 UNIQUE(review_id,request_id),
 UNIQUE(review_id,version)
);
CREATE OR REPLACE FUNCTION er_review_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Review moderation history is immutable'; END $$;
DROP TRIGGER IF EXISTS er_review_history_immutable ON er_review_moderation_events;
CREATE TRIGGER er_review_history_immutable BEFORE UPDATE OR DELETE ON er_review_moderation_events FOR EACH ROW EXECUTE FUNCTION er_review_history_immutable();
CREATE OR REPLACE FUNCTION er_review_content_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Review content is immutable'; END IF;
 IF (OLD.id,OLD.invitation_id,OLD.booking_id,OLD.customer_name,OLD.display_name,OLD.rating,OLD.comment,OLD.submitted_at)
  IS DISTINCT FROM (NEW.id,NEW.invitation_id,NEW.booking_id,NEW.customer_name,NEW.display_name,NEW.rating,NEW.comment,NEW.submitted_at)
  OR (OLD.first_published_at IS NOT NULL AND OLD.first_published_at IS DISTINCT FROM NEW.first_published_at)
  OR NEW.version<>OLD.version+1
 THEN RAISE EXCEPTION 'Review content is immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS er_review_content_immutable ON er_customer_reviews;
CREATE TRIGGER er_review_content_immutable BEFORE UPDATE OR DELETE ON er_customer_reviews FOR EACH ROW EXECUTE FUNCTION er_review_content_immutable();
CREATE OR REPLACE FUNCTION er_review_invitation_authority_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Review invitation authority is immutable'; END IF;
 IF (OLD.id,OLD.booking_id,OLD.completed_by,OLD.completed_at,OLD.recipient,OLD.created_at)
  IS DISTINCT FROM (NEW.id,NEW.booking_id,NEW.completed_by,NEW.completed_at,NEW.recipient,NEW.created_at)
  OR (OLD.token_hash IS NOT NULL AND (OLD.token_hash,OLD.expires_at) IS DISTINCT FROM (NEW.token_hash,NEW.expires_at))
  OR (OLD.used_at IS NOT NULL AND OLD.used_at IS DISTINCT FROM NEW.used_at)
 THEN RAISE EXCEPTION 'Review invitation authority is immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS er_review_invitation_authority_immutable ON er_review_invitations;
CREATE TRIGGER er_review_invitation_authority_immutable BEFORE UPDATE OR DELETE ON er_review_invitations FOR EACH ROW EXECUTE FUNCTION er_review_invitation_authority_immutable();
REVOKE ALL ON er_review_invitations,er_customer_reviews,er_review_moderation_events FROM PUBLIC;
INSERT INTO er_schema_migrations(version) VALUES(12) ON CONFLICT DO NOTHING;
