// Semantic operation/control storage shared by their owning server/tenant files.
// Neither importing a record nor possession of a replica grants write authority.
export const OWNER_CONTROL_SQL = `
CREATE TABLE facade_owner_controls(pairing TEXT NOT NULL,revision INTEGER NOT NULL,body_hash TEXT NOT NULL,signed_json TEXT NOT NULL,PRIMARY KEY(pairing,revision));
CREATE TABLE facade_owner_activation(pairing TEXT PRIMARY KEY NOT NULL,revision INTEGER NOT NULL,body_hash TEXT NOT NULL);
CREATE TABLE domain_operations(operation_id TEXT PRIMARY KEY NOT NULL,source TEXT NOT NULL,incarnation TEXT NOT NULL,stream TEXT NOT NULL,sequence INTEGER NOT NULL,semantic_key TEXT NOT NULL,kind TEXT NOT NULL,context_json TEXT NOT NULL,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL,applied INTEGER NOT NULL DEFAULT 0,UNIQUE(source,incarnation,stream,sequence));
CREATE INDEX domain_operations_key ON domain_operations(semantic_key);
CREATE TABLE domain_frontiers(semantic_key TEXT NOT NULL,operation_id TEXT NOT NULL REFERENCES domain_operations(operation_id),PRIMARY KEY(semantic_key,operation_id));
CREATE TABLE domain_conflicts(semantic_key TEXT NOT NULL,operation_id TEXT NOT NULL REFERENCES domain_operations(operation_id),PRIMARY KEY(semantic_key,operation_id));
`;

export const PUBLICATION_DOMAIN_SQL = `
CREATE TABLE publication_domain(singleton INTEGER PRIMARY KEY CHECK(singleton=1),node TEXT NOT NULL,incarnation TEXT NOT NULL,domain TEXT NOT NULL);
`;
