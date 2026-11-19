import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  activateTenantAuthority,
  captureSessionAuthority,
  installSessionAuthority,
} from '#engine/tenant/session-authority.ts';
import {
  consumeRefreshToken,
  issueRefreshToken,
  issueToken,
} from '#engine/tenant/auth.ts';
import { listPushers, setPusher } from '#engine/tenant/pushers.ts';
import { writeRegister } from '#engine/facade/registers.ts';

const input = {
  app_id: 'app',
  pushkey: 'key',
  kind: 'http',
  app_display_name: 'App',
  device_display_name: 'Device',
  lang: 'en',
  append: true,
  data: { url: 'https://push.test/_matrix/push/v1/notify' },
};

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'pusher-append-' });
  const open = (side: string) =>
    openStore({
      dir: dir + '/' + side,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { tenant: tenantSchema } });
  const home = await open('home'), edge = await open('edge');
  const ht = await openTenant(home, 'test', { create: true });
  const et = await openTenant(edge, 'test', { create: true });
  const hd = await home.tenant('test'), ed = await edge.tenant('test');
  for (
    const [node, tenant, db] of [['home', ht, hd], ['edge', et, ed]] as const
  ) {
    await tenant.tx(async (tx) => {
      await tx.users.insert('alice', 'Alice');
      await tx.users.insert('bob', 'Bob');
    });
    await db.tx((conn) =>
      activateTenantAuthority(conn, {
        node,
        incarnation: node + '-store',
        homeIncarnation: 'home-store',
        edgeNode: 'edge',
        edgeIncarnation: 'edge-store',
      })
    );
  }
  const alice = await issueToken(ht, 'alice', 'A');
  const bob = await issueToken(et, 'bob', 'B');
  const edgeAlice = await issueToken(et, 'alice', 'EA');
  const sync = async () => {
    for (const user of ['alice', 'bob']) {
      const h = await hd.tx((conn) => captureSessionAuthority(conn, user));
      const e = await ed.tx((conn) => captureSessionAuthority(conn, user));
      await hd.tx((conn) => installSessionAuthority(conn, user, e));
      await ed.tx((conn) => installSessionAuthority(conn, user, h));
    }
  };
  return {
    home,
    edge,
    ht,
    et,
    hd,
    ed,
    alice,
    bob,
    edgeAlice,
    sync,
    open,
    async close() {
      await home.close();
      await edge.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('pusher append: home removes an unseen different-account registration on original put, once and atomically', async () => {
  const f = await fixture();
  try {
    await setPusher(f.ht, 'alice', f.alice, input);
    await setPusher(f.et, 'bob', f.bob, { ...input, append: false });
    assertEquals(
      (await listPushers(f.ht, 'alice')).length,
      1,
      'partition delay is explicit',
    );
    const [put] = await f.et.tx((tx) => tx.pushers.operations('bob'));
    await f.sync();
    await assertRejects(() =>
      f.ht.tx(async (tx) => {
        await tx.pushers.import(put);
        throw new Error('rollback');
      })
    );
    assertEquals((await listPushers(f.ht, 'alice')).length, 1);
    await f.ht.tx((tx) => tx.pushers.import(put));
    assertEquals(
      await listPushers(f.ht, 'alice'),
      [],
      'home did not execute unseen cross-account removal',
    );
    const removed = await f.ht.tx((tx) => tx.pushers.operations('alice'));
    assertEquals(removed.filter((op) => op.payload === 'null').length, 1);
    assertEquals(removed.at(-1)!.source, 'home');
    await setPusher(f.ht, 'alice', f.alice, input);
    await f.ht.tx((tx) => tx.pushers.import(put));
    assertEquals(
      (await listPushers(f.ht, 'alice')).length,
      1,
      'replay removed a later registration',
    );
  } finally {
    await f.close();
  }
});

Deno.test('pusher append: refresh retains original false intent but is not another replacement', async () => {
  const f = await fixture();
  try {
    await setPusher(f.ht, 'alice', f.alice, input);
    await setPusher(f.et, 'bob', f.bob, { ...input, append: false });
    const refresh = await issueRefreshToken(f.et, 'bob', 'B', f.bob);
    await consumeRefreshToken(f.et, refresh);
    const operations = await f.et.tx((tx) => tx.pushers.operations('bob'));
    assertEquals(operations.length, 2);
    assertEquals(operations.map((op) => JSON.parse(op.payload).removeOthers), [
      true,
      true,
    ], 'source intent lost on refresh');
    await f.sync();
    await f.ht.tx((tx) => tx.pushers.import(operations[1]));
    assertEquals(
      (await listPushers(f.ht, 'alice')).length,
      1,
      'pending refresh is not the original request',
    );
    await f.ht.tx((tx) => tx.pushers.import(operations[0]));
    assertEquals(await listPushers(f.ht, 'alice'), []);
    await setPusher(f.ht, 'alice', f.alice, input);
    for (const op of operations) await f.ht.tx((tx) => tx.pushers.import(op));
    assertEquals((await listPushers(f.ht, 'alice')).length, 1);
  } finally {
    await f.close();
  }
});

Deno.test('pusher append: same-account exemption and append=true survive home reconciliation', async () => {
  const f = await fixture();
  try {
    await setPusher(f.ht, 'alice', f.alice, input);
    const [native] = await f.hd.query('SELECT incarnation FROM pushers');
    await setPusher(f.et, 'alice', f.edgeAlice, { ...input, append: false });
    await setPusher(f.et, 'bob', f.bob, input);
    await f.sync();
    for (const user of ['alice', 'bob']) {
      for (const op of await f.et.tx((tx) => tx.pushers.operations(user))) {
        await f.ht.tx((tx) => tx.pushers.import(op));
      }
    }
    assertEquals((await listPushers(f.ht, 'alice')).length, 1);
    assertEquals(
      (await f.ht.tx((tx) => tx.pushers.operations('alice'))).filter((op) =>
        op.payload === 'null'
      ),
      [],
    );
    assertEquals(
      (await f.hd.query('SELECT incarnation FROM pushers'))[0].incarnation,
      native.incarnation,
    );
  } finally {
    await f.close();
  }
});

Deno.test('pusher append: refresh cannot add or erase the original replacement intent', async () => {
  const f = await fixture();
  try {
    await setPusher(f.et, 'bob', f.bob, { ...input, append: false });
    const [put] = await f.et.tx((tx) => tx.pushers.operations('bob'));
    await f.sync();
    await f.ht.tx((tx) => tx.pushers.import(put));
    const body = JSON.parse(put.payload);
    delete body.removeOthers;
    const { operation } = await f.ed.tx((conn) =>
      writeRegister(
        conn,
        { source: put.source, incarnation: put.incarnation },
        put.semanticKey,
        'pusher',
        JSON.stringify(body),
      )
    );
    await assertRejects(
      () => f.ht.tx((tx) => tx.pushers.import(operation)),
      Error,
      'immutable pusher registration differs',
    );
    assertEquals(await f.ht.tx((tx) => tx.pushers.operations('bob')), [put]);
  } finally {
    await f.close();
  }
});

Deno.test('pusher append: concurrent false requests settle at home, exported removals fence late puts after cold reopen', async () => {
  const f = await fixture();
  try {
    await setPusher(f.ht, 'alice', f.alice, { ...input, append: false });
    await setPusher(f.et, 'bob', f.bob, { ...input, append: false });
    const originalAlice = await f.ht.tx((tx) => tx.pushers.operations('alice'));
    const bobOps = await f.et.tx((tx) => tx.pushers.operations('bob'));
    await f.sync();
    for (const op of bobOps) await f.ht.tx((tx) => tx.pushers.import(op));
    const removal = (await f.ht.tx((tx) => tx.pushers.operations('alice')))
      .find((op) => op.payload === 'null');
    assertEquals(
      !!removal,
      true,
      'home failed to serialize concurrent false replacement',
    );
    await f.et.tx((tx) => tx.pushers.import(removal!));
    await f.edge.close();
    const cold = await f.open('edge');
    try {
      const tenant = await openTenant(cold, 'test');
      for (const op of originalAlice) {
        await tenant.tx((tx) => tx.pushers.import(op));
      }
      for (const op of await f.ht.tx((tx) => tx.pushers.choices('alice'))) {
        await tenant.tx((tx) => tx.pushers.import(op));
      }
      assertEquals(await listPushers(tenant, 'alice'), []);
      assertEquals((await listPushers(tenant, 'bob')).length, 1);
      assertEquals(
        await (await cold.tenant('test')).query(
          "SELECT * FROM domain_operations WHERE kind='pusher' AND source='edge' AND payload_json='null'",
        ),
        [],
      );
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});
