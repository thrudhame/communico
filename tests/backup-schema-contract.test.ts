import { assertEquals, assertRejects } from '@std/assert';
import { auditTables } from '#engine/backup/contracts.ts';
import { roomSchema } from '#engine/room/schema.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { tenantSchema } from '#engine/tenant/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { historicalServerSchema } from '#tests/fixtures/server-schema-history.ts';
import { historicalTenantSchema } from '#tests/fixtures/tenant-schema-history.ts';

// Run this small schema test before broad backup/application suites. A migration
// adding a durable table must explicitly declare its backup disposition.
for (const migrated of [false, true]) {
  Deno.test(`backup schema contract: ${migrated ? 'supported migrations' : 'fresh schemas'} register every durable table`, async () => {
    const dir = await Deno.makeTempDir({ prefix: 'backup-schema-contract-' });
    const config = {
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    };
    let store: Awaited<ReturnType<typeof openStore>> | undefined;
    try {
      if (migrated) {
        store = await openStore(config, {
          schemas: {
            server: historicalServerSchema(3),
            tenant: historicalTenantSchema(4),
            room: roomSchema,
          },
        });
        await store.tenant('schema.test', { create: true });
        await store.room('!schema:test', { create: true });
        await store.close();
      }
      store = await openStore(config, {
        schemas: {
          server: serverSchema,
          tenant: tenantSchema,
          room: roomSchema,
        },
      });
      for (
        const [kind, db] of [
          ['server', await store.server()],
          ['tenants', await store.tenant('schema.test', { create: true })],
          ['rooms', await store.room('!schema:test', { create: true })],
        ] as const
      ) {
        if (kind === 'server') {
          // Index-only publication migration: no new durable table disposition.
          // Register its access paths here for both fresh and upgraded backups.
          const indexes = [
            'notification_horizons_room',
            'notification_own_events_event',
            'notification_receipt_refs_room',
            'push_evaluations_event',
            'relations_target',
          ];
          assertEquals(
            (await db.query(
              `SELECT name FROM sqlite_master WHERE type='index' AND name IN (${
                indexes.map(() => '?').join(',')
              }) ORDER BY name`,
              indexes,
            )).map((row) => row.name),
            indexes,
          );
        }
        await auditTables(db, kind);
        await db.exec('CREATE TABLE unregistered_durable_state(value TEXT)');
        await assertRejects(
          () => auditTables(db, kind),
          Error,
          'unregistered durable table',
        );
        await db.exec('DROP TABLE unregistered_durable_state');
        assertEquals(await auditTables(db, kind), undefined);
        const table = kind === 'server'
          ? 'facade_exports'
          : kind === 'tenants'
          ? 'account_auth_snapshots'
          : 'waits';
        await db.exec(`ALTER TABLE ${table} RENAME TO missing_durable_state`);
        await assertRejects(
          () => auditTables(db, kind),
          Error,
          'unregistered durable table',
        );
        await db.exec('DROP TABLE missing_durable_state');
        await assertRejects(
          () => auditTables(db, kind),
          Error,
          'missing durable table',
        );
      }
    } finally {
      await store?.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}
