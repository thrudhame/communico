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
-- (M4): ALTER TABLE event_index ADD COLUMN state_commit_hash text;
--   ALTER TABLE event_index ADD COLUMN redacted_by text;
--   ALTER TABLE event_index ADD COLUMN txn_device text;
--   ALTER TABLE event_index ADD COLUMN txn_id text;
-- (band C): ALTER TABLE room_aliases ADD COLUMN creator text;
--   ALTER TABLE room_membership ADD COLUMN forgotten boolean NOT NULL DEFAULT FALSE;
--   CREATE SEQUENCE receipt_seq;
--   CREATE TABLE receipts (room_id text, user_id text, receipt_type text,
--     event_id text, ts_ms bigint, seq bigint,
--     PRIMARY KEY (room_id, user_id, receipt_type));
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
  seq bigint DEFAULT nextval('event_seq'),
  -- M4 (E1): HASHOF('main') right after this event's publishCurrentState —
  -- "state at seq N" = state AS OF the state_commit_hash of the last
  -- R-event with seq <= N.
  state_commit_hash text,
  -- M4: the m.room.redaction event that redacted this one (applied at read
  -- time; the stored PDU stays verbatim).
  redacted_by text,
  -- M4: sending device + transaction id for txn idempotency and
  -- unsigned.transaction_id (same device only).
  txn_device text,
  txn_id text
);
-- M4 (E2): per-user room lists without scanning room DBs. Derived cache of
-- `main`, written in the same ingest step that publishes it (from the
-- published rows' m.room.member entries).
-- band C (D4): forgotten is set by /forget and cleared by any later
-- membership event for the user in the room (the E2 upsert resets it).
CREATE TABLE IF NOT EXISTS room_membership (
  room_id text NOT NULL,
  user_id text NOT NULL,
  membership text NOT NULL,
  event_id text NOT NULL,
  seq bigint NOT NULL,
  forgotten boolean NOT NULL DEFAULT FALSE,
  PRIMARY KEY (room_id, user_id)
);
-- M4: alias -> room (createRoom room_alias_name; /join by alias). The
-- directory surface (PUT/DELETE /directory, /aliases) is band C; creator
-- feeds the D3 delete-permission rule (creator or sufficient PL).
CREATE TABLE IF NOT EXISTS room_aliases (
  alias text PRIMARY KEY,
  room_id text NOT NULL,
  creator text
);
-- M4: visibility: public rows (the /publicRooms listing itself is band C).
CREATE TABLE IF NOT EXISTS room_visibility (
  room_id text PRIMARY KEY,
  visibility text NOT NULL
);
-- M4 (E3): presence has its own monotone stream (presence_seq); events
-- stay on event_seq. Sync tokens are s<eventSeq>_p<presenceSeq>.
CREATE SEQUENCE IF NOT EXISTS presence_seq;
CREATE TABLE IF NOT EXISTS presence (
  user_id text PRIMARY KEY,
  presence text NOT NULL,
  status_msg text,
  last_active_ms bigint NOT NULL,
  seq bigint NOT NULL
);
-- band C (D1/D2): receipts get their own persisted stream (receipt_seq);
-- typing stays in-process (ephemeral by nature). Sync tokens grow to
-- s<eventSeq>_p<presenceSeq>_t<typingSeq>_r<receiptSeq>; the m.read.private
-- rows are stored, never broadcast (plan §2; receipts.md:114-115).
CREATE SEQUENCE IF NOT EXISTS receipt_seq;
CREATE TABLE IF NOT EXISTS receipts (
  room_id text NOT NULL,
  user_id text NOT NULL,
  receipt_type text NOT NULL,
  event_id text NOT NULL,
  ts_ms bigint NOT NULL,
  seq bigint NOT NULL,
  PRIMARY KEY (room_id, user_id, receipt_type)
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
