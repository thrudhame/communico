CREATE TABLE IF NOT EXISTS users (
  user_id text PRIMARY KEY,
  display_name text,
  password_hash text
);
-- Doltgres substitution (recorded in RESULTS.md): neither
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` nor plpgsql `DO` blocks are
-- supported, so there is no idempotent ALTER for pre-existing server DBs.
-- Fresh provisioning gets the columns from the CREATE TABLEs above/below;
-- an existing DB gets them once via plain ALTER (no IF NOT EXISTS):
--   ALTER TABLE users ADD COLUMN password_hash text;
--   ALTER TABLE access_tokens ADD COLUMN device_id text;
CREATE TABLE IF NOT EXISTS access_tokens (
  token text PRIMARY KEY,
  user_id text NOT NULL,
  device_id text
);
CREATE TABLE IF NOT EXISTS room_directory (
  room_id text PRIMARY KEY,
  db_name text NOT NULL,
  room_version text NOT NULL,
  stub_era boolean NOT NULL DEFAULT TRUE
);
-- branch_name: x* extremity branch currently holding this event's commit
-- (phase-1 step 1.3 sanctioned addition for the send endpoint's
-- extremities -> event_ids lookup; stale after branch deletion, filtered
-- against live dolt.branches at query time).
CREATE SEQUENCE IF NOT EXISTS event_seq;
CREATE TABLE IF NOT EXISTS event_index (
  event_id text PRIMARY KEY,
  room_id text NOT NULL,
  commit_hash text NOT NULL,
  branch_name text,
  rejected boolean NOT NULL DEFAULT FALSE,
  seq bigint DEFAULT nextval('event_seq')
);
-- F0 dev signing key (db-init generates once via ensureServerKey, reuses
-- forever — never rotates; F1 moves the same key into the tenant table).
CREATE TABLE IF NOT EXISTS server_signing_key (
  key_id text PRIMARY KEY,
  server_name text NOT NULL,
  pubkey_b64 text NOT NULL,
  privkey_pkcs8_b64 text NOT NULL,
  created_ms bigint NOT NULL
);
INSERT INTO users (user_id, display_name) VALUES ('@dev:localhost', 'Dev User')
  ON CONFLICT (user_id) DO NOTHING;
INSERT INTO access_tokens (token, user_id) VALUES ('devtoken', '@dev:localhost')
  ON CONFLICT (token) DO NOTHING;
-- demo users; password is 'demo-password' (sha256 hex; PROTOTYPE-GRADE,
-- documented as demo-only — plan §8)
INSERT INTO users (user_id, display_name, password_hash) VALUES ('@alice:localhost', 'Alice', '41bd876b085d6031cb0e04de35b88d77f83a4ba39f879fee40805ac19e356023')
  ON CONFLICT (user_id) DO NOTHING;
INSERT INTO users (user_id, display_name, password_hash) VALUES ('@bob:localhost', 'Bob', '41bd876b085d6031cb0e04de35b88d77f83a4ba39f879fee40805ac19e356023')
  ON CONFLICT (user_id) DO NOTHING;
