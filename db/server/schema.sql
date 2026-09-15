-- db/server/schema.sql — server operational DB (F1). Holds the room
-- registry and the event index only. Identity lives in the per-tenant DB
-- (db/tenant/schema.sql); users/access_tokens tables and seeds were
-- removed in F1 (seeds now register through the real /register path in
-- db/init.ts). server_signing_key stays as the tenant-key migration source.
-- Doltgres substitution (recorded in RESULTS.md): neither
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` nor plpgsql `DO` blocks are
-- supported, so there is no idempotent ALTER for pre-existing server DBs.
-- Fresh provisioning gets the columns from the CREATE TABLEs below; an
-- existing DB gets them once via plain ALTER (no IF NOT EXISTS):
--   ALTER TABLE room_directory ADD COLUMN stub_era boolean DEFAULT TRUE;
--   ALTER TABLE event_index ADD COLUMN rejected boolean DEFAULT FALSE;
--   ALTER TABLE event_index ADD COLUMN soft_failed boolean DEFAULT FALSE;
-- (room DBs, M3): ALTER TABLE events ADD COLUMN soft_failed boolean DEFAULT FALSE;
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
  -- M3: soft-failed (S8 check 6) — persisted, not an authoring extremity,
  -- excluded from the client-visible timeline.
  soft_failed boolean NOT NULL DEFAULT FALSE,
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
