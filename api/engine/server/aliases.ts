// Alias storage lives in the server file; no endpoint talks SQL.
import type { Database as Db } from '#engine/store/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';

export async function lookupAlias(
  db: Db,
  alias: string,
): Promise<string | null> {
  const rows = await db.query('SELECT room_id FROM aliases WHERE alias = ?', [
    alias,
  ]);
  return rows.length === 0 ? null : String(rows[0].room_id);
}

export async function registerAlias(
  db: Db,
  alias: string,
  room: string,
  creator: string,
) {
  try {
    await db.execute(
      'INSERT INTO aliases(alias, room_id, creator) VALUES(?,?,?)',
      [alias, room, creator],
    );
  } catch (e) {
    if (await lookupAlias(db, alias) !== null) {
      throw new MatrixError(409, 'M_ROOM_IN_USE', 'alias taken: ' + alias);
    }
    throw e;
  }
}

export async function validateCanonicalAliasContent(
  db: Db,
  roomId: string,
  content: Record<string, unknown>,
) {
  const entries: unknown[] = [];
  if ('alias' in content) entries.push(content.alias);
  if ('alt_aliases' in content) {
    if (!Array.isArray(content.alt_aliases)) {
      throw new MatrixError(
        400,
        'M_INVALID_PARAM',
        'alt_aliases must be an array',
      );
    }
    entries.push(...content.alt_aliases);
  }
  for (const e of entries) {
    if (typeof e !== 'string' || !/^#[^:]+:[^:]+$/.test(e)) {
      throw new MatrixError(400, 'M_INVALID_PARAM', 'Room alias invalid');
    }
    if (await lookupAlias(db, e) !== roomId) {
      throw new MatrixError(
        400,
        'M_BAD_ALIAS',
        'Room alias does not point to this room: ' + e,
      );
    }
  }
}
