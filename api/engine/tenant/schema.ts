// api/engine/tenant/schema.ts - tenant schema v2 (design row 1, D3.2): the
// tenant file's tables, re-expressed for SQLite/Turso from
// doltgres:db/tenant/schema.sql — identity and signing keys, users and
// credentials, devices, access/refresh tokens (stored hashed, not plain),
// UIA sessions, account data, push rules (+ stream), pushers, media
// metadata, filters, client transaction ids. The old `account_data_seq`
// sequence becomes a row in `counters`, advanced inside the same
// transaction as the write it stamps (no sequences). The store owns the
// id row and the meta table; this provider owns everything else.
import type { SchemaProvider } from '#engine/store/create.ts';

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
  device_id TEXT PRIMARY KEY NOT NULL,
  localpart TEXT NOT NULL REFERENCES users(localpart),
  display_name TEXT
);
CREATE INDEX devices_localpart ON devices(localpart);

-- token is the hex sha-256 of the presented token; the plain token only
-- ever leaves the server at issue time.
CREATE TABLE access_tokens(
  token TEXT PRIMARY KEY NOT NULL,
  localpart TEXT NOT NULL REFERENCES users(localpart),
  device_id TEXT,
  expires_ms INTEGER
);
CREATE INDEX access_tokens_localpart ON access_tokens(localpart);
CREATE INDEX access_tokens_device ON access_tokens(device_id);

CREATE TABLE refresh_tokens(
  token TEXT PRIMARY KEY NOT NULL,
  localpart TEXT NOT NULL,
  device_id TEXT,
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
  device_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  txn_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  pending_pdu TEXT,
  completed INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(device_id, room_id, txn_id)
);
`;

export const tenantSchema: SchemaProvider = {
  version: 2,
  apply: async (db) => {
    await db.exec(TENANT_SCHEMA_SQL);
  },
};
