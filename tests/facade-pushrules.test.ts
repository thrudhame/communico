import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { activateTenantAuthority } from '#engine/tenant/session-authority.ts';
import { registerJson, registerOperations } from '#engine/facade/registers.ts';
import { createHash } from 'node:crypto';
import {
  deleteRule,
  migrateRoomRules,
  putRule,
  rulesetFor,
  setRuleActions,
  setRuleEnabled,
} from '#engine/tenant/pushrules.ts';
import { registerUser } from '#engine/tenant/users.ts';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-pushrules-' });
  const options = (node: string) => ({
    dir: dir + '/' + node,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  });
  const stores: Awaited<ReturnType<typeof openStore>>[] = [];
  const tenants: Awaited<ReturnType<typeof openTenant>>[] = [];
  for (const node of ['home', 'edge']) {
    const store = await openStore(options(node), {
      schemas: { tenant: tenantSchema },
    });
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
    options,
    async close() {
      for (const store of stores) await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('facade push rules: ordinary validated mutation retains a complete ordered semantic revision', async () => {
  const f = await fixture();
  try {
    await putRule(f.home, 'alice', 'override', 'first', {
      actions: ['notify'],
      conditions: [],
    }, {});
    await putRule(f.home, 'alice', 'override', 'second', {
      actions: ['dont_notify'],
      conditions: [],
    }, { after: 'first' });
    const rows = await (await f.stores[0].tenant('logical.test')).tx((conn) =>
      registerOperations(conn, JSON.stringify(['push-rules', 'alice']))
    );
    assert(
      rows.length > 0,
      'ordinary push mutation lost its complete semantic intent',
    );
    assertEquals(
      JSON.parse(rows.at(-1)!.payload),
      await rulesetFor(f.home, 'alice'),
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade push rules: imports reject rule fields that cannot round-trip through the owning projection', async () => {
  const f = await fixture();
  try {
    await putRule(f.home, 'alice', 'override', 'custom', {
      actions: ['notify'],
      conditions: [],
    }, {});
    const operations = await f.home.tx((tx) =>
      tx.pushRules.operations('alice')
    );
    const original = operations.at(-1)!;
    const before = await rulesetFor(f.edge, 'alice');
    const cut = await f.edge.tx((tx) => tx.pushRules.streamSeq('alice'));
    for (const custom of [false, true]) {
      const rules = JSON.parse(original.payload);
      const rule = rules.override.find((value: { default: boolean }) =>
        value.default !== custom
      );
      rule['org.example.meta'] = 1;
      const payload = registerJson(JSON.stringify(rules));
      const invalid = {
        ...original,
        payload,
        payloadHash: createHash('sha256').update(payload).digest('hex'),
      };
      await assertRejects(
        () => f.edge.tx((tx) => tx.pushRules.import(invalid)),
        Error,
        'invalid push-rules',
      );
      assertEquals(await rulesetFor(f.edge, 'alice'), before);
      assertEquals(
        await f.edge.tx((tx) => tx.pushRules.operations('alice')),
        [],
      );
      assertEquals(
        await f.edge.tx((tx) => tx.pushRules.streamSeq('alice')),
        cut,
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('facade push rules: whole ordered winners converge for every delivery order and observed-loser successors survive cold reopen', async () => {
  const f = await fixture();
  try {
    await putRule(f.home, 'alice', 'override', 'home', {
      actions: ['notify'],
      conditions: [],
    }, {});
    const [h1, h2] = await f.home.tx((tx) => tx.pushRules.operations('alice'));
    await f.edge.tx((tx) => tx.pushRules.import(h1));
    await putRule(f.edge, 'alice', 'override', 'edge', {
      actions: ['dont_notify'],
      conditions: [],
    }, {});
    const e1 = (await f.edge.tx((tx) => tx.pushRules.operations('alice'))).find(
      (op) => op.source === 'edge',
    )!;
    const expected = await rulesetFor(f.home, 'alice');
    const permutations = [
      [h1, h2, e1],
      [h1, e1, h2],
      [h2, h1, e1],
      [h2, e1, h1],
      [e1, h1, h2],
      [e1, h2, h1],
    ];
    for (const [n, order] of permutations.entries()) {
      const store = await openStore(f.options('permutation' + n), {
        schemas: { tenant: tenantSchema },
      });
      try {
        const tenant = await openTenant(store, 'logical.test', {
          create: true,
        });
        await registerUser(tenant, { localpart: 'alice', password: 'pw' });
        await (await store.tenant('logical.test')).tx((conn) =>
          activateTenantAuthority(conn, {
            node: 'edge',
            incarnation: 'edge-store',
            homeIncarnation: 'home-store',
            edgeNode: 'edge',
            edgeIncarnation: 'edge-store',
          })
        );
        for (const operation of order) {
          await tenant.tx((tx) => tx.pushRules.import(operation));
          const cut = await tenant.tx((tx) => tx.pushRules.streamSeq('alice'));
          await tenant.tx((tx) => tx.pushRules.import(operation));
          assertEquals(
            await tenant.tx((tx) => tx.pushRules.streamSeq('alice')),
            cut,
          );
        }
        assertEquals(await rulesetFor(tenant, 'alice'), expected);
        assertEquals(
          (await tenant.tx((tx) => tx.pushRules.operations('alice'))).length,
          3,
        );
      } finally {
        await store.close();
      }
    }
    await f.home.tx((tx) => tx.pushRules.import(e1));
    await f.edge.tx((tx) => tx.pushRules.import(h2));
    const retained = await f.edge.tx((tx) => tx.pushRules.operations('alice'));
    assert(
      retained.some((op) =>
        JSON.parse(op.payload).override.some((rule: { rule_id: string }) =>
          rule.rule_id === 'edge'
        )
      ),
    );
    await setRuleEnabled(f.edge, 'alice', 'override', 'home', false);
    const e2 = (await f.edge.tx((tx) => tx.pushRules.operations('alice'))).find(
      (op) => op.source === 'edge' && op.sequence === 2,
    )!;
    await f.home.tx((tx) => tx.pushRules.import(e2));
    const winner = await rulesetFor(f.edge, 'alice');
    assertEquals(await rulesetFor(f.home, 'alice'), winner);
    assertEquals(
      winner.override.find((rule) => rule.rule_id === 'home')?.enabled,
      false,
    );
    await f.stores[0].close();
    const cold = await openStore(f.options('home'), {
      schemas: { tenant: tenantSchema },
    });
    try {
      const tenant = await openTenant(cold, 'logical.test');
      assertEquals(await rulesetFor(tenant, 'alice'), winner);
      assertEquals(
        (await tenant.tx((tx) => tx.pushRules.operations('alice'))).length,
        4,
      );
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('facade push rules: every mutation retains one complete revision including default overrides, order and room upgrades', async () => {
  const f = await fixture();
  try {
    const operations = () =>
      f.home.tx((tx) => tx.pushRules.operations('alice'));
    await putRule(f.home, 'alice', 'override', 'a', {
      actions: ['notify'],
      conditions: [],
    }, {});
    let count = (await operations()).length;
    for (
      const change of [
        () =>
          putRule(f.home, 'alice', 'override', 'b', {
            actions: ['dont_notify'],
            conditions: [],
          }, { before: 'a' }),
        () =>
          setRuleEnabled(f.home, 'alice', 'override', '.m.rule.master', true),
        () =>
          setRuleActions(f.home, 'alice', 'override', '.m.rule.master', [
            'dont_notify',
          ]),
        () => deleteRule(f.home, 'alice', 'override', 'a'),
        () =>
          putRule(f.home, 'alice', 'room', '!old:logical.test', {
            actions: ['notify'],
          }, {}),
        () =>
          migrateRoomRules(f.home, '!old:logical.test', '!new:logical.test'),
      ]
    ) {
      await change();
      const rows = await operations();
      assertEquals(rows.length, ++count);
      assertEquals(
        JSON.parse(rows.at(-1)!.payload),
        await rulesetFor(f.home, 'alice'),
      );
    }
    const rules = await rulesetFor(f.home, 'alice');
    assertEquals(rules.override[0].enabled, true);
    assertEquals(rules.override[0].actions, ['dont_notify']);
    assertEquals(
      rules.override.filter((rule) => !rule.default).map((rule) =>
        rule.rule_id
      ),
      ['b'],
    );
    assert(rules.room.some((rule) => rule.rule_id === '!new:logical.test'));
    await assertRejects(() =>
      putRule(f.home, 'alice', 'override', '.forbidden', {
        actions: ['notify'],
      }, {})
    );
    assertEquals((await operations()).length, count);
  } finally {
    await f.close();
  }
});

Deno.test('facade push rules: import validates source/catalog and cannot revive a deactivated account', async () => {
  const f = await fixture();
  try {
    await putRule(f.home, 'alice', 'override', 'a', {
      actions: ['notify'],
      conditions: [],
    }, {});
    const operations = await f.home.tx((tx) =>
      tx.pushRules.operations('alice')
    );
    const op = operations.at(-1)!;
    for (
      const invalid of [{ ...op, source: 'foreign' }, {
        ...op,
        semanticKey: JSON.stringify(['profile', 'alice']),
      }, {
        ...op,
        payload: JSON.stringify({ ...JSON.parse(op.payload), override: [] }),
      }]
    ) {
      await assertRejects(() =>
        f.edge.tx((tx) => tx.pushRules.import(invalid))
      );
    }
    assertEquals(await f.edge.tx((tx) => tx.pushRules.operations('alice')), []);
    for (const operation of operations) {
      await f.edge.tx((tx) => tx.pushRules.import(operation));
    }
    const db = await f.stores[1].tenant('logical.test');
    await db.execute("UPDATE users SET deactivated=1 WHERE localpart='alice'");
    await f.edge.tx((tx) => tx.pushRules.clear('alice'));
    const cleared = await rulesetFor(f.edge, 'alice');
    await f.edge.tx((tx) => tx.pushRules.import(op));
    assertEquals(await rulesetFor(f.edge, 'alice'), cleared);
    await assertRejects(() =>
      setRuleEnabled(f.edge, 'alice', 'override', '.m.rule.master', true)
    );
  } finally {
    await f.close();
  }
});
