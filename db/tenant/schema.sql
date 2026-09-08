-- db/tenant/schema.sql — per-tenant identity DB (F1). One Doltgres
-- database per tenant: mirrors db-per-room; tenant = blast radius.
-- Provisioned by ensureTenant (api/engine/tenant.ts), never by hand.
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
  display_name text
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
