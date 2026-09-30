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
--   CREATE TABLE relations (event_id text PRIMARY KEY, relates_to text,
--     rel_type text, room_id text, seq bigint);
-- (search): CREATE TABLE search_index (event_id text PRIMARY KEY,
--   room_id text NOT NULL, seq bigint NOT NULL, key text NOT NULL,
--   sender text NOT NULL, origin_ts bigint NOT NULL, body_lower text NOT NULL);
-- (M5b): ALTER TABLE room_directory ADD COLUMN current_chapter text;
--   ALTER TABLE room_directory ADD COLUMN genesis_commit text;
--   ALTER TABLE room_directory ADD COLUMN purgeable_ms bigint;
--   ALTER TABLE event_index ADD COLUMN rejected_reason text;
--   ALTER TABLE event_index ADD COLUMN origin text;
--   ALTER TABLE event_index ADD COLUMN expires_ms bigint;
--   ALTER TABLE event_index ADD COLUMN added_ms bigint;
--   ALTER TABLE event_index ADD COLUMN era text;
--   ALTER TABLE event_index ADD COLUMN branch_pos bigint;
--   CREATE TABLE event_index_waiting (room_id text NOT NULL,
--     missing_prev text NOT NULL, event_id text NOT NULL,
--     PRIMARY KEY (room_id, missing_prev, event_id));
--   CREATE INDEX event_index_reason ON event_index (room_id, rejected_reason);
-- (M5b outbox): CREATE TABLE federation_outbox (id bigserial PRIMARY KEY,
--   destination text NOT NULL, room_id text NOT NULL, kind text NOT NULL,
--   event_id text, intent text, added_ms bigint NOT NULL,
--   expires_ms bigint NOT NULL, inflight_txn text, inflight_ts bigint);
--   CREATE TABLE federation_peer_status (destination text PRIMARY KEY,
--   failures integer NOT NULL DEFAULT 0, attempts_total bigint NOT NULL DEFAULT 0,
--   failures_total bigint NOT NULL DEFAULT 0, unreachable_since_ms bigint,
--   next_attempt_ms bigint NOT NULL DEFAULT 0, last_attempt_ms bigint,
--   last_success_ms bigint, last_inbound_ms bigint, last_error text);
-- (M5b invites): CREATE TABLE federation_invites (room_id text NOT NULL,
--   user_id text NOT NULL, event_id text NOT NULL, room_version text NOT NULL,
--   event_json text NOT NULL, invite_room_state text NOT NULL,
--   origin text NOT NULL, received_ms bigint NOT NULL, status text NOT NULL,
--   PRIMARY KEY (room_id, user_id));
CREATE TABLE IF NOT EXISTS room_directory (
  room_id text PRIMARY KEY,
  db_name text NOT NULL,
  room_version text NOT NULL,
  stub_era boolean NOT NULL DEFAULT TRUE,
  -- M5b (the book): the live stay's branch name ('chapter<2k+1>') —
  -- NULL = archived (the server's last local member left). main is the
  -- room's SYSTEM branch — it carries the schema genesis commit and
  -- never holds content (P5 ruling, probes.md).
  current_chapter text,
  -- the 'room genesis: schema' commit hash, stored at provision — every
  -- chapter branch starts here (there is no content branch to read it from).
  genesis_commit text,
  -- set when every local user has forgotten the room; the operator's
  -- `rooms -- purge` drops it (never a built-in timer).
  purgeable_ms bigint
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
  txn_id text,
  -- M5b: NULL (accepted) | 'auth' | 'state' | 'ungrounded' |
  -- 'unverifiable' | 'oversized' — the machine standing beside the
  -- rejected flag (which stays for the existing readers).
  rejected_reason text,
  -- M5b: the server that delivered the event to us (NULL = authored here).
  origin text,
  -- M5b: 'ungrounded' placeholders only — removed when past (ruling B).
  expires_ms bigint,
  -- M5b: when the row was written (re-check order, report views).
  added_ms bigint,
  -- M5b: the chapter this event belongs to (live events: their stay's
  -- 'chapter<2k+1>'; history rows: the stay that discovered them).
  era text,
  -- M5b: history rows only — commit position on their even chapter
  -- (0 = root = the most recent history event; larger = older).
  branch_pos bigint
);
-- M5b: seq is two-state — > 0 = arrived live (the /sync "what's new"
-- stream), NULL = history or evidence (never news). The DEFAULT keeps
-- live inserts unchanged; history/evidence inserts pass explicit NULL.
-- M5b (P4 ruling, probes.md): Doltgres has no jsonb containment, so the
-- re-check lookup for 'ungrounded' placeholders is a plain side table —
-- one row per (placeholder event × still-missing prev id).
CREATE TABLE IF NOT EXISTS event_index_waiting (
  room_id text NOT NULL,
  missing_prev text NOT NULL,
  event_id text NOT NULL,
  PRIMARY KEY (room_id, missing_prev, event_id)
);
CREATE INDEX IF NOT EXISTS event_index_reason ON event_index (room_id, rejected_reason);
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
-- band C (D7): child -> parent index for /relations + /threads, written by
-- ingest when content['m.relates_to'] carries an event_id. seq is the
-- child's event_index.seq (the s<e> token position — /relations and
-- /threads paginate on the same grammar as /messages).
CREATE TABLE IF NOT EXISTS relations (
  event_id text PRIMARY KEY,
  relates_to text NOT NULL,
  rel_type text,
  room_id text NOT NULL,
  seq bigint NOT NULL
);
-- Search (D1): one row per accepted m.room.message/name/topic event.
-- body_lower is the indexed value, lower-cased, NUL → space. Written by
-- ingest beside the relations insert; rejected/soft-failed events skip.
CREATE TABLE IF NOT EXISTS search_index (
  event_id text PRIMARY KEY,
  room_id text NOT NULL,
  seq bigint NOT NULL,
  key text NOT NULL,
  sender text NOT NULL,
  origin_ts bigint NOT NULL,
  body_lower text NOT NULL
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
-- M5a: federation runtime data (config = how the process runs; who we know /
-- refuse / remember = database). Remembered signing keys per server, the
-- verbatim fetched documents (served by our notary endpoint), and every
-- key-material change.
CREATE TABLE IF NOT EXISTS server_keys (
  server_name text NOT NULL,
  key_id text NOT NULL,
  pubkey_b64 text NOT NULL,
  valid_until_ts bigint NOT NULL, -- as fetched, capped at fetched_ms + 7d
  fetched_ms bigint NOT NULL,
  expired_ts bigint,              -- from old_verify_keys, else NULL (events-only key)
  PRIMARY KEY (server_name, key_id)
);
CREATE TABLE IF NOT EXISTS server_key_docs (
  server_name text PRIMARY KEY,
  key_json text NOT NULL,         -- the verbatim fetched, self-signed document
  fetched_ms bigint NOT NULL,
  via text NOT NULL               -- 'direct' | 'witness:<name>' | 'accepted'
);
CREATE TABLE IF NOT EXISTS server_key_changes (
  server_name text NOT NULL,
  seen_ms bigint NOT NULL,
  old_keys text NOT NULL,         -- JSON {key_id: pubkey_b64} previously remembered
  new_keys text NOT NULL,         -- JSON from the new document
  status text NOT NULL,           -- 'noted' (accept/warn) | 'blocking' | 'accepted' | 'forgotten'
  acknowledged_old boolean NOT NULL, -- the new document also repeats a remembered pair
  candidate_json text,            -- for 'blocking': {via, doc} — the candidate lives ONLY here
  PRIMARY KEY (server_name, seen_ms)
);
-- The door log: inbound knocks, outbound intent, witness disagreements.
-- Rows with verified = FALSE are capped at federation.pendingmax (oldest
-- last_ms evicted on insert) and pruned after federation.pendingdays;
-- writes for one name coalesce within federation.keyfailminutes.
CREATE TABLE IF NOT EXISTS federation_pending (
  name text NOT NULL,
  kind text NOT NULL,             -- 'inbound' | 'outbound' | 'disagreement' | 'refused' (M5b: a delivery record)
  verified boolean NOT NULL,
  first_ms bigint NOT NULL,
  last_ms bigint NOT NULL,
  count bigint NOT NULL,
  detail text,
  PRIMARY KEY (name, kind)
);
-- The roster: servers we know. Grows by operator tool, by authenticated
-- user intent (open mode), and by admin approval of an inbound knock.
CREATE TABLE IF NOT EXISTS federation_peers (
  name text PRIMARY KEY,          -- server name as it appears in ids
  host text,                      -- optional address override; NULL = resolve by the ladder
  port integer,
  trust text NOT NULL,            -- 'ca' | 'pinned' | 'keyname'
  pin_spki_sha256 text,           -- for 'pinned': hex SHA-256 of the SubjectPublicKeyInfo
  added_ms bigint NOT NULL,
  added_by text NOT NULL,         -- 'operator' | '@user:ours' (user intent) | 'approval'
  note text
);
-- Server-name globs we refuse, both directions.
CREATE TABLE IF NOT EXISTS federation_blocks (
  pattern text PRIMARY KEY,       -- server-name glob
  added_ms bigint NOT NULL,
  note text
);
-- M5b: inbound (origin, txnId) → response, kept txnhours so a retried
-- transaction gets the same answer (a cache, not an obligation — pruned
-- on insert).
CREATE TABLE IF NOT EXISTS federation_txns (
  origin text NOT NULL,
  txn_id text NOT NULL,
  received_ms bigint NOT NULL,
  response text NOT NULL,
  PRIMARY KEY (origin, txn_id)
);
-- M5b: invites to our users into rooms we do not hold (out-of-band).
-- No room DB is provisioned for an invite — the row + a room_membership
-- row are the whole state; /sync renders from the stored stripped list.
CREATE TABLE IF NOT EXISTS federation_invites (
  room_id text NOT NULL,
  user_id text NOT NULL,
  event_id text NOT NULL,
  room_version text NOT NULL,
  event_json text NOT NULL,           -- the invite event with both signatures; on 'rejected', the signed leave (what /sync renders)
  invite_room_state text NOT NULL,    -- JSON array of stripped events (may be [])
  origin text NOT NULL,               -- the inviting server
  received_ms bigint NOT NULL,
  status text NOT NULL,               -- 'pending' | 'rejecting' (intent queued, ruling F) | 'rejected' | 'joined'
  PRIMARY KEY (room_id, user_id)
);
-- M5b (D2): the durable outbox — one row per (event × destination),
-- written in the same server-DB transaction as the event's index row
-- (P2). insertion order = send order. Rows leave by exactly three doors:
-- success, the operator's prune, or the refusedmillihours expiry (with
-- the admin alerted). inflight_txn/inflight_ts freeze the in-flight
-- batch: a restart resends exactly that transaction, same id, same ts.
CREATE TABLE IF NOT EXISTS federation_outbox (
  id bigserial PRIMARY KEY,
  destination text NOT NULL,
  room_id text NOT NULL,
  kind text NOT NULL,                 -- 'event' (deliver a PDU) | 'intent' (perform a dance: today only 'reject-invite')
  event_id text,                      -- kind = 'event': the PDU to deliver
  intent text,                        -- kind = 'intent': JSON {what, ...candidates}
  added_ms bigint NOT NULL,
  expires_ms bigint NOT NULL,         -- added_ms + refusedmillihours·3600; lapsed rows are removed and the admin told
  inflight_txn text,                  -- event rows: the txnId of the frozen batch this row is part of while it is being sent
  inflight_ts bigint                  -- event rows: the frozen transaction's origin_server_ts (resent unchanged)
);
-- M5b: per-destination delivery memory (NOT the roster — a server can be
-- in a room without being a roster row). failures drives the backoff
-- ladder; the totals are lifetime (D2: every attempt recorded);
-- last_inbound_ms is the inbound-contact reset.
CREATE TABLE IF NOT EXISTS federation_peer_status (
  destination text PRIMARY KEY,
  failures integer NOT NULL DEFAULT 0,
  attempts_total bigint NOT NULL DEFAULT 0,
  failures_total bigint NOT NULL DEFAULT 0,
  unreachable_since_ms bigint,
  next_attempt_ms bigint NOT NULL DEFAULT 0,
  last_attempt_ms bigint,
  last_success_ms bigint,
  last_inbound_ms bigint,
  last_error text
);
