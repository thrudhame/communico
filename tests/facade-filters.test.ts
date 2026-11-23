import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { activateTenantAuthority } from '#engine/tenant/session-authority.ts';
import { loadFilter, storeFilter } from '#engine/tenant/filters.ts';
import { registerOperations } from '#engine/facade/registers.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { createHash } from 'node:crypto';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-filters-' });
  const stores: Awaited<ReturnType<typeof openStore>>[] = [];
  const tenants: Awaited<ReturnType<typeof openTenant>>[] = [];
  for (const node of ['home', 'edge']) {
    const store = await openStore({
      dir: dir + '/' + node,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { tenant: tenantSchema } });
    stores.push(store);
    const tenant = await openTenant(store, 'logical.test', { create: true });
    await registerUser(tenant, { localpart: 'alice', password: 'pw' });
    await (await store.tenant(tenant.serverName)).tx((conn) =>
      activateTenantAuthority(conn, {
        node,
        incarnation: node + '-store',
        homeIncarnation: 'home-store',
        edgeNode: 'edge',
        edgeIncarnation: 'edge-store',
      })
    );
    tenants.push(tenant);
  }
  return {
    home: tenants[0],
    edge: tenants[1],
    stores,
    async close() {
      for (const store of stores) await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('facade filters: disconnected issuers cannot allocate the same filter ID', async () => {
  const f = await fixture();
  try {
    const home = await storeFilter(f.home, 'alice', {
      room: { timeline: { limit: 1 } },
    });
    const edge = await storeFilter(f.edge, 'alice', {
      room: { timeline: { limit: 2 } },
    });
    assert(home !== edge, 'independent issuers aliased a filter ID');
    assertEquals(await loadFilter(f.home, 'alice', home), {
      room: { timeline: { limit: 1 } },
    });
  } finally {
    await f.close();
  }
});

Deno.test('facade filters: acknowledgment retains immutable semantic export in the owning transaction', async () => {
  const f = await fixture();
  try {
    const filter = {
      room: { timeline: { limit: 3 } },
      'org.example.fraction': 0.25,
    };
    const id = await storeFilter(f.home, 'alice', filter);
    const operations = await (await f.stores[0].tenant('logical.test')).tx((
      conn,
    ) => registerOperations(conn, JSON.stringify(['filter', 'alice', id])));
    assertEquals(
      operations.length,
      1,
      'filter ACK has no retained export fact',
    );
    assertEquals(JSON.parse(operations[0].payload), filter);
    assertEquals(operations[0].source, 'home');
  } finally {
    await f.close();
  }
});

Deno.test('facade filters: missing foreign filter is unavailable, not known absent', async () => {
  const f = await fixture();
  try {
    const id = await storeFilter(f.home, 'alice', {});
    const error = await assertRejects(
      () => loadFilter(f.edge, 'alice', id),
      MatrixError,
    );
    assertEquals(error.status, 503);
    assertEquals(error.errcode, 'M_UNAVAILABLE');
    assertEquals(await loadFilter(f.home, 'alice', 'missing'), null);
  } finally {
    await f.close();
  }
});

Deno.test('facade filters: terminal account cannot create new filter facts', async () => {
  const f = await fixture();
  try {
    await f.home.tx((tx) => tx.users.markDeactivated('alice'));
    await assertRejects(() => storeFilter(f.home, 'alice', {}), MatrixError);
    assertEquals(await f.home.tx((tx) => tx.filters.count('alice')), 0);
  } finally {
    await f.close();
  }
});

Deno.test('facade filters: immutable imports reject changed bodies, foreign issuers and successors atomically', async () => {
  const f = await fixture();
  try {
    const id = await storeFilter(f.home, 'alice', {
      room: { timeline: { limit: 1 } },
    });
    const [original] = await f.home.tx((tx) => tx.filters.operations('alice'));
    await f.edge.tx((tx) => tx.filters.import(original));
    await f.edge.tx((tx) => tx.filters.import(original));
    assertEquals(await loadFilter(f.edge, 'alice', id), {
      room: { timeline: { limit: 1 } },
    });
    const payload = '{"room":{"timeline":{"limit":2}}}';
    for (
      const invalid of [
        {
          ...original,
          payload,
          payloadHash: createHash('sha256').update(payload).digest('hex'),
        },
        { ...original, source: 'edge' },
        {
          ...original,
          sequence: 2,
          context: [{
            source: original.source,
            incarnation: original.incarnation,
            sequence: 1,
          }],
        },
      ]
    ) {
      await assertRejects(() => f.edge.tx((tx) => tx.filters.import(invalid)));
      assertEquals(await loadFilter(f.edge, 'alice', id), {
        room: { timeline: { limit: 1 } },
      });
      assertEquals(await f.edge.tx((tx) => tx.filters.operations('alice')), [
        original,
      ]);
    }
  } finally {
    await f.close();
  }
});

Deno.test('facade filters: deactivation retains source evidence without resurrecting private material', async () => {
  const f = await fixture();
  try {
    const id = await storeFilter(f.home, 'alice', {});
    const [operation] = await f.home.tx((tx) => tx.filters.operations('alice'));
    await f.edge.tx((tx) => tx.users.markDeactivated('alice'));
    await f.edge.tx((tx) => tx.filters.import(operation));
    await f.edge.tx((tx) => tx.filters.import(operation));
    assertEquals(await f.edge.tx((tx) => tx.filters.byId('alice', id)), null);
    assertEquals(await f.edge.tx((tx) => tx.filters.operations('alice')), [
      operation,
    ]);
  } finally {
    await f.close();
  }
});

Deno.test('facade filters: failed row publication rolls back its export fact', async () => {
  const f = await fixture();
  try {
    const db = await f.stores[0].tenant('logical.test');
    await db.exec(
      "CREATE TRIGGER refuse_filter BEFORE INSERT ON filters BEGIN SELECT RAISE(ABORT, 'fixture filter publication failure'); END",
    );
    await assertRejects(() => storeFilter(f.home, 'alice', {}));
    assertEquals(await f.home.tx((tx) => tx.filters.count('alice')), 0);
    assertEquals(await f.home.tx((tx) => tx.filters.operations('alice')), []);
  } finally {
    await f.close();
  }
});
