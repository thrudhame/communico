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

const E2EE_SQL = `
CREATE TABLE device_keys(localpart TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL, key_json TEXT NOT NULL, PRIMARY KEY(localpart,device_id,generation));
CREATE TABLE one_time_keys(localpart TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL, algorithm TEXT NOT NULL, key_id TEXT NOT NULL, upload_pos INTEGER NOT NULL, key_json TEXT NOT NULL, PRIMARY KEY(localpart,device_id,generation,algorithm,key_id));
CREATE INDEX one_time_keys_fifo ON one_time_keys(localpart,device_id,generation,algorithm,upload_pos,key_id);
CREATE TABLE fallback_keys(localpart TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL, algorithm TEXT NOT NULL, key_id TEXT NOT NULL, key_json TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY(localpart,device_id,generation,algorithm));
CREATE TABLE key_pool_updates(localpart TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(localpart,device_id,generation));
CREATE TABLE user_device_stream(localpart TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL);
CREATE TABLE e2ee_changes(pos INTEGER PRIMARY KEY NOT NULL, localpart TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL, stream_id INTEGER NOT NULL, payload TEXT NOT NULL);
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

export const tenantSchema: SchemaProvider = {
  version: 5,
  apply: async (db) => {
    await db.exec(TENANT_SCHEMA_SQL);
    await db.exec(E2EE_SQL);
  },
  migrations: {
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
