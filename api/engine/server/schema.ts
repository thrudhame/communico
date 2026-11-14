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
import {
  FACADE_JOURNAL_SQL,
  FACADE_PAIRING_SQL,
  RUNTIME_IDENTITY_SQL,
} from './facade-schema.ts';

const DEVICE_CHANGES_SQL = `
CREATE TABLE device_changes(seq INTEGER PRIMARY KEY NOT NULL, source TEXT NOT NULL, source_pos INTEGER NOT NULL, subject TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL, stream_id INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(source,source_pos));
CREATE INDEX device_changes_subject ON device_changes(subject,seq);
`;

const DEVICE_TRACKING_SQL = `
CREATE TABLE e2ee_rooms(room TEXT PRIMARY KEY NOT NULL, encrypted INTEGER NOT NULL, encryption_event TEXT, publication_pos INTEGER NOT NULL);
CREATE TABLE e2ee_room_members(room TEXT NOT NULL, user TEXT NOT NULL, PRIMARY KEY(room,user));
CREATE INDEX e2ee_room_members_user ON e2ee_room_members(user,room);
CREATE TABLE device_tracking(observer TEXT NOT NULL, subject TEXT NOT NULL, scope TEXT NOT NULL, start_seq INTEGER NOT NULL, end_seq INTEGER, PRIMARY KEY(observer,subject,scope,start_seq));
CREATE INDEX device_tracking_subject ON device_tracking(subject,scope,end_seq);
CREATE TABLE device_notices(seq INTEGER NOT NULL, observer TEXT NOT NULL, subject TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(seq,observer,subject,scope));
CREATE INDEX device_notices_observer ON device_notices(observer,scope,seq);
`;

const RELIABLE_DELIVERY_SQL = `
CREATE TABLE edu_outbox(source TEXT NOT NULL, destination TEXT NOT NULL, edu_type TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(source,destination));
CREATE INDEX edu_outbox_pending ON edu_outbox(destination,state);
CREATE TABLE federation_batches(destination TEXT PRIMARY KEY NOT NULL, txn_id TEXT NOT NULL, body TEXT NOT NULL, pdu_rows TEXT NOT NULL, edu_sources TEXT NOT NULL);
`;

const DELIVERY_FIFO_SQL = `
ALTER TABLE edu_outbox ADD COLUMN enqueue_pos INTEGER NOT NULL DEFAULT 0;
UPDATE edu_outbox SET enqueue_pos=rowid;
INSERT INTO counters(name,value) SELECT 'reliable-edus',COALESCE(MAX(enqueue_pos),0) FROM edu_outbox;
CREATE INDEX edu_outbox_fifo ON edu_outbox(destination,state,enqueue_pos);
CREATE INDEX edu_outbox_completed ON edu_outbox(state,source);
`;

const REMOTE_DEVICES_SQL = `
CREATE TABLE remote_device_users(user_id TEXT PRIMARY KEY NOT NULL, anchor TEXT, stale INTEGER NOT NULL, revision INTEGER NOT NULL, retry_at INTEGER NOT NULL, failures INTEGER NOT NULL, pending TEXT NOT NULL, seen TEXT NOT NULL);
CREATE INDEX remote_device_users_due ON remote_device_users(stale,retry_at);
CREATE TABLE remote_device_keys(user_id TEXT NOT NULL, device_id TEXT NOT NULL, key_json TEXT NOT NULL, PRIMARY KEY(user_id,device_id));
`;

const DEVICE_SUBSCRIPTIONS_SQL = `
CREATE TABLE device_subscriptions(subject TEXT NOT NULL, destination TEXT NOT NULL, active INTEGER NOT NULL, epoch INTEGER NOT NULL, queued_stream INTEGER NOT NULL, sent_stream INTEGER, PRIMARY KEY(subject,destination));
`;

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
  thread_id TEXT NOT NULL DEFAULT '',
  event_id TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY(room_id, user_id, receipt_type, thread_id)
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

const DEVICE_RECOVERY_SQL = `
CREATE TABLE device_recovery_requests(user_id TEXT PRIMARY KEY NOT NULL);
INSERT INTO device_recovery_requests SELECT user_id FROM remote_device_users WHERE pending!='[]' OR failures>0 OR anchor IS NOT NULL;
`;

const PUBLIC_SIGNING_SQL = `
CREATE TABLE public_signing_keys(subject TEXT PRIMARY KEY NOT NULL, source_pos INTEGER NOT NULL, payload TEXT NOT NULL);
`;
const REMOTE_SIGNING_SQL = `
CREATE TABLE remote_signing_keys(user_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL);
`;
const JOIN_ATTEMPTS_SQL = `
CREATE TABLE federation_join_attempts(room_id TEXT NOT NULL, user_id TEXT NOT NULL, event_id TEXT NOT NULL, room_version TEXT NOT NULL, destination TEXT NOT NULL, added_ms INTEGER NOT NULL, leave_json TEXT, PRIMARY KEY(room_id,user_id));
CREATE INDEX federation_join_attempts_destination ON federation_join_attempts(destination,added_ms);
`;

const NOTIFICATIONS_SQL = `
CREATE TABLE push_evaluations(tenant TEXT NOT NULL, user TEXT NOT NULL, event TEXT NOT NULL, room TEXT NOT NULL, event_seq INTEGER NOT NULL, source TEXT NOT NULL, source_pos INTEGER NOT NULL, rule_revision INTEGER NOT NULL, ignore_revision INTEGER NOT NULL, version INTEGER NOT NULL, rule_id TEXT, rule_kind TEXT, PRIMARY KEY(tenant,user,event));
CREATE TABLE notifications(seq INTEGER PRIMARY KEY NOT NULL, tenant TEXT NOT NULL, user TEXT NOT NULL, event TEXT NOT NULL, room TEXT NOT NULL, event_seq INTEGER NOT NULL, thread TEXT NOT NULL, actions TEXT NOT NULL, highlight INTEGER NOT NULL, created_ms INTEGER NOT NULL, read_ms INTEGER, withdrawn INTEGER NOT NULL DEFAULT 0, UNIQUE(tenant,user,event));
CREATE INDEX notifications_user_room ON notifications(user,room,thread,event_seq);
CREATE TABLE notification_counts(user TEXT NOT NULL, room TEXT NOT NULL, thread TEXT NOT NULL, unread INTEGER NOT NULL CHECK(unread>=0), highlight INTEGER NOT NULL CHECK(highlight>=0 AND highlight<=unread), PRIMARY KEY(user,room,thread));
CREATE TABLE notification_horizons(user TEXT NOT NULL, room TEXT NOT NULL, scope TEXT NOT NULL, event_seq INTEGER NOT NULL, PRIMARY KEY(user,room,scope));
CREATE TABLE notification_receipt_refs(user TEXT NOT NULL, room TEXT NOT NULL, scope TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY(user,room,scope,event));
CREATE TABLE notification_changes(seq INTEGER PRIMARY KEY NOT NULL, user TEXT NOT NULL, room TEXT NOT NULL, thread TEXT NOT NULL);
CREATE INDEX notification_changes_user ON notification_changes(user,seq);
`;

// Relation identity includes accepted history; a null seq never enters live
// relation listings. Keeping one edge owner lets receipt and count classifiers
// traverse late historical parents without inventing live publication.
const HISTORY_RELATIONS_SQL = `
ALTER TABLE relations RENAME TO relations_live;
CREATE TABLE relations(event TEXT PRIMARY KEY NOT NULL, relates_to TEXT NOT NULL, rel_type TEXT, room TEXT NOT NULL, seq INTEGER);
INSERT INTO relations SELECT * FROM relations_live;
DROP TABLE relations_live;
CREATE INDEX relations_parent ON relations(room,relates_to,seq);
CREATE TABLE notification_own_events(room TEXT NOT NULL,event TEXT NOT NULL,user TEXT NOT NULL,event_seq INTEGER NOT NULL,PRIMARY KEY(room,event));
`;

const NOTIFICATION_LOOKUPS_SQL = `
CREATE INDEX notifications_event ON notifications(event,room);
CREATE INDEX notification_receipt_refs_event ON notification_receipt_refs(event,room);
`;

const NOTIFICATION_HISTORY_SQL = `
CREATE TABLE notification_history(seq INTEGER PRIMARY KEY NOT NULL,user TEXT NOT NULL,room TEXT NOT NULL,highlight INTEGER NOT NULL,read_ms INTEGER);
CREATE INDEX notification_history_user ON notification_history(user,seq);
CREATE INDEX notification_history_highlight ON notification_history(user,highlight,seq);
CREATE INDEX notification_history_room ON notification_history(room,seq);
CREATE INDEX notification_history_retention ON notification_history(read_ms,seq);
INSERT INTO notification_history SELECT seq,user,room,highlight,read_ms FROM notifications WHERE withdrawn=0;
`;

const PUSH_TARGETS_SQL = `
CREATE TABLE push_targets(tenant TEXT NOT NULL,user TEXT NOT NULL,app_id TEXT NOT NULL,pushkey TEXT NOT NULL,incarnation TEXT NOT NULL,payload TEXT NOT NULL,registered_seq INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(tenant,user,app_id,pushkey));
CREATE UNIQUE INDEX push_targets_incarnation ON push_targets(incarnation);
CREATE INDEX push_targets_user ON push_targets(user);
CREATE TABLE push_rejections(tenant TEXT NOT NULL,user TEXT NOT NULL,app_id TEXT NOT NULL,pushkey TEXT NOT NULL,incarnation TEXT PRIMARY KEY NOT NULL);
CREATE INDEX push_rejections_tenant ON push_rejections(tenant);
`;

const PUSH_DELIVERY_SQL = `
CREATE TABLE push_delivery(incarnation TEXT NOT NULL,notification_seq INTEGER NOT NULL,user TEXT NOT NULL,room TEXT NOT NULL,event TEXT NOT NULL,created_ms INTEGER NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL,next_ms INTEGER NOT NULL,error TEXT,PRIMARY KEY(incarnation,notification_seq));
CREATE INDEX push_delivery_pending ON push_delivery(incarnation,state,notification_seq);
CREATE INDEX push_delivery_room ON push_delivery(room,state);
CREATE INDEX push_delivery_user ON push_delivery(user,state);
CREATE TABLE push_badges(incarnation TEXT PRIMARY KEY NOT NULL,user TEXT NOT NULL,revision INTEGER NOT NULL,sent_revision INTEGER NOT NULL,expired_revision INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL,next_ms INTEGER NOT NULL,created_ms INTEGER NOT NULL,error TEXT);
CREATE INDEX push_badges_user ON push_badges(user);
`;

const PREJOIN_SQL = `
ALTER TABLE federation_invites RENAME TO prejoin_memberships;
ALTER TABLE prejoin_memberships ADD COLUMN kind TEXT NOT NULL DEFAULT 'invite' CHECK(kind IN ('invite','knock'));
ALTER TABLE prejoin_memberships ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE prejoin_memberships ADD COLUMN candidates TEXT NOT NULL DEFAULT '[]';
ALTER TABLE prejoin_memberships ADD COLUMN leave_json TEXT;
ALTER TABLE prejoin_memberships ADD COLUMN expires_ms INTEGER;
CREATE INDEX prejoin_user ON prejoin_memberships(user_id,seq);
CREATE INDEX prejoin_pending ON prejoin_memberships(status,origin);
`;

const MEDIA_CACHE_SQL = `
CREATE TABLE media_cache(cache_key TEXT PRIMARY KEY NOT NULL,origin TEXT NOT NULL,media_id TEXT NOT NULL,variant TEXT NOT NULL,scope TEXT NOT NULL,blob TEXT UNIQUE NOT NULL,size INTEGER NOT NULL,content_type TEXT NOT NULL,filename TEXT,created_ms INTEGER NOT NULL,accessed_ms INTEGER NOT NULL,UNIQUE(origin,media_id,variant));
CREATE INDEX media_cache_lru ON media_cache(scope,accessed_ms);
`;

const REPORTS_SQL = `
CREATE TABLE reports(id INTEGER PRIMARY KEY NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('event','room','user')),reporter TEXT NOT NULL,room_id TEXT,event_id TEXT,user_id TEXT,reason TEXT,score INTEGER,received_ms INTEGER NOT NULL,resolved_ms INTEGER,resolution TEXT);
CREATE INDEX reports_status ON reports(resolved_ms,id);
CREATE INDEX reports_kind ON reports(kind,id);
`;

const RECEIPT_EXTREMITIES_SQL = `
ALTER TABLE receipts RENAME COLUMN event_id TO event_ids;
UPDATE receipts SET event_ids=json_array(event_ids);
`;

export const serverSchema: SchemaProvider = {
  version: 27,
  apply: async (db) => {
    await db.exec(SERVER_SCHEMA_SQL);
    await db.exec(DEVICE_CHANGES_SQL);
    await db.exec(DEVICE_TRACKING_SQL);
    await db.exec(RELIABLE_DELIVERY_SQL);
    await db.exec(DELIVERY_FIFO_SQL);
    await db.exec(REMOTE_DEVICES_SQL);
    await db.exec(DEVICE_SUBSCRIPTIONS_SQL);
    await db.exec(DEVICE_RECOVERY_SQL);
    await db.exec(PUBLIC_SIGNING_SQL);
    await db.exec(REMOTE_SIGNING_SQL);
    await db.exec(JOIN_ATTEMPTS_SQL);
    await db.exec(NOTIFICATIONS_SQL);
    await db.exec(HISTORY_RELATIONS_SQL);
    await db.exec(NOTIFICATION_LOOKUPS_SQL);
    await db.exec(NOTIFICATION_HISTORY_SQL);
    await db.exec(PUSH_TARGETS_SQL);
    await db.exec(PUSH_DELIVERY_SQL);
    await db.exec(PREJOIN_SQL);
    await db.exec(MEDIA_CACHE_SQL);
    await db.exec(REPORTS_SQL);
    await db.exec(
      'ALTER TABLE prejoin_memberships ADD COLUMN local_leave_json TEXT',
    );
    await db.exec(RECEIPT_EXTREMITIES_SQL);
    await db.exec(FACADE_JOURNAL_SQL);
    await db.exec(FACADE_PAIRING_SQL);
    await db.exec(RUNTIME_IDENTITY_SQL);
  },
  migrations: {
    3: (conn) => conn.exec(DEVICE_CHANGES_SQL),
    4: (conn) => conn.exec(DEVICE_TRACKING_SQL),
    5: (conn) => conn.exec(RELIABLE_DELIVERY_SQL),
    6: (conn) => conn.exec(DELIVERY_FIFO_SQL),
    7: (conn) => conn.exec(REMOTE_DEVICES_SQL),
    8: (conn) => conn.exec(DEVICE_SUBSCRIPTIONS_SQL),
    9: (conn) => conn.exec(DEVICE_RECOVERY_SQL),
    10: (conn) => conn.exec(PUBLIC_SIGNING_SQL),
    11: (conn) => conn.exec(REMOTE_SIGNING_SQL),
    12: (conn) => conn.exec(JOIN_ATTEMPTS_SQL),
    13: (conn) => conn.exec(NOTIFICATIONS_SQL),
    14: (conn) => conn.exec(HISTORY_RELATIONS_SQL),
    15: (conn) => conn.exec(NOTIFICATION_LOOKUPS_SQL),
    16: (conn) => conn.exec(NOTIFICATION_HISTORY_SQL),
    17: (conn) => conn.exec(PUSH_TARGETS_SQL),
    18: (conn) => conn.exec(PUSH_DELIVERY_SQL),
    19: (conn) => conn.exec(PREJOIN_SQL),
    20: (conn) => conn.exec(MEDIA_CACHE_SQL),
    21: (conn) => conn.exec(REPORTS_SQL),
    22: (conn) =>
      conn.exec(
        'ALTER TABLE prejoin_memberships ADD COLUMN local_leave_json TEXT',
      ),
    23: (conn) => conn.exec(RECEIPT_EXTREMITIES_SQL),
    24: (conn) => conn.exec(FACADE_JOURNAL_SQL),
    25: (conn) => conn.exec(FACADE_PAIRING_SQL),
    26: (conn) => conn.exec(RUNTIME_IDENTITY_SQL),
  },
};
