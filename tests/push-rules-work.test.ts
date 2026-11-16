import { assertEquals, assertRejects } from '@std/assert';
import { openStore, type Store } from '#engine/store/index.ts';
import { Turso } from '#engine/store/ffi.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  PUSH_KINDS,
  putRule,
  rulesetAt,
  rulesetFor,
  setRuleActions,
  setRuleEnabled,
} from '#engine/tenant/pushrules.ts';

async function withTenant(
  fn: (
    store: Store,
    tenant: Awaited<ReturnType<typeof openTenant>>,
  ) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema } });
  try {
    await fn(store, await openTenant(store, 'rules.test', { create: true }));
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('push rules work: complete user rulesets use one snapshot read across every kind', async () => {
  await withTenant(async (store, tenant) => {
    for (const kind of PUSH_KINDS) {
      await putRule(tenant, 'alice', kind, kind + '-first', {
        actions: ['notify'],
        conditions: [],
        pattern: 'first',
      }, {});
      await putRule(tenant, 'alice', kind, kind + '-second', {
        actions: ['dont_notify'],
        conditions: [],
        pattern: 'second',
      }, { after: kind + '-first' });
      await putRule(tenant, 'bob', kind, 'other-user', {
        actions: ['notify'],
        conditions: [],
        pattern: '*',
      }, {});
    }
    await setRuleEnabled(tenant, 'alice', 'override', '.m.rule.master', true);
    await setRuleActions(tenant, 'alice', 'underride', '.m.rule.message', [
      'dont_notify',
    ]);
    const db = await store.tenant('rules.test');
    await db.execute(
      "INSERT INTO push_rules(localpart,scope,kind,rule_id,priority,actions,conditions,pattern,enabled,is_default,seq) VALUES('alice','private','override','other-scope',-999,'[]','[]',NULL,1,0,NULL)",
    );
    const original = Turso.prototype.query;
    let reads = 0;
    Turso.prototype.query = function (...args) {
      if (/\bFROM push_rules\b/.test(args[1])) reads++;
      return original.apply(this, args);
    };
    let rules: Awaited<ReturnType<typeof rulesetFor>>;
    try {
      rules = await rulesetFor(tenant, 'alice');
    } finally {
      Turso.prototype.query = original;
    }
    for (const kind of PUSH_KINDS) {
      const custom = rules[kind].filter((r) => !r.default);
      assertEquals(custom.map((r) => r.rule_id), [
        kind + '-first',
        kind + '-second',
      ]);
      assertEquals(custom.map((r) => r.actions), [['notify'], ['dont_notify']]);
    }
    assertEquals(rules.override[0].rule_id, '.m.rule.master');
    assertEquals(rules.override[0].enabled, true);
    assertEquals(
      rules.underride.find((r) => r.rule_id === '.m.rule.message')?.actions,
      ['dont_notify'],
    );
    assertEquals(reads, 1, 'one complete snapshot, not a read for every kind');
  });
});

Deno.test('push rules work: transaction edits and rollback never leak through another ruleset capture', async () => {
  await withTenant(async (_store, tenant) => {
    await putRule(tenant, 'alice', 'content', 'match', {
      actions: ['notify'],
      pattern: 'hello',
    }, {});
    const before = await rulesetFor(tenant, 'alice');
    await assertRejects(
      () =>
        tenant.tx(async (tx) => {
          await tx.pushRules.setActions(
            'alice',
            'content',
            'match',
            '["dont_notify"]',
          );
          const during = await rulesetAt(tx, 'alice', 'rules.test');
          assertEquals(
            during.content.find((r) => r.rule_id === 'match')?.actions,
            ['dont_notify'],
          );
          throw new Error('rollback snapshot');
        }),
      Error,
      'rollback snapshot',
    );
    assertEquals(await rulesetFor(tenant, 'alice'), before);
    before.content[0].actions.push('mutated caller value');
    const fresh = await rulesetFor(tenant, 'alice');
    assertEquals(fresh.content.find((r) => r.rule_id === 'match')?.actions, [
      'notify',
    ]);
    await setRuleActions(tenant, 'alice', 'content', 'match', ['dont_notify']);
    assertEquals(
      (await rulesetFor(tenant, 'alice')).content.find((r) =>
        r.rule_id === 'match'
      )?.actions,
      ['dont_notify'],
    );
  });
});
