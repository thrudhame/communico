// Server-owned protocol continuity. Payloads do not expire with federation_txns.
export const FACADE_JOURNAL_SQL = `
CREATE TABLE facade_node(singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),server_name TEXT NOT NULL,node_id TEXT NOT NULL,incarnation TEXT NOT NULL,key_id TEXT NOT NULL,public_key TEXT NOT NULL,private_key TEXT NOT NULL,created_ms INTEGER NOT NULL);
CREATE TABLE facade_streams(peer TEXT NOT NULL,direction TEXT NOT NULL CHECK(direction IN ('in','out')),source TEXT NOT NULL,incarnation TEXT NOT NULL,stream TEXT NOT NULL,received INTEGER NOT NULL DEFAULT 0,received_hash TEXT NOT NULL DEFAULT '',applied INTEGER NOT NULL DEFAULT 0,applied_hash TEXT NOT NULL DEFAULT '',PRIMARY KEY(peer,direction,source,incarnation,stream));
CREATE TABLE facade_records(peer TEXT NOT NULL,direction TEXT NOT NULL,source TEXT NOT NULL,incarnation TEXT NOT NULL,stream TEXT NOT NULL,sequence INTEGER NOT NULL,operation_id TEXT NOT NULL,hash TEXT NOT NULL,record_json TEXT NOT NULL,bytes INTEGER NOT NULL,result_json TEXT,PRIMARY KEY(peer,direction,source,incarnation,stream,sequence),UNIQUE(peer,direction,source,incarnation,operation_id));
CREATE INDEX facade_records_pending ON facade_records(peer,direction,source,incarnation,stream,sequence);
CREATE TABLE facade_export_acks(peer TEXT NOT NULL,source TEXT NOT NULL,incarnation TEXT NOT NULL,stream TEXT NOT NULL,received INTEGER NOT NULL,received_hash TEXT NOT NULL,applied INTEGER NOT NULL,applied_hash TEXT NOT NULL,PRIMARY KEY(peer,source,incarnation,stream));
`;

export const FACADE_PAIRING_SQL = `
CREATE TABLE facade_control(singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),revision INTEGER NOT NULL);
INSERT INTO facade_control(singleton,revision) VALUES(1,0);
CREATE TABLE facade_pairings(id TEXT PRIMARY KEY NOT NULL,side TEXT NOT NULL CHECK(side IN ('home','facade')),node TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','granting','paired','revoked')),context_json TEXT NOT NULL,transcript_json TEXT,grant_json TEXT,receipt_json TEXT,revocation_json TEXT,revision INTEGER NOT NULL DEFAULT 0);
CREATE INDEX facade_pairings_node ON facade_pairings(node,state);
`;

export const RUNTIME_IDENTITY_SQL = `
CREATE TABLE runtime_identity(singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),role TEXT NOT NULL CHECK(role IN ('home','facade')),server_name TEXT NOT NULL,node_id TEXT NOT NULL,initialized INTEGER NOT NULL CHECK(initialized IN (0,1)));
`;
