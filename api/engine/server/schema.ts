// api/engine/server/schema.ts — server schema v1 (design row 1, R12,
// requirements §7.2): the derived tables the projection maintains (rooms
// registry, event_index, feed, memberships, relations, search, redactions)
// and the server-owned truth it never rebuilds (outbox, peer_status,
// receipts, presence, aliases, directory, visibility, forgotten, counters),
// plus the federation tables of doltgres:db/server/schema.sql re-expressed
// for SQLite (schema only — their logic is 4c). The old sequences
// (presence_seq, receipt_seq) become rows in `counters`, advanced inside
// the transaction they stamp (no sequences). The store owns the id row,
// the meta table and the watermarks; this provider owns everything else.
import type { SchemaProvider } from '#engine/store/create.ts';

export const SERVER_SCHEMA_SQL = `
-- Derived (S11/S12): rebuilt only by roll-forward replaying the rooms'
-- change logs, keyed by (room, pos) so a replay changes nothing.

CREATE TABLE rooms(
  room_id TEXT PRIMARY KEY NOT NULL,
  file_key TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);

CREATE TABLE event_index(
  event TEXT PRIMARY KEY NOT NULL,
  room TEXT NOT NULL,
  pos INTEGER NOT NULL,
  standing TEXT NOT NULL,
  grounding TEXT NOT NULL,
  reason TEXT,
  rule TEXT,
  origin TEXT,
  seq INTEGER,
  UNIQUE(room, pos)
);
CREATE INDEX event_index_room ON event_index(room, seq);

CREATE TABLE feed(
  seq INTEGER PRIMARY KEY NOT NULL,
  room TEXT NOT NULL,
  pos INTEGER NOT NULL,
  event TEXT NOT NULL,
  stay INTEGER NOT NULL,
  UNIQUE(room, pos)
);
CREATE INDEX feed_room ON feed(room, seq);

CREATE TABLE memberships(
  user TEXT NOT NULL,
  room TEXT NOT NULL,
  membership TEXT NOT NULL,
  event TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY(user, room)
);
CREATE INDEX memberships_room ON memberships(room);

CREATE TABLE redactions(
  target TEXT PRIMARY KEY NOT NULL,
  room TEXT NOT NULL,
  event TEXT NOT NULL,
  pos INTEGER NOT NULL
);

CREATE TABLE relations(
  event TEXT PRIMARY KEY NOT NULL,
  relates_to TEXT NOT NULL,
  rel_type TEXT,
  room TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE INDEX relations_parent ON relations(room, relates_to, seq);

CREATE TABLE search(
  event TEXT PRIMARY KEY NOT NULL,
  room TEXT NOT NULL,
  seq INTEGER NOT NULL,
  key TEXT NOT NULL,
  sender TEXT NOT NULL,
  origin_ts INTEGER NOT NULL,
  body_lower TEXT NOT NULL
);
CREATE INDEX search_room ON search(room, key, seq);

-- Server-owned truth (S13/S14): written by their owners, never by the
-- projection. The outbox's UNIQUE(room, pos, destination) keeps a
-- replayed delivery intent from minting a second row — and the
-- projection never touches state/attempts/next_attempt_ms.

CREATE TABLE outbox(
  room TEXT NOT NULL,
  pos INTEGER NOT NULL,
  destination TEXT NOT NULL,
  event TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_ms INTEGER NOT NULL DEFAULT 0,
  added_ms INTEGER NOT NULL,
  PRIMARY KEY(room, pos, destination)
);
CREATE INDEX outbox_due ON outbox(destination, state, next_attempt_ms);

CREATE TABLE peer_status(
  destination TEXT PRIMARY KEY NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  attempts_total INTEGER NOT NULL DEFAULT 0,
  failures_total INTEGER NOT NULL DEFAULT 0,
  unreachable_since_ms INTEGER,
  next_attempt_ms INTEGER NOT NULL DEFAULT 0,
  last_attempt_ms INTEGER,
  last_success_ms INTEGER,
  last_inbound_ms INTEGER,
  last_error TEXT
);

CREATE TABLE receipts(
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  receipt_type TEXT NOT NULL,
  event_id TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY(room_id, user_id, receipt_type)
);

CREATE TABLE presence(
  user_id TEXT PRIMARY KEY NOT NULL,
  presence TEXT NOT NULL,
  status_msg TEXT,
  last_active_ms INTEGER NOT NULL,
  seq INTEGER NOT NULL
);

CREATE TABLE aliases(
  alias TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL,
  creator TEXT
);

-- The operator's purge marker (old room_directory.purgeable_ms): set
-- when every local user has forgotten the room; the registry row in
-- rooms is the file routing, not this truth.
CREATE TABLE directory(
  room_id TEXT PRIMARY KEY NOT NULL,
  purgeable_ms INTEGER
);

CREATE TABLE visibility(
  room_id TEXT PRIMARY KEY NOT NULL,
  visibility TEXT NOT NULL
);

CREATE TABLE forgotten(
  user TEXT NOT NULL,
  room TEXT NOT NULL,
  PRIMARY KEY(user, room)
);

-- The presence and receipts streams' counters (the old presence_seq /
-- receipt_seq sequences), advanced inside the stamping transaction.
CREATE TABLE counters(
  name TEXT PRIMARY KEY NOT NULL,
  value INTEGER NOT NULL
);

-- Federation (schema only; the logic is 4c) — doltgres shapes with
-- SQLite types: bigserial → INTEGER, boolean → INTEGER 0/1, jsonb → TEXT.

CREATE TABLE federation_txns(
  origin TEXT NOT NULL,
  txn_id TEXT NOT NULL,
  received_ms INTEGER NOT NULL,
  response TEXT NOT NULL,
  PRIMARY KEY(origin, txn_id)
);

CREATE TABLE federation_peers(
  name TEXT PRIMARY KEY NOT NULL,
  host TEXT,
  port INTEGER,
  trust TEXT NOT NULL,
  pin_spki_sha256 TEXT,
  added_ms INTEGER NOT NULL,
  added_by TEXT NOT NULL,
  note TEXT
);

CREATE TABLE federation_blocks(
  pattern TEXT PRIMARY KEY NOT NULL,
  added_ms INTEGER NOT NULL,
  note TEXT
);

CREATE TABLE federation_pending(
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  verified INTEGER NOT NULL,
  first_ms INTEGER NOT NULL,
  last_ms INTEGER NOT NULL,
  count INTEGER NOT NULL,
  detail TEXT,
  PRIMARY KEY(name, kind)
);

CREATE TABLE federation_invites(
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  room_version TEXT NOT NULL,
  event_json TEXT NOT NULL,
  invite_room_state TEXT NOT NULL,
  origin TEXT NOT NULL,
  received_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY(room_id, user_id)
);

CREATE TABLE server_keys(
  server_name TEXT NOT NULL,
  key_id TEXT NOT NULL,
  pubkey_b64 TEXT NOT NULL,
  valid_until_ts INTEGER NOT NULL,
  fetched_ms INTEGER NOT NULL,
  expired_ts INTEGER,
  PRIMARY KEY(server_name, key_id)
);

CREATE TABLE server_key_docs(
  server_name TEXT PRIMARY KEY NOT NULL,
  key_json TEXT NOT NULL,
  fetched_ms INTEGER NOT NULL,
  via TEXT NOT NULL
);

CREATE TABLE server_key_changes(
  server_name TEXT NOT NULL,
  seen_ms INTEGER NOT NULL,
  old_keys TEXT NOT NULL,
  new_keys TEXT NOT NULL,
  status TEXT NOT NULL,
  acknowledged_old INTEGER NOT NULL,
  candidate_json TEXT,
  PRIMARY KEY(server_name, seen_ms)
);
`;

export const serverSchema: SchemaProvider = {
  version: 2,
  apply: async (db) => {
    await db.exec(SERVER_SCHEMA_SQL);
  },
};
