// Home-owned directory intent, not derived room metadata or a server-file copy.
// Callers pin this semantic value and install it in their own server transaction.
import { splitId } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Conn } from '#engine/store/db.ts';

export type DirectoryFacts = {
  aliases: { alias: string; roomId: string; creator: string | null }[];
  publication: {
    roomId: string;
    visibility: 'public' | 'private';
    purgeable: number | null;
  }[];
  forgotten: { user: string; roomId: string }[];
};

function bad(): never {
  throw new MatrixError(400, 'M_BAD_JSON', 'invalid public directory facts');
}
function row(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad();
  return raw as Record<string, unknown>;
}
function room(raw: unknown): string {
  if (
    typeof raw !== 'string' || !raw.startsWith('!') || !splitId(raw).server ||
    !splitId(raw).localpart
  ) bad();
  return raw;
}
function local(raw: unknown, sigil: string, self: string): string {
  if (
    typeof raw !== 'string' || !raw.startsWith(sigil) ||
    !splitId(raw).localpart || splitId(raw).server !== self
  ) bad();
  return raw;
}
function unique<T>(items: T[], key: (item: T) => string): T[] {
  if (new Set(items.map(key)).size !== items.length) bad();
  return items;
}
export function directoryFactsOf(raw: unknown, self: string): DirectoryFacts {
  const value = row(raw);
  if (
    !Array.isArray(value.aliases) || !Array.isArray(value.publication) ||
    !Array.isArray(value.forgotten)
  ) bad();
  return {
    aliases: unique(
      value.aliases.map((raw) => {
        const entry = row(raw);
        if (entry.creator !== null && typeof entry.creator !== 'string') bad();
        return {
          alias: local(entry.alias, '#', self),
          roomId: room(entry.roomId),
          creator: entry.creator,
        };
      }),
      (entry) => entry.alias,
    ),
    publication: unique(
      value.publication.map((raw) => {
        const entry = row(raw);
        if (
          entry.visibility !== 'public' && entry.visibility !== 'private'
        ) bad();
        if (
          entry.purgeable !== null &&
          (typeof entry.purgeable !== 'number' ||
            !Number.isSafeInteger(entry.purgeable) || entry.purgeable < 0)
        ) bad();
        return {
          roomId: room(entry.roomId),
          visibility: entry.visibility,
          purgeable: entry.purgeable,
        };
      }),
      (entry) => entry.roomId,
    ),
    forgotten: unique(
      value.forgotten.map((raw) => {
        const entry = row(raw);
        return {
          user: local(entry.user, '@', self),
          roomId: room(entry.roomId),
        };
      }),
      (entry) => JSON.stringify([entry.user, entry.roomId]),
    ),
  };
}

export async function exportDirectoryFacts(
  conn: Conn,
  self: string,
): Promise<DirectoryFacts> {
  const aliases = await conn.query(
    'SELECT alias,room_id,creator FROM aliases ORDER BY alias',
  );
  const publication = await conn.query(
    "SELECT r.room_id,COALESCE(v.visibility,'private') AS visibility,d.purgeable_ms FROM (SELECT room_id FROM visibility UNION SELECT room_id FROM directory) r LEFT JOIN visibility v ON v.room_id=r.room_id LEFT JOIN directory d ON d.room_id=r.room_id ORDER BY r.room_id",
  );
  const forgotten = await conn.query(
    'SELECT user,room FROM forgotten ORDER BY user,room',
  );
  return directoryFactsOf({
    aliases: aliases.map((entry) => ({
      alias: String(entry.alias),
      roomId: String(entry.room_id),
      creator: entry.creator === null ? null : String(entry.creator),
    })),
    publication: publication.map((entry) => ({
      roomId: String(entry.room_id),
      visibility: String(entry.visibility),
      purgeable: entry.purgeable_ms === null
        ? null
        : Number(entry.purgeable_ms),
    })),
    forgotten: forgotten.filter((entry) =>
      splitId(String(entry.user)).server === self
    ).map((entry) => ({
      user: String(entry.user),
      roomId: String(entry.room),
    })),
  }, self);
}

export async function installDirectoryFacts(
  conn: Conn,
  raw: unknown,
  self: string,
): Promise<void> {
  const facts = directoryFactsOf(raw, self);
  await conn.execute('DELETE FROM aliases');
  for (const entry of facts.aliases) {
    await conn.execute(
      'INSERT INTO aliases(alias,room_id,creator) VALUES(?,?,?)',
      [entry.alias, entry.roomId, entry.creator],
    );
  }
  await conn.execute('DELETE FROM visibility');
  await conn.execute('DELETE FROM directory');
  for (const entry of facts.publication) {
    await conn.execute(
      'INSERT INTO visibility(room_id,visibility) VALUES(?,?)',
      [entry.roomId, entry.visibility],
    );
    await conn.execute(
      'INSERT INTO directory(room_id,purgeable_ms) VALUES(?,?)',
      [entry.roomId, entry.purgeable],
    );
  }
  await conn.execute('DELETE FROM forgotten');
  for (const entry of facts.forgotten) {
    await conn.execute('INSERT INTO forgotten(user,room) VALUES(?,?)', [
      entry.user,
      entry.roomId,
    ]);
  }
}
