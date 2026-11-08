// Frozen production v3 layout for upgrade tests. Do not derive from today's schema.
export const TENANT_V3 = `
CREATE TABLE tenant(server_name TEXT PRIMARY KEY NOT NULL, native_name TEXT NOT NULL,
 pubkey_b64 TEXT NOT NULL, privkey_enc TEXT NOT NULL, key_id TEXT NOT NULL, created_ms INTEGER NOT NULL);
CREATE TABLE users(localpart TEXT PRIMARY KEY NOT NULL, display_name TEXT, avatar_url TEXT, deactivated INTEGER NOT NULL DEFAULT 0);
CREATE TABLE credentials(localpart TEXT PRIMARY KEY NOT NULL REFERENCES users(localpart), kind TEXT NOT NULL, hash TEXT NOT NULL, salt TEXT, params TEXT);
CREATE TABLE devices(device_id TEXT PRIMARY KEY NOT NULL, localpart TEXT NOT NULL REFERENCES users(localpart), display_name TEXT);
CREATE INDEX devices_localpart ON devices(localpart);
CREATE TABLE access_tokens(token TEXT PRIMARY KEY NOT NULL, localpart TEXT NOT NULL REFERENCES users(localpart), device_id TEXT, expires_ms INTEGER);
CREATE INDEX access_tokens_localpart ON access_tokens(localpart);
CREATE INDEX access_tokens_device ON access_tokens(device_id);
CREATE TABLE refresh_tokens(token TEXT PRIMARY KEY NOT NULL, localpart TEXT NOT NULL, device_id TEXT, access_token TEXT NOT NULL REFERENCES access_tokens(token), next_token TEXT);
CREATE INDEX refresh_tokens_access ON refresh_tokens(access_token);
CREATE INDEX refresh_tokens_next ON refresh_tokens(next_token);
CREATE TABLE uia_sessions(session TEXT PRIMARY KEY NOT NULL, flows TEXT NOT NULL, completed TEXT NOT NULL DEFAULT '[]', created_ms INTEGER NOT NULL);
CREATE TABLE counters(name TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL);
CREATE TABLE account_data(localpart TEXT NOT NULL REFERENCES users(localpart), room_id TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, content TEXT NOT NULL, seq INTEGER, PRIMARY KEY(localpart,room_id,type));
CREATE TABLE push_rules(localpart TEXT NOT NULL REFERENCES users(localpart), scope TEXT NOT NULL, kind TEXT NOT NULL, rule_id TEXT NOT NULL, priority INTEGER NOT NULL, actions TEXT NOT NULL, conditions TEXT, pattern TEXT, enabled INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0, seq INTEGER, PRIMARY KEY(localpart,scope,kind,rule_id));
CREATE INDEX push_rules_kind ON push_rules(kind,rule_id);
CREATE TABLE push_rules_stream(localpart TEXT PRIMARY KEY NOT NULL REFERENCES users(localpart), seq INTEGER);
CREATE TABLE pushers(localpart TEXT NOT NULL REFERENCES users(localpart), app_id TEXT NOT NULL, pushkey TEXT NOT NULL, kind TEXT NOT NULL, app_display_name TEXT NOT NULL, device_display_name TEXT NOT NULL, profile_tag TEXT, lang TEXT NOT NULL, data TEXT NOT NULL, access_token TEXT NOT NULL REFERENCES access_tokens(token), PRIMARY KEY(localpart,app_id,pushkey));
CREATE INDEX pushers_access_token ON pushers(access_token);
CREATE TABLE media(media_id TEXT PRIMARY KEY NOT NULL, localpart TEXT NOT NULL REFERENCES users(localpart), state TEXT NOT NULL, content_type TEXT, filename TEXT, size_bytes INTEGER, created_ms INTEGER NOT NULL, uploaded_ms INTEGER);
CREATE TABLE filters(localpart TEXT NOT NULL REFERENCES users(localpart), filter_id TEXT NOT NULL, filter TEXT NOT NULL, PRIMARY KEY(localpart,filter_id));
CREATE TABLE transactions(device_id TEXT NOT NULL, endpoint TEXT NOT NULL, room_id TEXT NOT NULL, txn_id TEXT NOT NULL, event_id TEXT NOT NULL, pending_pdu TEXT, completed INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(device_id,endpoint,txn_id));
CREATE INDEX transactions_event ON transactions(device_id,room_id,event_id);
`;
