// api/engine/tenant/media.ts — media metadata (M2): the tenant file's
// media table; the bytes live on disk under the media root (the serving
// half is the endpoints' — stage 5).
import type { Conn } from '#engine/store/db.ts';
import type { Tenant } from '#engine/tenant/index.ts';

/** One row of the tenant's media table. */
export type MediaRow = {
  media_id: string;
  localpart: string;
  state: 'pending' | 'uploaded';
  content_type: string | null;
  filename: string | null;
  size_bytes: number | null;
  created_ms: number;
  uploaded_ms: number | null;
};

/** The metadata an upload records (direct POST or async PUT). */
export type MediaMeta = {
  content_type?: string;
  filename?: string;
  size_bytes?: number;
};

// Local export intent. The immutable metadata and bytes are referenced, not
// duplicated. Receipt of a chunk never touches this obligation.
export const MEDIA_EXPORTS_SQL = `
CREATE TABLE media_exports(
  media_id TEXT PRIMARY KEY NOT NULL REFERENCES media(media_id),
  issuer TEXT NOT NULL,
  sha256 TEXT NOT NULL
);
`;

export const MEDIA_COPIES_SQL = `
CREATE TABLE media_export_confirmations(
  media_id TEXT NOT NULL REFERENCES media_exports(media_id),
  pairing TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY(media_id, pairing)
);
CREATE TABLE media_home_copies(
  media_id TEXT PRIMARY KEY NOT NULL,
  fingerprint TEXT NOT NULL,
  staged_bytes INTEGER NOT NULL,
  prefix_sha256 TEXT NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0
);
`;

export const MEDIA_WANTS_SQL = `
CREATE TABLE media_wants(
  media_id TEXT PRIMARY KEY NOT NULL,
  demand TEXT NOT NULL,
  manifest TEXT,
  bytes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE media_backing(
  media_id TEXT PRIMARY KEY NOT NULL REFERENCES media(media_id),
  pairing TEXT NOT NULL,
  fingerprint TEXT NOT NULL
);
`;

export async function wantedMedia(conn: Conn, id: string) {
  const [row] = await conn.query(
    'SELECT * FROM media_wants WHERE media_id = ?',
    [id],
  );
  return row
    ? {
      demand: String(row.demand),
      manifest: row.manifest == null ? null : String(row.manifest),
      bytes: Number(row.bytes),
    }
    : null;
}

export async function wantMedia(conn: Conn, id: string, demand: string) {
  await conn.execute(
    'INSERT INTO media_wants(media_id, demand) VALUES (?, ?) ON CONFLICT DO NOTHING',
    [id, demand],
  );
  return (await wantedMedia(conn, id))!;
}

export async function listWantedMedia(
  conn: Conn,
  after: string,
  limit: number,
) {
  const rows = await conn.query(
    'SELECT media_id, demand FROM media_wants WHERE media_id > ? ORDER BY media_id LIMIT ?',
    [after, limit],
  );
  return rows.map((row) => ({
    id: String(row.media_id),
    demand: String(row.demand),
  }));
}

export async function stageWantedMedia(
  conn: Conn,
  id: string,
  manifest: string,
  bytes: number,
) {
  await conn.execute(
    'UPDATE media_wants SET manifest = ?, bytes = ? WHERE media_id = ?',
    [manifest, bytes, id],
  );
}

export async function finishMediaWant(conn: Conn, id: string) {
  await conn.execute('DELETE FROM media_wants WHERE media_id = ?', [id]);
}

export async function mediaBacking(conn: Conn, id: string) {
  const [row] = await conn.query(
    'SELECT pairing, fingerprint FROM media_backing WHERE media_id = ?',
    [id],
  );
  return row
    ? { pairing: String(row.pairing), fingerprint: String(row.fingerprint) }
    : null;
}

// Complete local originals with proof from the current home. Keep the proof
// and uploaded row when capacity evicts the bytes. A staged cut is not proof.
export async function backedMedia(
  conn: Conn,
  pairing: string,
  issuer: string,
) {
  const rows = await conn.query(
    `SELECT m.*, b.fingerprint FROM media m JOIN media_backing b USING(media_id)
     WHERE b.pairing = ? AND m.state = 'uploaded'
     AND NOT EXISTS (SELECT 1 FROM media_wants w WHERE w.media_id = m.media_id)
     UNION
     SELECT m.*, c.fingerprint FROM media m JOIN media_exports e USING(media_id)
     JOIN media_export_confirmations c USING(media_id)
     WHERE c.pairing = ? AND e.issuer = ? AND m.state = 'uploaded'
     AND NOT EXISTS (SELECT 1 FROM media_wants w WHERE w.media_id = m.media_id)`,
    [pairing, pairing, issuer],
  );
  return rows.map((row) => ({
    row: rowOf(row),
    mark: String(row.fingerprint),
  }));
}

export async function exportConfirmation(conn: Conn, id: string) {
  const [row] = await conn.query(
    'SELECT fingerprint FROM media_export_confirmations WHERE media_id = ? LIMIT 1',
    [id],
  );
  return row ? String(row.fingerprint) : null;
}

export async function recordMediaBacking(
  conn: Conn,
  id: string,
  pairing: string,
  fingerprint: string,
) {
  await conn.execute(
    `INSERT INTO media_backing(media_id, pairing, fingerprint) VALUES (?, ?, ?)
     ON CONFLICT(media_id) DO UPDATE SET pairing = excluded.pairing`,
    [id, pairing, fingerprint],
  );
}

export type ExportRow = MediaRow & { sha256: string };

function exportRow(row: Parameters<typeof rowOf>[0]): ExportRow {
  return { ...rowOf(row), sha256: String(row.sha256) };
}

export async function mediaExportById(conn: Conn, issuer: string, id: string) {
  const rows = await conn.query(
    `SELECT m.*, e.sha256 FROM media_exports e JOIN media m USING(media_id)
     WHERE e.media_id = ? AND e.issuer = ? AND m.state = 'uploaded'`,
    [id, issuer],
  );
  return rows.length ? exportRow(rows[0]) : null;
}

export async function pendingMediaExports(
  conn: Conn,
  issuer: string,
  pairing: string,
  after: string,
  limit: number,
) {
  const rows = await conn.query(
    `SELECT m.*, e.sha256 FROM media_exports e JOIN media m USING(media_id)
     WHERE e.media_id > ? AND e.issuer = ? AND m.state = 'uploaded'
     AND NOT EXISTS (SELECT 1 FROM media_export_confirmations c
       WHERE c.media_id = e.media_id AND c.pairing = ?)
     ORDER BY e.media_id LIMIT ?`,
    [after, issuer, pairing, limit],
  );
  return rows.map(exportRow);
}

export async function confirmMediaExport(
  conn: Conn,
  id: string,
  pairing: string,
  fingerprint: string,
) {
  await conn.execute(
    `INSERT INTO media_export_confirmations(media_id, pairing, fingerprint)
     VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    [id, pairing, fingerprint],
  );
  const rows = await conn.query(
    'SELECT fingerprint FROM media_export_confirmations WHERE media_id = ? AND pairing = ?',
    [id, pairing],
  );
  return rows[0]?.fingerprint === fingerprint;
}

export async function homeMediaCopy(conn: Conn, id: string) {
  const rows = await conn.query(
    `SELECT fingerprint, staged_bytes, prefix_sha256, complete
     FROM media_home_copies WHERE media_id = ?`,
    [id],
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    fingerprint: String(row.fingerprint),
    bytes: Number(row.staged_bytes),
    sha256: String(row.prefix_sha256),
    complete: Number(row.complete) === 1,
  };
}

export async function beginMediaCopy(
  conn: Conn,
  id: string,
  fingerprint: string,
  sha256: string,
) {
  await conn.execute(
    `INSERT INTO media_home_copies(media_id, fingerprint, staged_bytes, prefix_sha256)
     VALUES (?, ?, 0, ?)`,
    [id, fingerprint, sha256],
  );
}

export async function advanceMediaCopy(
  conn: Conn,
  id: string,
  bytes: number,
  sha256: string,
) {
  await conn.execute(
    'UPDATE media_home_copies SET staged_bytes = ?, prefix_sha256 = ? WHERE media_id = ? AND complete = 0',
    [bytes, sha256, id],
  );
}

export async function finishMediaCopy(
  conn: Conn,
  row: MediaRow,
  sha256: string,
) {
  await insertCopiedMedia(conn, row);
  await conn.execute(
    'UPDATE media_home_copies SET complete = 1, staged_bytes = ?, prefix_sha256 = ? WHERE media_id = ?',
    [row.size_bytes, sha256, row.media_id],
  );
}

export async function insertCopiedMedia(conn: Conn, row: MediaRow) {
  await conn.execute(
    `INSERT INTO media(media_id, localpart, state, content_type, filename, size_bytes, created_ms, uploaded_ms)
     VALUES (?, ?, 'uploaded', ?, ?, ?, ?, ?)`,
    [
      row.media_id,
      row.localpart,
      row.content_type,
      row.filename,
      row.size_bytes,
      row.created_ms,
      row.uploaded_ms,
    ],
  );
}

export async function recordMediaExport(
  conn: Conn,
  mediaId: string,
  issuer: string,
  sha256: string,
): Promise<void> {
  await conn.execute(
    'INSERT INTO media_exports (media_id, issuer, sha256) VALUES (?, ?, ?)',
    [mediaId, issuer, sha256],
  );
}

// --- conn-level rows (bound on TenantTx) -----------------------------------

export async function insertMedia(
  conn: Conn,
  localpart: string,
  mediaId: string,
  state: 'pending' | 'uploaded',
  meta: MediaMeta,
): Promise<void> {
  const createdMs = Date.now();
  await conn.execute(
    `INSERT INTO media (media_id, localpart, state, content_type, filename, size_bytes, created_ms, uploaded_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      mediaId,
      localpart,
      state,
      meta.content_type ?? null,
      meta.filename ?? null,
      meta.size_bytes ?? null,
      createdMs,
      state === 'uploaded' ? createdMs : null,
    ],
  );
}

export async function mediaById(
  conn: Conn,
  mediaId: string,
): Promise<MediaRow | null> {
  const rows = await conn.query(
    'SELECT media_id, localpart, state, content_type, filename, size_bytes, created_ms, uploaded_ms FROM media WHERE media_id = ?',
    [mediaId],
  );
  if (rows.length === 0) return null;
  return rowOf(rows[0]);
}

function rowOf(row: Awaited<ReturnType<Conn['query']>>[number]): MediaRow {
  return {
    media_id: String(row.media_id),
    localpart: String(row.localpart),
    state: row.state === 'uploaded' ? 'uploaded' : 'pending',
    content_type: row.content_type == null ? null : String(row.content_type),
    filename: row.filename == null ? null : String(row.filename),
    size_bytes: row.size_bytes == null ? null : Number(row.size_bytes),
    created_ms: Number(row.created_ms),
    uploaded_ms: row.uploaded_ms == null ? null : Number(row.uploaded_ms),
  };
}

export async function markMediaUploaded(
  conn: Conn,
  mediaId: string,
  meta: MediaMeta,
): Promise<void> {
  await conn.execute(
    `UPDATE media SET state = 'uploaded', content_type = ?, filename = ?,
     size_bytes = ?, uploaded_ms = ? WHERE media_id = ?`,
    [
      meta.content_type ?? null,
      meta.filename ?? null,
      meta.size_bytes ?? null,
      Date.now(),
      mediaId,
    ],
  );
}

// --- tenant-level behaviour --------------------------------------------------

/** Insert a media row; 'pending' = id created, bytes not yet stored. */
export async function createMedia(
  tenant: Tenant,
  localpart: string,
  mediaId: string,
  state: 'pending' | 'uploaded',
  meta?: MediaMeta,
): Promise<void> {
  await tenant.tx((tx) =>
    tx.media.insert(localpart, mediaId, state, meta ?? {})
  );
}

/** The media row, or null when the id is unknown. */
export async function getMedia(
  tenant: Tenant,
  mediaId: string,
): Promise<MediaRow | null> {
  return await tenant.tx((tx) => tx.media.byId(mediaId));
}

/** Finish a pending upload: the bytes are on disk; record the metadata. */
export async function markUploaded(
  tenant: Tenant,
  mediaId: string,
  meta: MediaMeta,
): Promise<void> {
  await tenant.tx((tx) => tx.media.markUploaded(mediaId, meta));
}
