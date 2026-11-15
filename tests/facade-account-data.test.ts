import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { activateTenantAuthority } from '#engine/tenant/session-authority.ts';
import {
  getAccountData,
  putAccountData,
  updateRoomTag,
} from '#engine/tenant/accountdata.ts';
import { registerUser } from '#engine/tenant/users.ts';

async function fixture(seed = false) {
  const dir = await Deno.makeTempDir({ prefix: 'facade-account-data-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema } });
  const tenants = [];
  for (const node of ['home', 'edge']) {
    const tenant = await openTenant(store, node + '.test', { create: true });
    await registerUser(tenant, { localpart: 'alice', password: 'pw' });
    if (seed && node === 'home') {
      await putAccountData(tenant, 'alice', '!room:logical.test', 'm.tag', {
        tags: { original: { order: 0.125 } },
      });
    }
    await (await store.tenant(tenant.serverName)).tx((c) =>
      activateTenantAuthority(c, {
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
    store,
    home: tenants[0],
    edge: tenants[1],
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('facade account data: ordinary writes retain opaque operations with local read cuts and no import echo', async () => {
  const f = await fixture();
  try {
    await putAccountData(f.home, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'home-secret',
    });
    await putAccountData(f.edge, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'edge-secret',
    });
    const a = await f.home.tx((tx) => tx.accountData.operations('alice'));
    const b = await f.edge.tx((tx) => tx.accountData.operations('alice'));
    assertEquals(a.length, 1);
    assertEquals(b.length, 1);
    await f.home.tx((tx) => tx.accountData.import(b[0]));
    await f.edge.tx((tx) => tx.accountData.import(a[0]));
    for (const tenant of [f.home, f.edge]) {
      assertEquals(
        await getAccountData(tenant, 'alice', '', 'm.secret_storage.key'),
        { ciphertext: 'home-secret' },
      );
      const before = await tenant.tx((tx) =>
        tx.accountData.snapshot('alice', '', 'm.secret_storage.key')
      );
      await tenant.tx((tx) => tx.accountData.import(a[0]));
      await tenant.tx((tx) => tx.accountData.import(b[0]));
      assertEquals(
        await tenant.tx((tx) =>
          tx.accountData.snapshot('alice', '', 'm.secret_storage.key')
        ),
        before,
      );
      assertEquals(
        (await tenant.tx((tx) => tx.accountData.operations('alice'))).length,
        2,
      );
    }
    // A successor observes the losing edge value too, not only the prior winner.
    await putAccountData(f.edge, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'replacement',
    });
    const successor = (await f.edge.tx((tx) =>
      tx.accountData.operations('alice')
    )).find((op) => op.source === 'edge' && op.sequence === 2)!;
    await f.home.tx((tx) =>
      tx.accountData.import(successor)
    );
    assertEquals(
      await getAccountData(f.home, 'alice', '', 'm.secret_storage.key'),
      { ciphertext: 'replacement' },
    );
    const db = await f.store.tenant(f.home.serverName);
    assertEquals(
      (await db.query('SELECT payload_json FROM domain_operations')).some((
        row,
      ) => String(row.payload_json).includes('edge-secret')),
      true,
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade account data: pre-F2 home values are retained before mutation; imported scope and lifecycle cannot be bypassed', async () => {
  const f = await fixture(true);
  try {
    const room = '!room:logical.test';
    await updateRoomTag(f.home, 'alice', room, 'new', { order: 0.5 });
    assertEquals(await getAccountData(f.home, 'alice', room, 'm.tag'), {
      tags: { original: { order: 0.125 }, new: { order: 0.5 } },
    });
    const operations = await f.home.tx((tx) =>
      tx.accountData.operations('alice')
    );
    assertEquals(operations.length, 2);
    // Reverse delivery cannot publish a tag change until its baseline arrives.
    await f.edge.tx((tx) => tx.accountData.import(operations[1]));
    assertEquals(await getAccountData(f.edge, 'alice', room, 'm.tag'), null);
    await f.edge.tx((tx) => tx.accountData.import(operations[0]));
    assertEquals(
      await getAccountData(f.edge, 'alice', room, 'm.tag'),
      await getAccountData(f.home, 'alice', room, 'm.tag'),
    );
    for (
      const changed of [{ ...operations[0], source: 'foreign' }, {
        ...operations[0],
        context: [{ source: 'foreign', incarnation: 'foreign', sequence: 1 }],
      }, {
        ...operations[0],
        semanticKey: JSON.stringify(['profile', 'alice']),
      }]
    ) {
      await assertRejects(() =>
        f.edge.tx((tx) => tx.accountData.import(changed))
      );
    }
    const db = await f.store.tenant(f.edge.serverName);
    await db.execute("UPDATE users SET deactivated=1 WHERE localpart='alice'");
    await db.execute("DELETE FROM account_data WHERE localpart='alice'");
    await f.edge.tx((tx) => tx.accountData.import(operations[0]));
    assertEquals(await getAccountData(f.edge, 'alice', room, 'm.tag'), null);
    await assertRejects(() =>
      putAccountData(f.edge, 'alice', room, 'm.tag', { tags: {} })
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade account data: an incoming operation cannot erase an uncaptured home baseline', async () => {
  const f = await fixture(true);
  try {
    const room = '!room:logical.test';
    await updateRoomTag(f.edge, 'alice', room, 'remote', { order: 0.5 });
    const operation = (await f.edge.tx((tx) =>
      tx.accountData.operations('alice')
    ))[0];
    await f.home.tx((tx) => tx.accountData.import(operation));
    const value = await getAccountData(f.home, 'alice', room, 'm.tag') as {
      tags: Record<string, unknown>;
    };
    assertEquals(value.tags.original, { order: 0.125 });
    assertEquals(
      (await f.home.tx((tx) => tx.accountData.operations('alice'))).length,
      2,
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade tags: per-tag edits commute, whole replacement resets observed tags, delayed old tags cannot resurrect', async () => {
  const f = await fixture();
  try {
    const room = '!room:logical.test';
    await updateRoomTag(f.home, 'alice', room, 'a', { order: 0.25 });
    await updateRoomTag(f.edge, 'alice', room, 'b', { order: 0.75 });
    const a = (await f.home.tx((tx) => tx.accountData.operations('alice')))[0];
    const b = (await f.edge.tx((tx) => tx.accountData.operations('alice')))[0];
    await f.home.tx((tx) => tx.accountData.import(b));
    await f.edge.tx((tx) => tx.accountData.import(a));
    for (const tenant of [f.home, f.edge]) {
      assertEquals(await getAccountData(tenant, 'alice', room, 'm.tag'), {
        tags: { a: { order: 0.25 }, b: { order: 0.75 } },
      });
    }
    await putAccountData(f.edge, 'alice', room, 'm.tag', {
      tags: { reset: { order: 0.5 } },
    });
    const reset = (await f.edge.tx((tx) => tx.accountData.operations('alice')))
      .find((op) => op.source === 'edge' && op.sequence === 2)!;
    await f.home.tx((tx) => tx.accountData.import(reset));
    await f.home.tx((tx) => tx.accountData.import(a));
    await f.home.tx((tx) => tx.accountData.import(b));
    assertEquals(await getAccountData(f.home, 'alice', room, 'm.tag'), {
      tags: { reset: { order: 0.5 } },
    });
    await updateRoomTag(f.home, 'alice', room, 'reset');
    const deletion = (await f.home.tx((tx) =>
      tx.accountData.operations('alice')
    )).find((op) => op.source === 'home' && op.sequence === 2)!;
    await f.edge.tx((tx) =>
      tx.accountData.import(deletion)
    );
    assertEquals(await getAccountData(f.edge, 'alice', room, 'm.tag'), {
      tags: {},
    });
    const permutations = <T>(values: T[]): T[][] =>
      values.length === 0
        ? [[]]
        : values.flatMap((value, i) =>
          permutations(values.filter((_, j) => i !== j)).map((
            rest,
          ) => [value, ...rest])
        );
    for (const [n, order] of permutations([a, b, reset, deletion]).entries()) {
      const tenant = await openTenant(f.store, 'permutation' + n + '.test', {
        create: true,
      });
      await registerUser(tenant, { localpart: 'alice', password: 'pw' });
      await (await f.store.tenant(tenant.serverName)).tx((c) =>
        activateTenantAuthority(c, {
          node: 'edge',
          incarnation: 'edge-store',
          homeIncarnation: 'home-store',
          edgeNode: 'edge',
          edgeIncarnation: 'edge-store',
        })
      );
      for (const operation of order) {
        await tenant.tx((tx) => tx.accountData.import(operation));
        const before = await tenant.tx((tx) =>
          tx.accountData.snapshot('alice', room, 'm.tag')
        );
        await tenant.tx((tx) => tx.accountData.import(operation));
        assertEquals(
          await tenant.tx((tx) =>
            tx.accountData.snapshot('alice', room, 'm.tag')
          ),
          before,
        );
      }
      assertEquals(await getAccountData(tenant, 'alice', room, 'm.tag'), {
        tags: {},
      });
    }
  } finally {
    await f.close();
  }
});
