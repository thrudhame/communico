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
import { registerOperations } from '#engine/facade/registers.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { queueBadge } from '#engine/server/push-queue.ts';
import { startPushSender } from '#engine/push/sender.ts';
import { createHash } from 'node:crypto';
import { registerJson } from '#engine/facade/registers.ts';
import { writeRegister } from '#engine/facade/registers.ts';
import {
  prepareCapturedPush,
  prepareInvitePush,
} from '#engine/server/push-project.ts';

const input = {
  app_id: 'app',
  pushkey: 'key',
  kind: 'http',
  app_display_name: 'App',
  device_display_name: 'Device',
  profile_tag: null,
  lang: 'en',
  append: true,
  data: { url: 'https://push.test/_matrix/push/v1/notify' },
};
const choiceKey = JSON.stringify(['pusher-choice', 'alice', 'app', 'key']);

async function fixture(enroll = true) {
  const dir = await Deno.makeTempDir({ prefix: 'pusher-choice-' });
  const open = (side: string) =>
    openStore({
      dir: dir + '/' + side,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { tenant: tenantSchema, server: serverSchema } });
  const home = await open('home'), edge = await open('edge');
  const ht = await openTenant(home, 'test', { create: true });
  const et = await openTenant(edge, 'test', { create: true });
  const hd = await home.tenant('test'), ed = await edge.tenant('test');
  for (
    const [node, tenant, db] of [['home', ht, hd], ['edge', et, ed]] as const
  ) {
    await tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
    if (enroll) {
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
  }
  const token = await issueToken(ht, 'alice', 'HOME');
  const edgeToken = await issueToken(et, 'alice', 'EDGE');
  const sync = async () => {
    const h = await hd.tx((conn) => captureSessionAuthority(conn, 'alice'));
    const e = await ed.tx((conn) => captureSessionAuthority(conn, 'alice'));
    await hd.tx((conn) => installSessionAuthority(conn, 'alice', e));
    await ed.tx((conn) => installSessionAuthority(conn, 'alice', h));
  };
  return {
    home,
    edge,
    ht,
    et,
    hd,
    ed,
    token,
    edgeToken,
    sync,
    open,
    async close() {
      await home.close();
      await edge.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('pusher activation: existing home registrations retain identity and queued work without account capture', async () => {
  const f = await fixture(false);
  try {
    await setPusher(f.ht, 'alice', f.token, input);
    const native = await f.hd.query('SELECT * FROM pushers');
    const changes = await f.hd.query('SELECT * FROM pusher_changes');
    await projectTenant(f.home, 'test');
    const server = await f.home.server();
    await server.tx((tx) => queueBadge(tx, '@alice:test'));
    const badges = await server.query('SELECT * FROM push_badges');
    const activate = () =>
      f.hd.tx((conn) =>
        activateTenantAuthority(conn, {
          node: 'home',
          incarnation: 'home-store',
          homeIncarnation: 'home-store',
          edgeNode: 'edge',
          edgeIncarnation: 'edge-store',
        })
      );
    await activate();
    const { append: _, ...publicPusher } = input;
    assertEquals(await listPushers(f.ht, 'alice'), [publicPusher]);
    assertEquals(
      await f.ht.tx((tx) =>
        tx.pushers.isCurrent(
          'alice',
          'app',
          'key',
          String(native[0].incarnation),
        )
      ),
      true,
    );
    const puts = await f.ht.tx((tx) => tx.pushers.operations('alice'));
    const choices = await f.ht.tx((tx) => tx.pushers.choices('alice'));
    assertEquals(puts.length, 1);
    assertEquals(choices.length, 1);
    await activate();
    assertEquals(await f.ht.tx((tx) => tx.pushers.operations('alice')), puts);
    assertEquals(await f.ht.tx((tx) => tx.pushers.choices('alice')), choices);
    assertEquals(await f.hd.query('SELECT * FROM pushers'), native);
    assertEquals(await f.hd.query('SELECT * FROM pusher_changes'), changes);
    assertEquals(await server.query('SELECT * FROM push_badges'), badges);
  } finally {
    await f.close();
  }
});

Deno.test('pusher activation: recorded removals and incomplete choices are never backfilled from native rows', async (t) => {
  for (const pending of [false, true]) {
    await t.step(String(pending), async () => {
      const f = await fixture(false);
      try {
        await setPusher(f.ht, 'alice', f.token, input);
        const [native] = await f.hd.query('SELECT * FROM pushers');
        const target = JSON.stringify([
          'pusher',
          'alice',
          'app',
          'key',
          native.incarnation,
        ]);
        await f.hd.tx((conn) =>
          writeRegister(
            conn,
            { source: 'home', incarnation: 'home-store' },
            choiceKey,
            'pusher-choice',
            JSON.stringify(
              pending
                ? JSON.stringify([
                  'home',
                  'home-store',
                  'register:' + target,
                  1,
                ])
                : null,
            ),
          )
        );
        const before = await f.ht.tx((tx) => tx.pushers.choices('alice'));
        await f.hd.tx((conn) =>
          activateTenantAuthority(conn, {
            node: 'home',
            incarnation: 'home-store',
            homeIncarnation: 'home-store',
            edgeNode: 'edge',
            edgeIncarnation: 'edge-store',
          })
        );
        assertEquals(await f.ht.tx((tx) => tx.pushers.operations('alice')), []);
        assertEquals(
          await f.ht.tx((tx) => tx.pushers.choices('alice')),
          before,
        );
        if (pending) {
          await assertRejects(
            () => listPushers(f.ht, 'alice'),
            Error,
            'pusher selection unavailable',
          );
        } else assertEquals(await listPushers(f.ht, 'alice'), []);
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('pusher choice: registration chooses once, refresh preserves choice and removal never falls back', async () => {
  const f = await fixture();
  try {
    await setPusher(f.ht, 'alice', f.token, input);
    const before = await f.hd.tx((conn) => registerOperations(conn, choiceKey));
    assertEquals(before.length, 1, 'registration has no causal active choice');
    const refresh = await issueRefreshToken(f.ht, 'alice', 'HOME', f.token);
    const rotated = await consumeRefreshToken(f.ht, refresh);
    assertEquals(
      await f.hd.tx((conn) => registerOperations(conn, choiceKey)),
      before,
    );
    const { append: _, ...publicPusher } = input;
    assertEquals(await listPushers(f.ht, 'alice'), [publicPusher]);
    await setPusher(f.ht, 'alice', rotated.accessToken, {
      ...input,
      kind: null,
    });
    assertEquals(await listPushers(f.ht, 'alice'), []);
  } finally {
    await f.close();
  }
});

Deno.test('pusher choice: concurrent registrations converge across public reads and native sender admission', async () => {
  const f = await fixture();
  try {
    await setPusher(f.ht, 'alice', f.token, input);
    await setPusher(f.et, 'alice', f.edgeToken, {
      ...input,
      device_display_name: 'Edge',
    });
    const [hr] = await f.hd.query('SELECT * FROM pushers');
    const [er] = await f.ed.query('SELECT * FROM pushers');
    const hp = await f.ht.tx((tx) => tx.pushers.operations('alice'));
    const ep = await f.et.tx((tx) => tx.pushers.operations('alice'));
    const hc = await f.hd.tx((conn) => registerOperations(conn, choiceKey));
    const ec = await f.ed.tx((conn) => registerOperations(conn, choiceKey));
    assertEquals(hc.length, 1, 'home choice missing');
    assertEquals(ec.length, 1, 'edge choice missing');
    await f.sync();
    for (const op of [...ep, ...ec]) {
      await f.ht.tx((tx) => tx.pushers.import(op));
    }
    for (const op of [...hc, ...hp]) {
      await f.et.tx((tx) => tx.pushers.import(op));
    }
    assertEquals(
      await listPushers(f.et, 'alice'),
      await listPushers(f.ht, 'alice'),
    );
    assertEquals(
      (await listPushers(f.et, 'alice'))[0].device_display_name,
      'Device',
    );
    assertEquals(
      await f.ht.tx((tx) =>
        tx.pushers.isCurrent('alice', 'app', 'key', String(hr.incarnation))
      ),
      true,
    );
    assertEquals(
      await f.et.tx((tx) =>
        tx.pushers.isCurrent('alice', 'app', 'key', String(er.incarnation))
      ),
      false,
    );
    assertEquals(await f.et.tx((tx) => tx.pushers.incarnations('alice')), []);
    assertEquals(
      await f.et.tx(async (tx) =>
        (await tx.pushPolicy.capture(['alice'])).get('alice')
          ?.pusherIncarnations
      ),
      [],
      'publication policy must not route a losing local registration',
    );
    assertEquals(
      (await f.ed.query('SELECT * FROM pusher_changes WHERE payload IS NULL'))
        .length,
      1,
    );
    const sent = { home: 0, edge: 0 };
    for (const side of ['home', 'edge'] as const) {
      const store = f[side], tenant = side === 'home' ? f.ht : f.et;
      await projectTenant(store, 'test');
      await (await store.server()).tx((tx) => queueBadge(tx, '@alice:test'));
      const sender = await startPushSender({
        store,
        tenant,
        automatic: false,
        send: () => {
          sent[side]++;
          return Promise.resolve([]);
        },
      });
      try {
        await sender.tick();
      } finally {
        await sender.stop();
      }
    }
    assertEquals(sent, { home: 1, edge: 0 });
    await setPusher(f.ht, 'alice', f.token, { ...input, kind: null });
    for (const op of await f.ht.tx((tx) => tx.pushers.operations('alice'))) {
      await f.et.tx((tx) => tx.pushers.import(op));
    }
    assertEquals(await listPushers(f.et, 'alice'), []);
    assertEquals(await f.et.tx((tx) => tx.pushers.incarnations('alice')), []);
  } finally {
    await f.close();
  }
});

Deno.test('pusher choice: missing selected registration is unavailable, not empty or an older winner', async () => {
  const f = await fixture();
  try {
    await setPusher(f.ht, 'alice', f.token, input);
    const [choice] = await f.hd.tx((conn) =>
      registerOperations(conn, choiceKey)
    );
    assertEquals(Boolean(choice), true, 'choice missing');
    await setPusher(f.et, 'alice', f.edgeToken, {
      ...input,
      device_display_name: 'Edge',
    });
    const [native] = await f.ed.query('SELECT * FROM pushers');
    await projectTenant(f.edge, 'test');
    const server = await f.edge.server();
    await server.tx((tx) => queueBadge(tx, '@alice:test'));
    const badges = await server.query('SELECT * FROM push_badges');
    await f.sync();
    await f.et.tx((tx) => tx.pushers.import(choice));
    assertEquals(
      (await f.et.tx((tx) => tx.pushPolicy.capture(['alice']))).get('alice')
        ?.pusherIncarnations,
      [String(native.incarnation)],
      'unresolved routing must retain a candidate without admitting a send',
    );
    const event = {
      event_id: '$pending-choice',
      room_id: '!pending:test',
      sender: '@bob:test',
      type: 'm.room.member',
      state_key: '@alice:test',
      content: { membership: 'invite' },
      prev_events: [],
      auth_events: [],
      depth: 1,
      origin_server_ts: 1,
      hashes: { sha256: '' },
      signatures: {},
    };
    const captured = await prepareCapturedPush(f.edge, {
      context: { event, joinedCount: 2, senderPower: 0, notificationPower: {} },
      recipients: [{
        tenant: 'test',
        user: '@alice:test',
        displayName: 'Alice',
      }],
    });
    assertEquals(captured.decisions.length, 1);
    assertEquals(captured.decisions[0].pusherIncarnations, [
      String(native.incarnation),
    ]);
    const invited = await prepareInvitePush(f.edge, 'test', event);
    assertEquals(invited.decisions.length, 1);
    assertEquals(invited.decisions[0].pusherIncarnations, [
      String(native.incarnation),
    ]);
    await assertRejects(
      () => listPushers(f.et, 'alice'),
      Error,
      'pusher selection unavailable',
    );
    await assertRejects(
      () =>
        f.et.tx((tx) =>
          tx.pushers.isCurrent(
            'alice',
            'app',
            'key',
            String(native.incarnation),
          )
        ),
      Error,
      'pusher selection unavailable',
    );
    let sends = 0;
    const sender = await startPushSender({
      store: f.edge,
      tenant: f.et,
      automatic: false,
      send: () => {
        sends++;
        return Promise.resolve([]);
      },
    });
    try {
      await assertRejects(
        () => sender.tick(),
        Error,
        'pusher selection unavailable',
      );
    } finally {
      await sender.stop();
    }
    assertEquals(sends, 0);
    assertEquals(
      await server.query('SELECT * FROM push_badges'),
      badges,
      'unavailable selection canceled queued badge',
    );
    for (const op of await f.ht.tx((tx) => tx.pushers.operations('alice'))) {
      await f.et.tx((tx) => tx.pushers.import(op));
    }
    assertEquals(
      await listPushers(f.et, 'alice'),
      await listPushers(f.ht, 'alice'),
    );
    assertEquals(await f.ed.query('SELECT * FROM pushers'), []);
    await f.edge.close();
    const cold = await f.open('edge');
    try {
      const tenant = await openTenant(cold, 'test');
      assertEquals(
        await listPushers(tenant, 'alice'),
        await listPushers(f.ht, 'alice'),
      );
      assertEquals(
        await (await cold.tenant('test')).query('SELECT * FROM pushers'),
        [],
      );
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('pusher choice: selection intent and native registration commit atomically', async () => {
  const f = await fixture();
  try {
    await f.hd.exec(
      "CREATE TRIGGER refuse_choice BEFORE INSERT ON domain_operations WHEN NEW.kind='pusher-choice' BEGIN SELECT RAISE(ABORT,'fixture choice failure'); END",
    );
    await assertRejects(() => setPusher(f.ht, 'alice', f.token, input));
    assertEquals(await f.hd.query('SELECT * FROM pushers'), []);
    assertEquals(await f.ht.tx((tx) => tx.pushers.operations('alice')), []);
    assertEquals(await f.hd.query('SELECT * FROM pusher_changes'), []);
  } finally {
    await f.close();
  }
});

Deno.test('pusher choice: empty kind=null retains causal intent and an observed successor can register again', async () => {
  const f = await fixture();
  try {
    await setPusher(f.ht, 'alice', f.token, { ...input, kind: null });
    const nulls = await f.ht.tx((tx) => tx.pushers.choices('alice'));
    assertEquals(nulls.length, 1, 'empty removal omitted its choice intent');
    assertEquals(nulls[0].payload, 'null');
    await setPusher(f.et, 'alice', f.edgeToken, input);
    await f.sync();
    for (
      const op of [
        ...await f.et.tx((tx) => tx.pushers.operations('alice')),
        ...await f.et.tx((tx) => tx.pushers.choices('alice')),
      ]
    ) await f.ht.tx((tx) => tx.pushers.import(op));
    await f.et.tx((tx) => tx.pushers.import(nulls[0]));
    assertEquals(await listPushers(f.ht, 'alice'), []);
    assertEquals(await listPushers(f.et, 'alice'), []);
    await setPusher(f.et, 'alice', f.edgeToken, {
      ...input,
      device_display_name: 'After removal',
    });
    for (
      const op of [
        ...await f.et.tx((tx) => tx.pushers.operations('alice')),
        ...await f.et.tx((tx) => tx.pushers.choices('alice')),
      ]
    ) await f.ht.tx((tx) => tx.pushers.import(op));
    assertEquals(
      await listPushers(f.ht, 'alice'),
      await listPushers(f.et, 'alice'),
    );
    assertEquals(
      (await listPushers(f.ht, 'alice'))[0].device_display_name,
      'After removal',
    );
  } finally {
    await f.close();
  }
});

Deno.test('pusher choice: imported cancellation rolls back with its choice and replay has no echo', async () => {
  const f = await fixture();
  try {
    await setPusher(f.ht, 'alice', f.token, input);
    await setPusher(f.et, 'alice', f.edgeToken, {
      ...input,
      device_display_name: 'Edge',
    });
    await f.sync();
    for (const put of await f.ht.tx((tx) => tx.pushers.operations('alice'))) {
      await f.et.tx((tx) => tx.pushers.import(put));
    }
    const [choice] = await f.hd.tx((conn) =>
      registerOperations(conn, choiceKey)
    );
    const before = await f.ed.query('SELECT * FROM pushers');
    const choices = await f.ed.tx((conn) =>
      registerOperations(conn, choiceKey)
    );
    await f.ed.exec(
      "CREATE TRIGGER refuse_choice_cancel BEFORE INSERT ON pusher_changes WHEN NEW.payload IS NULL BEGIN SELECT RAISE(ABORT,'fixture cancellation failure'); END",
    );
    await assertRejects(() => f.et.tx((tx) => tx.pushers.import(choice)));
    assertEquals(await f.ed.query('SELECT * FROM pushers'), before);
    assertEquals(
      await f.ed.tx((conn) => registerOperations(conn, choiceKey)),
      choices,
    );
    await f.ed.exec('DROP TRIGGER refuse_choice_cancel');
    await f.et.tx((tx) => tx.pushers.import(choice));
    const changes = await f.ed.query('SELECT * FROM pusher_changes');
    await f.et.tx((tx) => tx.pushers.import(choice));
    assertEquals(await f.ed.query('SELECT * FROM pusher_changes'), changes);
    assertEquals(await f.ed.query('SELECT * FROM pushers'), []);
    assertEquals(
      (await f.et.tx((tx) => tx.pushers.operations('alice'))).some((op) =>
        op.payload === 'null'
      ),
      false,
    );
  } finally {
    await f.close();
  }
});

Deno.test('pusher choice: reference binds source, account and app/key without exposing invalid payloads', async () => {
  const f = await fixture();
  try {
    await setPusher(f.ht, 'alice', f.token, input);
    const [choice] = await f.hd.tx((conn) =>
      registerOperations(conn, choiceKey)
    );
    const reference = JSON.parse(JSON.parse(choice.payload)) as unknown[];
    await f.sync();
    for (
      const value of [
        { registration: 'private-pusher-value' },
        JSON.stringify(['edge', ...reference.slice(1)]),
        JSON.stringify([
          reference[0],
          reference[1],
          'register:' +
          JSON.stringify(['pusher', 'bob', 'app', 'key', crypto.randomUUID()]),
          reference[3],
        ]),
        JSON.stringify([
          reference[0],
          reference[1],
          'register:' +
          JSON.stringify([
            'pusher',
            'alice',
            'other',
            'key',
            crypto.randomUUID(),
          ]),
          reference[3],
        ]),
      ]
    ) {
      const payload = registerJson(JSON.stringify(value));
      const invalid = {
        ...choice,
        payload,
        payloadHash: createHash('sha256').update(payload).digest('hex'),
      };
      await assertRejects(
        () => f.et.tx((tx) => tx.pushers.import(invalid)),
        Error,
        'invalid pusher choice',
      );
      assertEquals(
        await f.ed.tx((conn) => registerOperations(conn, choiceKey)),
        [],
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('pusher choice: an observed successor dominates the concurrent winner rather than tuple order', async () => {
  const f = await fixture();
  try {
    await setPusher(f.ht, 'alice', f.token, input);
    await f.sync();
    const hp = await f.ht.tx((tx) => tx.pushers.operations('alice'));
    const hc = await f.ht.tx((tx) => tx.pushers.choices('alice'));
    for (const op of [...hp, ...hc]) {
      await f.et.tx((tx) => tx.pushers.import(op));
    }
    await setPusher(f.et, 'alice', f.edgeToken, {
      ...input,
      device_display_name: 'Successor',
    });
    // The successor choice may precede its referenced put and its predecessors.
    for (
      const op of (await f.et.tx((tx) => tx.pushers.choices('alice'))).reverse()
    ) await f.ht.tx((tx) => tx.pushers.import(op));
    await assertRejects(
      () => listPushers(f.ht, 'alice'),
      Error,
      'pusher selection unavailable',
    );
    for (
      const op of (await f.et.tx((tx) => tx.pushers.operations('alice')))
        .reverse()
    ) await f.ht.tx((tx) => tx.pushers.import(op));
    assertEquals(
      await listPushers(f.ht, 'alice'),
      await listPushers(f.et, 'alice'),
    );
    assertEquals(
      (await listPushers(f.ht, 'alice'))[0].device_display_name,
      'Successor',
    );
    assertEquals(await f.ht.tx((tx) => tx.pushers.incarnations('alice')), []);
  } finally {
    await f.close();
  }
});

Deno.test('pusher choice: retained terminal authority suppresses foreign public registrations without an import echo', async (t) => {
  for (
    const terminal of ['revoke', 'barrier', 'delete', 'deactivate'] as const
  ) {
    await t.step(terminal, async () => {
      const f = await fixture();
      try {
        await setPusher(f.ht, 'alice', f.token, input);
        await f.sync();
        const facts = await f.ht.tx((tx) => tx.pushers.operations('alice'));
        const choices = await f.hd.tx((conn) =>
          registerOperations(conn, choiceKey)
        );
        assertEquals(choices.length, 1, 'choice missing');
        for (const op of [...facts, ...choices]) {
          await f.et.tx((tx) => tx.pushers.import(op));
        }
        assertEquals(
          (await listPushers(f.et, 'alice')).length,
          1,
          'foreign registration missing',
        );
        const {
          recordRevocation,
          recordLogoutBarrier,
          recordDeviceDeletion,
          recordDeactivation,
        } = await import('#engine/tenant/session-authority.ts');
        const { hashToken } = await import('#engine/tenant/auth.ts');
        await f.hd.tx(async (conn) => {
          if (terminal === 'revoke') {
            await recordRevocation(conn, await hashToken(f.token));
          }
          if (terminal === 'barrier') {
            await recordLogoutBarrier(conn, 'alice');
          }
          if (terminal === 'delete') {
            await recordDeviceDeletion(conn, 'alice', 'HOME');
          }
          if (terminal === 'deactivate') {
            await recordDeactivation(conn, 'alice', false);
          }
        });
        await f.sync();
        assertEquals(await listPushers(f.et, 'alice'), []);
        assertEquals(
          await f.et.tx((tx) => tx.pushers.operations('alice')),
          facts,
        );
        assertEquals(
          await f.ed.tx((conn) => registerOperations(conn, choiceKey)),
          choices,
        );
      } finally {
        await f.close();
      }
    });
  }
});
