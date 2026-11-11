// Released layouts, independent of today's schema provider. Composing the
// historical SQL steps keeps later schema additions out of older fixtures.
import { TENANT_V12 } from '#tests/fixtures/tenant-v12.ts';

export const TENANT_V14 = TENANT_V12 + `
CREATE TABLE account_changes(pos INTEGER PRIMARY KEY NOT NULL, localpart TEXT NOT NULL, kind TEXT NOT NULL);
INSERT INTO counters(name,value) VALUES('account_changes',0);
ALTER TABLE pushers ADD COLUMN incarnation TEXT NOT NULL DEFAULT '';
ALTER TABLE pushers ADD COLUMN added_ms INTEGER NOT NULL DEFAULT 0;
CREATE TABLE pusher_changes(pos INTEGER PRIMARY KEY NOT NULL,localpart TEXT NOT NULL,app_id TEXT NOT NULL,pushkey TEXT NOT NULL,incarnation TEXT NOT NULL,payload TEXT);
CREATE INDEX pushers_identity ON pushers(app_id,pushkey);
`;

export const TENANT_V15 = TENANT_V14 + `
CREATE TABLE openid_tokens(token_hash TEXT PRIMARY KEY NOT NULL,localpart TEXT NOT NULL REFERENCES users(localpart),expires_ms INTEGER NOT NULL);
CREATE INDEX openid_tokens_expiry ON openid_tokens(expires_ms);
CREATE INDEX openid_tokens_user ON openid_tokens(localpart);
`;

export const TENANT_V17 = TENANT_V15 + `
CREATE TABLE profile_fields(localpart TEXT NOT NULL REFERENCES users(localpart),key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(localpart,key));
CREATE TABLE erased_users(localpart TEXT PRIMARY KEY NOT NULL REFERENCES users(localpart),room_cuts TEXT NOT NULL);
`;
