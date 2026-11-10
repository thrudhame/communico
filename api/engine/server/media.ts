// Server-owned remote/derived byte metadata, never tenant upload ownership.
import type { Database as Db } from '#engine/store/db.ts';

export type CachedMedia = {
  cache_key: string;
  origin: string;
  media_id: string;
  variant: string;
  scope: 'remote' | 'thumbnail';
  blob: string;
  size: number;
  content_type: string;
  filename: string | null;
  created_ms: number;
  accessed_ms: number;
};
function rowOf(row: Record<string, unknown>): CachedMedia {
  return {
    cache_key: String(row.cache_key),
    origin: String(row.origin),
    media_id: String(row.media_id),
    variant: String(row.variant),
    scope: row.scope === 'remote' ? 'remote' : 'thumbnail',
    blob: String(row.blob),
    size: Number(row.size),
    content_type: String(row.content_type),
    filename: row.filename === null ? null : String(row.filename),
    created_ms: Number(row.created_ms),
    accessed_ms: Number(row.accessed_ms),
  };
}
export async function cachedMedia(
  db: Db,
  key: string,
): Promise<CachedMedia | null> {
  const rows = await db.query('SELECT * FROM media_cache WHERE cache_key=?', [
    key,
  ]);
  return rows.length ? rowOf(rows[0]) : null;
}
export async function listCachedMedia(db: Db): Promise<CachedMedia[]> {
  return (await db.query(
    'SELECT * FROM media_cache ORDER BY accessed_ms,cache_key',
  )).map(rowOf);
}
export async function publishCachedMedia(
  db: Db,
  row: CachedMedia,
): Promise<void> {
  await db.execute(
    'INSERT INTO media_cache(cache_key,origin,media_id,variant,scope,blob,size,content_type,filename,created_ms,accessed_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    [
      row.cache_key,
      row.origin,
      row.media_id,
      row.variant,
      row.scope,
      row.blob,
      row.size,
      row.content_type,
      row.filename,
      row.created_ms,
      row.accessed_ms,
    ],
  );
}
export async function touchCachedMedia(
  db: Db,
  key: string,
  now: number,
): Promise<void> {
  await db.execute('UPDATE media_cache SET accessed_ms=? WHERE cache_key=?', [
    now,
    key,
  ]);
}
export async function deleteCachedMedia(db: Db, key: string): Promise<void> {
  await db.execute('DELETE FROM media_cache WHERE cache_key=?', [key]);
}
