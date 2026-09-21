-- db/tenant/schema.sql — per-tenant identity DB (F1). One Doltgres
-- database per tenant: mirrors db-per-room; tenant = blast radius.
-- Provisioned by ensureTenant (api/engine/tenant.ts), never by hand.
--
-- M2 note: Doltgres has no ALTER … ADD COLUMN IF NOT EXISTS. Tenants
-- provisioned before M2 need a one-time manual ALTER for the users-table
-- additions:
--   ALTER TABLE users ADD COLUMN avatar_url text;
--   ALTER TABLE users ADD COLUMN deactivated boolean NOT NULL DEFAULT false;
-- (band C): ALTER TABLE access_tokens ADD COLUMN expires_ms bigint;
--   CREATE TABLE refresh_tokens (token text PRIMARY KEY, localpart text,
--     device_id text, access_token text);
-- (v12): ALTER TABLE account_data ADD COLUMN seq bigint;
--   CREATE SEQUENCE account_data_seq;
--   CREATE TABLE push_rules (localpart text, scope text, kind text,
--     rule_id text, priority bigint, actions text, conditions text,
--     pattern text, enabled boolean, is_default boolean, seq bigint,
--     PRIMARY KEY (localpart, scope, kind, rule_id));
--   CREATE TABLE push_rules_stream (localpart text PRIMARY KEY, seq bigint);
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
  device_id text,
  -- band C (D8): informational only — advertised as expires_in_ms at
  -- login/refresh, never enforced (spec: optional; say so in code)
  expires_ms bigint
);
-- band C (D8): refresh tokens, device-scoped — a /refresh rotates BOTH
-- tokens for the same device (txn idempotency keeps working), revoking
-- the old access token and consuming the old refresh row (plan 3h).
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token text PRIMARY KEY,
  localpart text NOT NULL,
  device_id text,
  access_token text NOT NULL REFERENCES access_tokens(token)
);
CREATE TABLE IF NOT EXISTS uia_sessions (
  session text PRIMARY KEY,
  flows text NOT NULL,
  completed text NOT NULL DEFAULT '[]',
  created_ms bigint NOT NULL
);
-- M2: account data. room_id '' = global (PK columns cannot be NULL).
-- v12 plan (D9): seq on the shared account_data_seq stream — incremental
-- syncs deliver rows with seq > the token's _a<n>, long-polls wake on it.
CREATE SEQUENCE IF NOT EXISTS account_data_seq;
CREATE TABLE IF NOT EXISTS account_data (
  localpart text NOT NULL REFERENCES users(localpart),
  room_id text NOT NULL DEFAULT '',
  type text NOT NULL,
  content text NOT NULL,                            -- JSON text; Doltgres jsonb not assumed
  seq bigint,
  PRIMARY KEY (localpart, room_id, type)
);
-- v12 plan (D9): push rules. The store behind /pushrules; m.push_rules is
-- synthesised from this table on read, never stored as account_data.
-- spec default rules (.m.rule.*) are NOT seeded here — the push
-- milestone. seq shares the account_data_seq stream so a rule mutation
-- moves the sync token's _a<n> (D10).
CREATE TABLE IF NOT EXISTS push_rules (
  localpart text NOT NULL REFERENCES users(localpart),
  scope text NOT NULL,
  kind text NOT NULL,
  rule_id text NOT NULL,
  priority bigint NOT NULL,
  actions text NOT NULL,                              -- JSON text
  conditions text,
  pattern text,
  enabled boolean NOT NULL DEFAULT TRUE,
  is_default boolean NOT NULL DEFAULT FALSE,
  seq bigint,
  PRIMARY KEY (localpart, scope, kind, rule_id)
);
-- v12 plan (D9/D10): the push-rule stream marker. Every mutation stamps
-- it (put/delete/enabled/actions/migrate) — it exists precisely so a
-- delete that empties the table still moves the token's _a<n>.
CREATE TABLE IF NOT EXISTS push_rules_stream (
  localpart text PRIMARY KEY REFERENCES users(localpart),
  seq bigint
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
