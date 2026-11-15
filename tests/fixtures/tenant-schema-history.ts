import { assert } from '@std/assert';
import { TENANT_SCHEMA_SQL, tenantSchema } from '#engine/tenant/schema.ts';
import type { SchemaProvider } from '#engine/store/create.ts';

// Reconstruct a fixed supported schema, not today's apply() with an old label.
export function historicalTenantSchema(version: number): SchemaProvider {
  assert(Number.isSafeInteger(version) && version >= 4);
  assert(version <= tenantSchema.version);
  return {
    version,
    apply: (db) =>
      db.tx(async (conn) => {
        await conn.exec(TENANT_SCHEMA_SQL);
        for (let from = 4; from < version; from++) {
          const migrate = tenantSchema.migrations?.[from];
          assert(migrate, `missing historical tenant migration ${from}`);
          await migrate(conn);
        }
      }, { mode: 'deferred' }),
  };
}
