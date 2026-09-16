-- db/tenant/schema.sql — per-tenant identity DB (F1). One Doltgres
-- database per tenant: mirrors db-per-room; tenant = blast radius.
-- Provisioned by ensureTenant (api/engine/tenant.ts), never by hand.
--
-- M2 note: Doltgres has no ALTER … ADD COLUMN IF NOT EXISTS. Tenants
-- provisioned before M2 need a one-time manual ALTER for the users-table
-- additions:
--   ALTER TABLE users ADD COLUMN avatar_url text;
--   ALTER TABLE users ADD COLUMN deactivated boolean NOT NULL DEFAULT false;
-- Dev/VM/Complement always provision fresh (demo/setup.sh --reset).
CREATE TABLE IF NOT EXISTS tenant (
  server_name text PRIMARY KEY,
  native_name text NOT NULL,
  pubkey_b64 text NOT NULL,
  privkey_enc text NOT NULL,
  key_id text NOT NULL,
  created_ms bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  localpart text PRIMARY KEY,
  display_name text,
  avatar_url text,                                  -- M2
  deactivated boolean NOT NULL DEFAULT false        -- M2
);
-- credentials: argon2id rows store kind + the PHC string (algorithm,
-- params and salt are encoded in-band — salt/params stay NULL). The
-- nullable columns exist for the documented node:crypto-scrypt fallback
-- (BLOCKER-F1-CREDENTIALS.md): kind makes it a data migration.
CREATE TABLE IF NOT EXISTS credentials (
  localpart text PRIMARY KEY REFERENCES users(localpart),
  kind text NOT NULL,
  hash text NOT NULL,
  salt text,
  params text
);
CREATE TABLE IF NOT EXISTS devices (
  device_id text PRIMARY KEY,
  localpart text NOT NULL REFERENCES users(localpart),
  display_name text
);
CREATE TABLE IF NOT EXISTS access_tokens (
  token text PRIMARY KEY,
  localpart text NOT NULL REFERENCES users(localpart),
  device_id text
);
CREATE TABLE IF NOT EXISTS uia_sessions (
  session text PRIMARY KEY,
  flows text NOT NULL,
  completed text NOT NULL DEFAULT '[]',
  created_ms bigint NOT NULL
);
-- M2: account data. room_id '' = global (PK columns cannot be NULL).
CREATE TABLE IF NOT EXISTS account_data (
  localpart text NOT NULL REFERENCES users(localpart),
  room_id text NOT NULL DEFAULT '',
  type text NOT NULL,
  content text NOT NULL,                            -- JSON text; Doltgres jsonb not assumed
  PRIMARY KEY (localpart, room_id, type)
);
-- M2: pushers (storage only; no gateway traffic until Push proper).
-- After access_tokens: the FK reference must resolve at CREATE time
-- (runSqlFile executes statements in file order).
CREATE TABLE IF NOT EXISTS pushers (
  localpart text NOT NULL REFERENCES users(localpart),
  app_id text NOT NULL,
  pushkey text NOT NULL,
  kind text NOT NULL,
  app_display_name text NOT NULL,
  device_display_name text NOT NULL,
  profile_tag text,
  lang text NOT NULL,
  data text NOT NULL,                               -- JSON text
  access_token text NOT NULL REFERENCES access_tokens(token),
  PRIMARY KEY (localpart, app_id, pushkey)
);
-- M2: media metadata; bytes live at $MEDIA_ROOT/<media_id>.
CREATE TABLE IF NOT EXISTS media (
  media_id text PRIMARY KEY,
  localpart text NOT NULL REFERENCES users(localpart),
  state text NOT NULL,                              -- 'pending' | 'uploaded'
  content_type text,
  filename text,
  size_bytes bigint,
  created_ms bigint NOT NULL,
  uploaded_ms bigint
);
-- M4: stored /sync filters (POST /user/:id/filter). filter_id is the
-- server-assigned id (serial string); the filter document verbatim.
CREATE TABLE IF NOT EXISTS filters (
  localpart text NOT NULL REFERENCES users(localpart),
  filter_id text NOT NULL,
  filter jsonb NOT NULL,
  PRIMARY KEY (localpart, filter_id)
);
-- M4: transaction idempotency scoped to (device, room, txn) — a repeat
-- send returns the recorded event_id regardless of content.
CREATE TABLE IF NOT EXISTS transactions (
  device_id text NOT NULL,
  room_id text NOT NULL,
  txn_id text NOT NULL,
  event_id text NOT NULL,
  PRIMARY KEY (device_id, room_id, txn_id)
);
