import { assert } from '@std/assert';
import { ROOM_SCHEMA_SQL, roomSchema } from '#engine/room/schema.ts';
import type { SchemaProvider } from '#engine/store/create.ts';
import type { Database } from '#engine/store/db.ts';
import { openStore } from '#engine/store/index.ts';

// As for server/tenant history, construct the actual supported migration cut.
// Today's schema relabeled as an old version silently carries future features.
export function historicalRoomSchema(version: number): SchemaProvider {
  assert(Number.isSafeInteger(version) && version >= 1);
  assert(version <= roomSchema.version);
  return {
    version,
    apply: (db) =>
      db.tx(async (conn) => {
        await conn.exec(ROOM_SCHEMA_SQL);
        for (let from = 1; from < version; from++) {
          const migrate = roomSchema.migrations?.[from];
          assert(migrate, `missing historical room migration ${from}`);
          await migrate(conn);
        }
      }, { mode: 'deferred' }),
  };
}

const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const objects =
  "SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '__turso%'";

// Some legacy completion tests first need current builders to seed an event
// graph. Remove only later schema features by comparing with an actual old
// file, rather than maintaining a per-test list of future tables and columns.
export async function historicalRoomFixture(db: Database, version: number) {
  const dir = await Deno.makeTempDir({ prefix: 'room-history-schema-' });
  const reference = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: historicalRoomSchema(version) } });
  try {
    const old = await reference.room('!schema:history.test', { create: true });
    const expected = await old.query(objects);
    const names = new Set(expected.map((row) => String(row.name)));
    const tables = expected.filter((row) => row.type === 'table').map((row) =>
      String(row.name)
    );
    const columns = new Map<string, Set<string>>();
    for (const name of tables) {
      columns.set(
        name,
        new Set(
          (await old.query('PRAGMA table_info(' + identifier(name) + ')')).map((
            row,
          ) => String(row.name)),
        ),
      );
    }
    await db.tx(async (conn) => {
      const actual = await conn.query(objects);
      for (const row of actual) {
        if (
          row.type === 'index' && row.sql !== null &&
          !names.has(String(row.name))
        ) {
          await conn.exec('DROP INDEX ' + identifier(String(row.name)));
        }
      }
      for (const row of actual) {
        if (row.type === 'table' && !names.has(String(row.name))) {
          await conn.exec('DROP TABLE ' + identifier(String(row.name)));
        }
      }
      for (const name of tables) {
        const current = await conn.query(
          'PRAGMA table_info(' + identifier(name) + ')',
        );
        for (const column of current) {
          if (!columns.get(name)!.has(String(column.name))) {
            await conn.exec(
              'ALTER TABLE ' + identifier(name) + ' DROP COLUMN ' +
                identifier(String(column.name)),
            );
          }
        }
      }
      await conn.execute("UPDATE meta SET v=? WHERE k='schema_version'", [
        String(version),
      ]);
    }, { mode: 'deferred' });
  } finally {
    await reference.close();
    await Deno.remove(dir, { recursive: true });
  }
}
