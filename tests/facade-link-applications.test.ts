import { assertEquals, assertRejects } from '@std/assert';
import { type LinkRecord, recordHash } from '#engine/facade/protocol.ts';
import { openStore } from '#engine/store/index.ts';
import { tenantSchema } from '#engine/tenant/schema.ts';
import {
  applyLinkApplication,
  linkApplication,
  linkApplicationProjection,
  retainLinkApplication,
} from '#engine/tenant/link-applications.ts';
import {
  pendingTenantProjection,
  recordTenantProjection,
} from '#engine/tenant/hooks.ts';
import { historicalTenantSchema } from '#tests/fixtures/tenant-schema-history.ts';

Deno.test('tenant link applications: prior schema upgrade, exact immutable receipt, rollback and cold recovery', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'link-applications-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: { tenant: historicalTenantSchema(32) },
  });
  const body = {
    source: 'home',
    incarnation: 'enrollment',
    stream: 'devices:@alice:logical.test',
    sequence: 1,
    type: 'device-operation',
    version: 1,
    operationId: 'device:one',
    previous: '',
    payload: { public: 'fact' },
  };
  const record: LinkRecord = { ...body, hash: recordHash(body) };
  const result = { operationId: 'one' };
  try {
    await store.tenant('logical.test', { create: true });
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    let db = await store.tenant('logical.test');
    const fresh = await store.tenant('fresh.test', { create: true });
    const sql =
      "SELECT sql FROM sqlite_master WHERE name='facade_link_applications'";
    assertEquals(await db.query(sql), await fresh.query(sql));
    await assertRejects(
      () =>
        db.tx(async (conn) => {
          await retainLinkApplication(conn, 'home', record, result);
          throw new Error('owner rollback');
        }),
      Error,
      'owner rollback',
    );
    assertEquals(
      await db.tx((conn) => linkApplication(conn, 'home', record)),
      null,
    );
    await db.tx((conn) => retainLinkApplication(conn, 'home', record, result));
    await db.tx((conn) => retainLinkApplication(conn, 'home', record, result));
    for (
      const other of [
        { ...record, incarnation: 'other' },
        { ...record, source: 'edge' },
        { ...record, stream: 'other' },
        { ...record, sequence: 2 },
      ]
    ) {
      assertEquals(
        await db.tx((conn) => linkApplication(conn, 'home', other)),
        null,
      );
    }
    assertEquals(
      await db.tx((conn) => linkApplication(conn, 'other', record)),
      null,
    );
    await assertRejects(
      () =>
        db.tx((conn) =>
          linkApplication(conn, 'home', { ...record, hash: 'changed' })
        ),
      Error,
      'changed tenant application record',
    );
    await assertRejects(
      () =>
        db.tx((conn) =>
          retainLinkApplication(conn, 'home', record, {
            operationId: 'changed',
          })
        ),
      Error,
      'changed tenant application result',
    );
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    db = await store.tenant('logical.test');
    assertEquals(await db.tx((conn) => linkApplication(conn, 'home', record)), {
      result,
    });
    assertEquals(
      (await db.query('SELECT * FROM facade_link_applications')).length,
      1,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('tenant projection obligations: exact zero and semantic cuts survive cold replay, legacy retains older pending recovery', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'link-projection-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: { tenant: historicalTenantSchema(40) },
  });
  const identity = {
    source: 'home',
    incarnation: 'enrollment',
    stream: 'auth:@alice:logical.test',
    sequence: 1,
    hash: 'exact',
  };
  try {
    let db = await store.tenant('logical.test', { create: true });
    const old = await db.tx(recordTenantProjection);
    await db.execute(
      'INSERT INTO facade_link_applications VALUES(?,?,?,?,?,?,?)',
      [
        'home',
        identity.source,
        identity.incarnation,
        identity.stream,
        identity.sequence,
        identity.hash,
        '{"legacy":true}',
      ],
    );
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    db = await store.tenant('logical.test');
    const fresh = { ...identity, sequence: 2, hash: 'fresh' };
    const semantic = { ...identity, sequence: 3, hash: 'semantic' };
    assertEquals(
      await db.tx((conn) =>
        applyLinkApplication(
          conn,
          'home',
          fresh,
          () => Promise.resolve({ result: { fresh: true } }),
        )
      ),
      { result: { fresh: true }, projectionRevision: 0 },
    );
    const changed = await db.tx((conn) =>
      applyLinkApplication(conn, 'home', semantic, async () => {
        await recordTenantProjection(conn);
        return { result: { semantic: true } };
      })
    );
    assertEquals(changed.projectionRevision > old, true);
    const later = await db.tx(recordTenantProjection);
    const local = {
      ...identity,
      stream: 'to-device-capture:legacy',
      sequence: 0,
      hash: 'capture',
    };
    assertEquals(
      (await db.tx((conn) =>
        applyLinkApplication(
          conn,
          'local',
          local,
          () => Promise.resolve({ result: {} }),
          true,
        )
      )).projectionRevision,
      old,
      'legacy capture retains the upgrade cut, not later work',
    );
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    db = await store.tenant('logical.test');
    for (
      const [record, expected] of [[fresh, 0], [
        semantic,
        changed.projectionRevision,
      ]] as const
    ) {
      const recovered = await db.tx((conn) =>
        applyLinkApplication(conn, 'home', record, () => {
          throw new Error('must not rerun owner');
        })
      );
      assertEquals(recovered.projectionRevision, expected);
    }
    assertEquals(
      await db.tx(async (conn) =>
        linkApplicationProjection(
          conn,
          (await linkApplication(conn, 'home', identity))!,
        )
      ),
      later,
    );
    assertEquals(await pendingTenantProjection(db), later);
    await assertRejects(
      () =>
        db.tx((conn) =>
          retainLinkApplication(conn, 'home', fresh, { fresh: true }, later)
        ),
      Error,
      'changed tenant application result',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
