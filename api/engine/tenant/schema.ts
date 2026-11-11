// api/engine/tenant/schema.ts - tenant schema v4 (design row 1, D3.2): the
// tenant file's tables, re-expressed for SQLite/Turso from
// doltgres:db/tenant/schema.sql — identity and signing keys, users and
// credentials, devices, access/refresh tokens (stored hashed, not plain),
// UIA sessions, account data, push rules (+ stream), pushers, media
// metadata, filters, client transaction ids. The old `account_data_seq`
// sequence becomes a row in `counters`, advanced inside the same
// transaction as the write it stamps (no sequences). The store owns the
// id row and the meta table; this provider owns everything else.
import type { SchemaProvider } from '#engine/store/create.ts';
import { recordPusherChange } from '#engine/tenant/pushers.ts';
import {
  BACKUP_ACCOUNTING_SQL,
  migrateBackupAccounting,
} from '#engine/tenant/backup-accounting.ts';

const E2EE_SQL = `
CREATE TABLE device_keys(localpart TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL, key_json TEXT NOT NULL, PRIMARY KEY(localpart,device_id,generation));
CREATE TABLE one_time_keys(localpart TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL, algorithm TEXT NOT NULL, key_id TEXT NOT NULL, upload_pos INTEGER NOT NULL, key_json TEXT NOT NULL, PRIMARY KEY(localpart,device_id,generation,algorithm,key_id));
CREATE INDEX one_time_keys_fifo ON one_time_keys(localpart,device_id,generation,algorithm,upload_pos,key_id);
CREATE TABLE fallback_keys(localpart TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL, algorithm TEXT NOT NULL, key_id TEXT NOT NULL, key_json TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY(localpart,device_id,generation,algorithm));
CREATE TABLE key_pool_updates(localpart TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(localpart,device_id,generation));
CREATE TABLE user_device_stream(localpart TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL);
CREATE TABLE e2ee_changes(pos INTEGER PRIMARY KEY NOT NULL, localpart TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL, stream_id INTEGER NOT NULL, payload TEXT NOT NULL);
`;

const INBOX_SQL = `
CREATE TABLE to_device_inbox(localpart TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL, msg_pos INTEGER NOT NULL, source_id TEXT NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(localpart,device_id,generation,msg_pos), UNIQUE(localpart,device_id,generation,source_id));
CREATE TABLE to_device_transactions(localpart TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL, event_type TEXT NOT NULL, txn_id TEXT NOT NULL, PRIMARY KEY(localpart,device_id,generation,event_type,txn_id));
CREATE TABLE sync_deliveries(localpart TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL, token_hash TEXT NOT NULL, to_msg_pos INTEGER NOT NULL, PRIMARY KEY(localpart,device_id,generation,token_hash));
CREATE TABLE device_ack(localpart TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL, msg_pos INTEGER NOT NULL, PRIMARY KEY(localpart,device_id,generation));
CREATE TABLE to_device_intents(source_id TEXT PRIMARY KEY NOT NULL, destination TEXT NOT NULL, payload TEXT NOT NULL);
`;

const TRANSPORT_SQL = `
ALTER TABLE to_device_intents ADD COLUMN sender TEXT NOT NULL DEFAULT '';
CREATE INDEX to_device_intents_sender ON to_device_intents(sender);
CREATE TABLE inbound_to_device(origin TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(origin,message_id));
`;

const INTENT_PROJECTION_SQL = `
ALTER TABLE to_device_intents ADD COLUMN projected INTEGER NOT NULL DEFAULT 0;
CREATE INDEX to_device_intents_projection ON to_device_intents(projected);
`;

const INTENT_DESTINATION_SQL = `
CREATE INDEX to_device_intents_destination ON to_device_intents(destination);
`;

const CROSS_SIGNING_SQL = `
CREATE TABLE cross_signing_keys(localpart TEXT NOT NULL, usage TEXT NOT NULL, key_id TEXT NOT NULL, key_json TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(localpart,usage));
CREATE INDEX cross_signing_ids ON cross_signing_keys(localpart,key_id);
`;

const KEY_SIGNATURES_SQL = `
CREATE TABLE key_signatures(signer_localpart TEXT NOT NULL, signer_user TEXT NOT NULL, signer_key TEXT NOT NULL, signer_basis TEXT NOT NULL, target_user TEXT NOT NULL, target_key TEXT NOT NULL, target_material TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(signer_localpart,signer_key,target_user,target_key));
CREATE INDEX key_signatures_target ON key_signatures(target_user,target_key);
`;

const KEY_BACKUP_SQL = `
CREATE TABLE backup_versions(localpart TEXT NOT NULL, version_no INTEGER NOT NULL, algorithm TEXT NOT NULL, auth_data TEXT NOT NULL, etag INTEGER NOT NULL, deleted INTEGER NOT NULL, PRIMARY KEY(localpart,version_no));
CREATE INDEX backup_versions_current ON backup_versions(localpart,deleted,version_no);
CREATE TABLE backup_sessions(localpart TEXT NOT NULL, version_no INTEGER NOT NULL, room_id TEXT NOT NULL, session_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(localpart,version_no,room_id,session_id));
`;

export const TENANT_SCHEMA_SQL = `
CREATE TABLE tenant(
  server_name TEXT PRIMARY KEY NOT NULL,
  native_name TEXT NOT NULL,
  pubkey_b64 TEXT NOT NULL,
  privkey_enc TEXT NOT NULL,
  key_id TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);

CREATE TABLE users(
  localpart TEXT PRIMARY KEY NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  deactivated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE credentials(
  localpart TEXT PRIMARY KEY NOT NULL REFERENCES users(localpart),
  kind TEXT NOT NULL,
  hash TEXT NOT NULL,
  salt TEXT,
  params TEXT
);

CREATE TABLE devices(
  device_id TEXT NOT NULL,
  localpart TEXT NOT NULL REFERENCES users(localpart),
  generation INTEGER NOT NULL,
  display_name TEXT,
  PRIMARY KEY(localpart, device_id)
);
CREATE INDEX devices_localpart ON devices(localpart);

-- token is the hex sha-256 of the presented token; the plain token only
-- ever leaves the server at issue time.
CREATE TABLE access_tokens(
  token TEXT PRIMARY KEY NOT NULL,
  localpart TEXT NOT NULL REFERENCES users(localpart),
  device_id TEXT,
  generation INTEGER,
  expires_ms INTEGER
);
CREATE INDEX access_tokens_localpart ON access_tokens(localpart);
CREATE INDEX access_tokens_device ON access_tokens(localpart, device_id, generation);

CREATE TABLE refresh_tokens(
  token TEXT PRIMARY KEY NOT NULL,
  localpart TEXT NOT NULL,
  device_id TEXT,
  generation INTEGER,
  access_token TEXT NOT NULL REFERENCES access_tokens(token),
  next_token TEXT
);
CREATE INDEX refresh_tokens_access ON refresh_tokens(access_token);
CREATE INDEX refresh_tokens_next ON refresh_tokens(next_token);

CREATE TABLE uia_sessions(
  session TEXT PRIMARY KEY NOT NULL,
  flows TEXT NOT NULL,
  completed TEXT NOT NULL DEFAULT '[]',
  created_ms INTEGER NOT NULL
);

-- Per-tenant counters (the old account_data_seq): the account-data and
-- push-rule streams both stamp from 'account_data'. Advanced inside the
-- same tenant transaction as the write it stamps.
CREATE TABLE counters(
  name TEXT PRIMARY KEY NOT NULL,
  value INTEGER NOT NULL
);

CREATE TABLE account_data(
  localpart TEXT NOT NULL REFERENCES users(localpart),
  room_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  seq INTEGER,
  PRIMARY KEY(localpart, room_id, type)
);

CREATE TABLE push_rules(
  localpart TEXT NOT NULL REFERENCES users(localpart),
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  priority INTEGER NOT NULL,
  actions TEXT NOT NULL,
  conditions TEXT,
  pattern TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  seq INTEGER,
  PRIMARY KEY(localpart, scope, kind, rule_id)
);
-- migrateRoomRules looks up (kind, rule_id) across all localparts.
CREATE INDEX push_rules_kind ON push_rules(kind, rule_id);

CREATE TABLE push_rules_stream(
  localpart TEXT PRIMARY KEY NOT NULL REFERENCES users(localpart),
  seq INTEGER
);

CREATE TABLE pushers(
  localpart TEXT NOT NULL REFERENCES users(localpart),
  app_id TEXT NOT NULL,
  pushkey TEXT NOT NULL,
  kind TEXT NOT NULL,
  app_display_name TEXT NOT NULL,
  device_display_name TEXT NOT NULL,
  profile_tag TEXT,
  lang TEXT NOT NULL,
  data TEXT NOT NULL,
  access_token TEXT NOT NULL REFERENCES access_tokens(token),
  PRIMARY KEY(localpart, app_id, pushkey)
);
-- Token revocation and device deletion delete a token's pushers.
CREATE INDEX pushers_access_token ON pushers(access_token);

CREATE TABLE media(
  media_id TEXT PRIMARY KEY NOT NULL,
  localpart TEXT NOT NULL REFERENCES users(localpart),
  state TEXT NOT NULL,
  content_type TEXT,
  filename TEXT,
  size_bytes INTEGER,
  created_ms INTEGER NOT NULL,
  uploaded_ms INTEGER
);

CREATE TABLE filters(
  localpart TEXT NOT NULL REFERENCES users(localpart),
  filter_id TEXT NOT NULL,
  filter TEXT NOT NULL,
  PRIMARY KEY(localpart, filter_id)
);

CREATE TABLE transactions(
  localpart TEXT NOT NULL,
  device_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  room_id TEXT NOT NULL,
  txn_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  pending_pdu TEXT,
  completed INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(localpart, device_id, generation, endpoint, txn_id)
);
CREATE INDEX transactions_event ON transactions(localpart, device_id, generation, room_id, event_id);
`;

// Durable account lifecycle source, including accounts already deactivated when
// upgrading. Projection acknowledges this stream only with its server effects.
const ACCOUNT_CHANGES_SQL = `
CREATE TABLE account_changes(pos INTEGER PRIMARY KEY NOT NULL, localpart TEXT NOT NULL, kind TEXT NOT NULL);
INSERT INTO account_changes SELECT rowid,localpart,'deactivated' FROM users WHERE deactivated=1;
INSERT INTO counters(name,value) SELECT 'account_changes',COALESCE(MAX(pos),0) FROM account_changes;
`;

const PUSHER_CHANGES_SQL = `
ALTER TABLE pushers ADD COLUMN incarnation TEXT NOT NULL DEFAULT '';
ALTER TABLE pushers ADD COLUMN added_ms INTEGER NOT NULL DEFAULT 0;
CREATE TABLE pusher_changes(pos INTEGER PRIMARY KEY NOT NULL,localpart TEXT NOT NULL,app_id TEXT NOT NULL,pushkey TEXT NOT NULL,incarnation TEXT NOT NULL,payload TEXT);
CREATE INDEX pushers_identity ON pushers(app_id,pushkey);
`;

const OPENID_SQL = `
CREATE TABLE openid_tokens(token_hash TEXT PRIMARY KEY NOT NULL, localpart TEXT NOT NULL REFERENCES users(localpart), expires_ms INTEGER NOT NULL);
CREATE INDEX openid_tokens_expiry ON openid_tokens(expires_ms);
CREATE INDEX openid_tokens_user ON openid_tokens(localpart);
`;

const PROFILE_SQL = `
CREATE TABLE profile_fields(localpart TEXT NOT NULL REFERENCES users(localpart), key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(localpart,key));
`;

const ERASURE_SQL =
  `CREATE TABLE erased_users(localpart TEXT PRIMARY KEY NOT NULL REFERENCES users(localpart), room_cuts TEXT NOT NULL);`;

export const tenantSchema: SchemaProvider = {
  version: 18,
  apply: async (db) => {
    await db.exec(TENANT_SCHEMA_SQL);
    await db.exec(E2EE_SQL);
    await db.exec(INBOX_SQL);
    await db.exec(TRANSPORT_SQL);
    await db.exec(INTENT_PROJECTION_SQL);
    await db.exec(INTENT_DESTINATION_SQL);
    await db.exec(CROSS_SIGNING_SQL);
    await db.exec(KEY_SIGNATURES_SQL);
    await db.exec(KEY_BACKUP_SQL);
    await db.exec(ACCOUNT_CHANGES_SQL);
    await db.exec(PUSHER_CHANGES_SQL);
    await db.exec(OPENID_SQL);
    await db.exec(PROFILE_SQL);
    await db.exec(ERASURE_SQL);
    await db.exec(BACKUP_ACCOUNTING_SQL);
  },
  migrations: {
    17: migrateBackupAccounting,
    16: (conn) => conn.exec(ERASURE_SQL),
    15: (conn) => conn.exec(PROFILE_SQL),
    14: (conn) => conn.exec(OPENID_SQL),
    13: async (conn) => {
      await conn.exec(PUSHER_CHANGES_SQL);
      for (const row of await conn.query('SELECT * FROM pushers')) {
        const incarnation = crypto.randomUUID();
        const added = Date.now();
        await conn.execute(
          'UPDATE pushers SET incarnation=?,added_ms=? WHERE localpart=? AND app_id=? AND pushkey=?',
          [incarnation, added, row.localpart, row.app_id, row.pushkey],
        );
        await recordPusherChange(
          conn,
          { ...row, incarnation, added_ms: added },
          false,
        );
      }
    },
    12: (conn) => conn.exec(ACCOUNT_CHANGES_SQL),
    11: (conn) => conn.exec(KEY_BACKUP_SQL),
    10: (conn) => conn.exec(KEY_SIGNATURES_SQL),
    9: (conn) => conn.exec(CROSS_SIGNING_SQL),
    8: (conn) => conn.exec(INTENT_DESTINATION_SQL),
    7: (conn) => conn.exec(INTENT_PROJECTION_SQL),
    6: async (conn) => {
      await conn.exec(TRANSPORT_SQL);
      for (
        const row of await conn.query(
          'SELECT source_id,payload FROM to_device_intents',
        )
      ) {
        const { sender } = JSON.parse(String(row.payload));
        await conn.execute(
          'UPDATE to_device_intents SET sender=? WHERE source_id=?',
          [sender, row.source_id],
        );
      }
    },
    5: (conn) => conn.exec(INBOX_SQL),
    4: (conn) => conn.exec(E2EE_SQL),
    3: async (conn) => {
      await conn.exec(`
        ALTER TABLE devices RENAME TO devices_v3;
        DROP INDEX devices_localpart;
        CREATE TABLE devices(
          device_id TEXT NOT NULL,
          localpart TEXT NOT NULL REFERENCES users(localpart),
          generation INTEGER NOT NULL,
          display_name TEXT,
          PRIMARY KEY(localpart, device_id)
        );
        INSERT INTO devices SELECT device_id, localpart, 1, display_name FROM devices_v3;
        DROP TABLE devices_v3;
        CREATE INDEX devices_localpart ON devices(localpart);
        INSERT INTO counters(name, value) VALUES('device_generation', 1);
        ALTER TABLE access_tokens ADD COLUMN generation INTEGER;
        ALTER TABLE refresh_tokens ADD COLUMN generation INTEGER;
        UPDATE access_tokens SET generation = 1 WHERE EXISTS(
          SELECT 1 FROM devices WHERE devices.localpart = access_tokens.localpart AND devices.device_id = access_tokens.device_id
        );
        UPDATE refresh_tokens SET generation = 1 WHERE EXISTS(
          SELECT 1 FROM devices WHERE devices.localpart = refresh_tokens.localpart AND devices.device_id = refresh_tokens.device_id
        );
        DROP INDEX access_tokens_device;
        CREATE INDEX access_tokens_device ON access_tokens(localpart, device_id, generation);
        ALTER TABLE transactions RENAME TO transactions_v3;
        DROP INDEX transactions_event;
        CREATE TABLE transactions(
          localpart TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL,
          endpoint TEXT NOT NULL, room_id TEXT NOT NULL, txn_id TEXT NOT NULL, event_id TEXT NOT NULL,
          pending_pdu TEXT, completed INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY(localpart, device_id, generation, endpoint, txn_id)
        );
        INSERT INTO transactions SELECT d.localpart, t.device_id, d.generation,
          t.endpoint, t.room_id, t.txn_id, t.event_id, t.pending_pdu, t.completed
          FROM transactions_v3 t JOIN devices d ON d.device_id = t.device_id;
        CREATE INDEX transactions_event ON transactions(localpart, device_id, generation, room_id, event_id);
      `);
      // Keep v3 receipts as a read-only archive: deleted devices have no
      // provable owner. Never attribute those receipts to a new incarnation.
    },
  },
};
