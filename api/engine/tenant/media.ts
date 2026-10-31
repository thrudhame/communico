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
  const row = rows[0];
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
