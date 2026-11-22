import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from '@std/assert';
import { openStore, type Store } from '#engine/store/index.ts';
import { Turso } from '#engine/store/ffi.ts';
import { openTenant, type Tenant, tenantSchema } from '#engine/tenant/index.ts';
import { localpartOf } from '#engine/tenant/auth.ts';
import {
  PUSH_KINDS,
  putRule,
  rulesetAt,
  setRuleActions,
  setRuleEnabled,
} from '#engine/tenant/pushrules.ts';
import { evaluate } from '#engine/push/evaluate.ts';
import {
  prepareCapturedPush,
  prepareCapturedPushes,
  type PushCapture,
  type PushPublication,
} from '#engine/server/push-project.ts';

const name = 'policy.test';
async function fixture(fn: (store: Store, tenant: Tenant) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema } });
  try {
    await fn(store, await openTenant(store, name, { create: true }));
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}
function capture(users: string[], sender = '@author:remote'): PushCapture {
  return {
    context: {
      event: {
        event_id: '$policy',
        room_id: '!policy:remote',
        sender,
        type: 'm.room.message',
        content: { body: 'ordinary message', msgtype: 'm.text' },
      },
      joinedCount: users.length + 1,
      senderPower: 0,
      notificationPower: {},
    },
    recipients: users.map((lp) => ({
      tenant: name,
      user: `@${lp}:${name}`,
      displayName: lp,
    })),
  };
}
async function pusher(tenant: Tenant, lp: string) {
  await tenant.tx(async (tx) => {
    const hash = 'policy-access-' + lp;
    await tx.tokens.insert(hash, lp, null, null);
    await tx.pushers.upsert(lp, {
      app_id: 'policy-app',
      pushkey: 'key-' + lp,
      kind: 'http',
      app_display_name: 'Policy',
      device_display_name: 'Policy',
      lang: 'en',
      data: { url: 'https://push.example/_matrix/push/v1/notify' },
    }, hash);
  });
}
async function ignored(tenant: Tenant, sender: string | null) {
  await tenant.tx(async (tx) => {
    await tx.accountData.put(
      'alice',
      '',
      'm.ignored_user_list',
      JSON.stringify({
        ignored_users: sender === null ? {} : { [sender]: {} },
      }),
      await tx.counters.nextStream(),
    );
  });
}

// Independent reference through the pre-existing scalar domain readers. This
// checks values and consumer verdicts, not a copy of the new set query.
async function scalar(
  tenant: Tenant,
  input: PushCapture,
): Promise<PushPublication> {
  return await tenant.tx(async (tx) => {
    const decisions: PushPublication['decisions'] = [];
    for (const recipient of input.recipients) {
      const lp = localpartOf(recipient.user);
      const account = await tx.users.byLocalpart(lp);
      if (account === null || account.deactivated) continue;
      const ignore = await tx.accountData.snapshot(
        lp,
        '',
        'm.ignored_user_list',
      );
      const rules = await rulesetAt(tx, lp, name);
      const ignoredUsers = (ignore?.content as
        | { ignored_users?: Record<string, unknown> }
        | undefined)?.ignored_users ?? {};
      decisions.push({
        tenant: name,
        user: recipient.user,
        ruleRevision: await tx.pushRules.streamSeq(lp),
        ignoreRevision: ignore?.seq ?? 0,
        pusherIncarnations: await tx.pushers.incarnations(lp),
        decision:
          Object.hasOwn(ignoredUsers, String(input.context.event.sender))
            ? null
            : evaluate(rules, {
              ...input.context,
              userId: recipient.user,
              displayName: recipient.displayName,
            }),
      });
    }
    return { sender: String(input.context.event.sender), decisions };
  });
}

Deno.test('push policy work: statements per notifying event do not scale with selected recipients', async () => {
  const samples: { recipients: number; statements: number }[] = [];
  for (const count of [1, 8]) {
    await fixture(async (store, tenant) => {
      const users = Array.from({ length: count }, (_, i) => 'u' + i);
      await tenant.tx(async (tx) => {
        for (const lp of users) await tx.users.insert(lp, lp);
      });
      for (const lp of users) await pusher(tenant, lp);
      const original = Turso.prototype.query;
      let statements = 0;
      Turso.prototype.query = function (...args) {
        statements++;
        return original.apply(this, args);
      };
      let result: PushPublication[];
      try {
        result = await prepareCapturedPushes(store, [capture(users)]);
      } finally {
        Turso.prototype.query = original;
      }
      assertEquals(result[0].decisions.length, count);
      assertEquals(
        result[0].decisions.filter((d) => d.decision?.notify).length,
        count,
      );
      assert(statements > 0);
      samples.push({ recipients: count, statements });
    });
  }
  console.log(JSON.stringify(samples));
  assertEquals(samples[0].statements, samples[1].statements);
});

Deno.test('push policy snapshot: scalar and grouped publication preserve account, ignore, rule and pusher values', async () => {
  await fixture(async (store, tenant) => {
    await tenant.tx(async (tx) => {
      for (const lp of ['alice', 'bob', 'gone']) await tx.users.insert(lp, lp);
      await tx.users.markDeactivated('gone');
    });
    await putRule(tenant, 'alice', 'override', 'policy-override', {
      conditions: [],
      actions: ['notify', { set_tweak: 'highlight', value: true }],
    }, {});
    await pusher(tenant, 'alice');
    await ignored(tenant, '@ignored:remote');
    const inputs = [
      capture(['alice', 'bob', 'gone', 'missing']),
      capture(['alice', 'bob'], '@ignored:remote'),
    ];
    const expected = await Promise.all(
      inputs.map((input) => scalar(tenant, input)),
    );
    assertEquals(await prepareCapturedPushes(store, inputs), expected);
    assertEquals(await prepareCapturedPush(store, inputs[0]), expected[0]);
    assertEquals(expected[0].decisions.map((d) => d.user), [
      '@alice:policy.test',
      '@bob:policy.test',
    ]);
    assertEquals(expected[0].decisions[0].decision?.ruleId, 'policy-override');
    assertEquals(expected[0].decisions[0].decision?.highlight, true);
    assertEquals(expected[0].decisions[0].pusherIncarnations?.length, 1);
    assertEquals(expected[1].decisions[0].decision, null);
  });
});

Deno.test('push policy snapshot: raw registrations without session admission never enter publication', async () => {
  await fixture(async (store, tenant) => {
    await tenant.tx((tx) => tx.users.insert('alice', 'alice'));
    await pusher(tenant, 'alice');
    const db = await store.tenant(name);
    await db.execute('DELETE FROM access_tokens');
    const input = capture(['alice']);
    const publication = await prepareCapturedPush(store, input);
    assertEquals(publication.decisions[0].pusherIncarnations, []);
    assertEquals(publication, await scalar(tenant, input));
  });
});

Deno.test('push policy snapshot: prepared contexts recapture committed revisions, routing and deactivation', async () => {
  await fixture(async (store, tenant) => {
    await tenant.tx(async (tx) => {
      await tx.users.insert('alice', 'alice');
      await tx.users.insert('bob', 'bob');
    });
    await putRule(tenant, 'alice', 'override', 'policy-override', {
      conditions: [],
      actions: ['notify'],
    }, {});
    await pusher(tenant, 'alice');
    const input = capture(['alice', 'bob']);
    const before = await prepareCapturedPush(store, input);
    await setRuleActions(tenant, 'alice', 'override', 'policy-override', [
      'dont_notify',
    ]);
    await ignored(tenant, '@author:remote');
    await tenant.tx(async (tx) => {
      await tx.pushers.delete('alice', 'policy-app', 'key-alice');
      await tx.users.markDeactivated('bob');
    });
    await pusher(tenant, 'alice');
    const after = await prepareCapturedPush(store, input);
    assertEquals(after, await scalar(tenant, input));
    assertEquals(after.decisions.length, 1);
    assertEquals(after.decisions[0].decision, null);
    assert(after.decisions[0].ruleRevision > before.decisions[0].ruleRevision);
    assert(
      after.decisions[0].ignoreRevision > before.decisions[0].ignoreRevision,
    );
    assertNotEquals(
      after.decisions[0].pusherIncarnations,
      before.decisions[0].pusherIncarnations,
    );
    await ignored(tenant, null);
    const unignored = await prepareCapturedPush(store, input);
    assertEquals(unignored, await scalar(tenant, input));
    assertEquals(unignored.decisions[0].decision?.notify, false);
  });
});

Deno.test('push policy snapshot: rolled-back policy edits do not escape into a later publication', async () => {
  await fixture(async (store, tenant) => {
    await tenant.tx((tx) => tx.users.insert('alice', 'alice'));
    await pusher(tenant, 'alice');
    const input = capture(['alice']);
    const before = await prepareCapturedPush(store, input);
    await assertRejects(
      () =>
        tenant.tx(async (tx) => {
          await tx.users.markDeactivated('alice');
          await tx.pushers.delete('alice', 'policy-app', 'key-alice');
          await tx.accountData.put(
            'alice',
            '',
            'm.ignored_user_list',
            '{"ignored_users":{"@author:remote":{}}}',
            await tx.counters.nextStream(),
          );
          throw new Error('rollback policy');
        }),
      Error,
      'rollback policy',
    );
    assertEquals(await prepareCapturedPush(store, input), before);
    assertEquals(before, await scalar(tenant, input));
  });
});

Deno.test('push policy owner: every rule kind uses existing hydration, and attempt-local reads see edits without leaking rollback', async () => {
  await fixture(async (store, tenant) => {
    await tenant.tx((tx) => tx.users.insert('alice', 'alice'));
    for (const kind of PUSH_KINDS) {
      for (const suffix of ['first', 'second']) {
        await putRule(tenant, 'alice', kind, kind + '-' + suffix, {
          actions: ['notify'],
          conditions: [],
          pattern: 'ordinary*',
        }, suffix === 'first' ? {} : { after: kind + '-first' });
      }
    }
    await setRuleEnabled(tenant, 'alice', 'override', '.m.rule.master', true);
    await setRuleActions(tenant, 'alice', 'underride', '.m.rule.message', [
      'dont_notify',
    ]);
    await pusher(tenant, 'alice');
    await (await store.tenant(name)).execute(
      "UPDATE pushers SET kind='email' WHERE localpart='alice'",
    );
    const before = await tenant.tx(async (tx) => {
      const policies = await tx.pushPolicy.capture([
        'alice',
        'alice',
        'missing',
      ]);
      assertEquals([...policies.keys()], ['alice']);
      const policy = policies.get('alice')!;
      assertEquals(policy.rules, await rulesetAt(tx, 'alice', name));
      assertEquals(policy.pusherIncarnations, []);
      assertEquals((await tx.pushPolicy.capture([])).size, 0);
      return policy;
    });
    await assertRejects(
      () =>
        tenant.tx(async (tx) => {
          await tx.users.markDeactivated('alice');
          assertEquals((await tx.pushPolicy.capture(['alice'])).size, 0);
          throw new Error('rollback captured policy');
        }),
      Error,
      'rollback captured policy',
    );
    assertEquals(
      await tenant.tx(async (tx) =>
        (await tx.pushPolicy.capture(['alice'])).get('alice')
      ),
      before,
    );
    before.rules.override[0].actions.push('mutated returned value');
    assertEquals(
      await tenant.tx(async (tx) =>
        (await tx.pushPolicy.capture(['alice'])).get('alice')!.rules
      ),
      await tenant.tx((tx) => rulesetAt(tx, 'alice', name)),
    );
  });
});
