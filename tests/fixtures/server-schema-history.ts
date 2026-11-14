import { assert } from '@std/assert';
import { SERVER_SCHEMA_SQL, serverSchema } from '#engine/server/schema.ts';
import type { SchemaProvider } from '#engine/store/create.ts';

// Historical fixtures must not call the moving current apply() and then merely
// relabel its version. Reconstruct their fixed schema from the supported chain.
export function historicalServerSchema(version: number): SchemaProvider {
  assert(Number.isSafeInteger(version) && version >= 3);
  assert(version <= serverSchema.version);
  return {
    version,
    apply: (db) =>
      db.tx(async (conn) => {
        await conn.exec(SERVER_SCHEMA_SQL);
        for (let from = 3; from < version; from++) {
          const migrate = serverSchema.migrations?.[from];
          assert(migrate, `missing historical server migration ${from}`);
          await migrate(conn);
        }
      }, { mode: 'deferred' }),
  };
}
