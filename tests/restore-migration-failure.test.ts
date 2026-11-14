import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { openStore } from '#engine/store/index.ts';
import { withCandidateStore } from '#engine/store/candidate.ts';
import { withRestoreTarget } from '#engine/store/restore.ts';
import { copyPrivate } from '#engine/store/files.ts';
import type { SchemaProvider } from '#engine/store/create.ts';
import { describePayload } from '#engine/backup/manifest.ts';
import { Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';

// Faults occur after real schema/data writes, not before migration admission.
// The full restore lifecycle must retain both operator roots and the archive,
// even when earlier files already migrated in the unpublished candidate.
for (const failingKind of ['server', 'tenants', 'rooms'] as const) {
  Deno.test(`restore migration failure: ${failingKind} rollback never promotes either root and the immutable archive remains retryable`, async () => {
    const root = await Deno.makeTempDir({
      prefix: 'restore-migration-failure-',
    });
    const settings = {
      dir: join(root, 'live'),
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    };
    const original: SchemaProvider = {
      version: 1,
      apply: (db) => db.exec('CREATE TABLE retained(value TEXT NOT NULL)'),
    };
    const archive = join(root, 'archive');
    const target = { ...settings, dir: join(root, 'target') };
    const media = join(root, 'target-media');
    let store: Awaited<ReturnType<typeof openStore>> | undefined;
    try {
      store = await openStore(settings, {
        schemas: { server: original, tenant: original, room: original },
      });
      for (
        const db of [
          await store.server(),
          await store.tenant('migration.test', { create: true }),
          await store.room('!retained:migration.test', { create: true }),
        ]
      ) await db.execute('INSERT INTO retained VALUES(?)', ['exact old truth']);
      const cut = await store.snapshot(archive);
      await store.close();
      store = undefined;
      const before = await Promise.all(
        cut.files.map((file) => describePayload(archive, file.path)),
      );
      for (const path of [target.dir, media]) {
        await Deno.mkdir(path);
        await Deno.writeTextFile(join(path, 'operator-data'), path);
      }
      const upgraded: string[] = [];
      const provider = (kind: string, fault: boolean): SchemaProvider => ({
        ...original,
        version: 3,
        migrations: {
          1: async (conn) => {
            await conn.exec('ALTER TABLE retained ADD COLUMN migrated TEXT');
            await conn.execute("UPDATE retained SET migrated='first step'");
          },
          2: async (conn) => {
            await conn.exec('CREATE TABLE migration_effect(value TEXT)');
            await conn.execute('INSERT INTO migration_effect VALUES(?)', [
              kind,
            ]);
            if (fault && kind === failingKind) {
              throw new Error('injected second migration failure');
            }
            upgraded.push(kind);
          },
        },
      });
      const prepare = (fault: boolean) =>
        withRestoreTarget(target, media, { replace: true }, async (roots) => {
          for (const file of cut.files) {
            const path = join(roots.store, file.path);
            await Deno.mkdir(join(path, '..'), { recursive: true });
            await copyPrivate(join(archive, file.path), path);
          }
          const preparation = withCandidateStore(
            target,
            roots.store,
            cut.files,
            {
              server: provider('server', fault),
              tenant: provider('tenants', fault),
              room: provider('rooms', fault),
            },
            async (candidate) => {
              assertEquals(candidate.files.length, 3);
              for (const file of candidate.files) {
                assertEquals([file.schemaVersion, file.migratedTo], [1, 3]);
                await candidate.read(file, async (db) => {
                  assertEquals(await db.query('SELECT * FROM retained'), [{
                    value: 'exact old truth',
                    migrated: 'first step',
                  }]);
                  assertEquals(
                    await db.query('SELECT * FROM migration_effect'),
                    [
                      { value: file.kind },
                    ],
                  );
                });
              }
            },
          );
          try {
            await preparation;
          } catch (error) {
            // The failing file's entire migration chain, including its first
            // completed step and marker, rolls back before its handle closes.
            const file = cut.files.find((file) => file.kind === failingKind)!;
            const ffi = new Turso(settings.library);
            try {
              const db = await Db.open(
                ffi,
                join(roots.store, file.path),
                settings.checkpointlogbytes,
              );
              try {
                assertEquals(
                  await db.query("SELECT v FROM meta WHERE k='schema_version'"),
                  [{ v: '1' }],
                );
                assertEquals(await db.query('SELECT * FROM retained'), [{
                  value: 'exact old truth',
                }]);
                assertEquals(
                  await db.query(
                    "SELECT name FROM sqlite_schema WHERE name='migration_effect'",
                  ),
                  [],
                );
              } finally {
                await db.close();
              }
            } finally {
              ffi.close();
            }
            throw error;
          }
          await Deno.writeTextFile(
            join(roots.media, 'retained-media'),
            'bytes',
          );
          return await roots.promote();
        });
      await assertRejects(prepare.bind(null, true), Error, 'second migration');
      assert(!upgraded.includes(failingKind));
      for (const path of [target.dir, media]) {
        assertEquals(
          await Deno.readTextFile(join(path, 'operator-data')),
          path,
        );
        assertEquals(
          Array.from(Deno.readDirSync(path), (entry) => entry.name),
          [
            'operator-data',
          ],
        );
      }
      assertEquals(
        await Promise.all(
          cut.files.map((file) => describePayload(archive, file.path)),
        ),
        before,
      );
      // A complete second attempt uses the same immutable archive, without
      // clearing target data or repairing a partially migrated input.
      const replaced = await prepare(false);
      assertEquals(
        await Deno.readTextFile(join(media, 'retained-media')),
        'bytes',
      );
      for (
        const [path, kept] of [
          [target.dir, replaced.store],
          [media, replaced.media],
        ]
      ) {
        assert(kept);
        assertEquals(
          await Deno.readTextFile(join(kept, 'operator-data')),
          path,
        );
      }
      assertEquals(
        await Promise.all(
          cut.files.map((file) => describePayload(archive, file.path)),
        ),
        before,
      );
    } finally {
      await store?.close();
      await Deno.remove(root, { recursive: true });
    }
  });
}
