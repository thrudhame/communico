import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  consumeRefreshToken,
  issueRefreshToken,
  issueToken,
  revokeToken,
} from '#engine/tenant/auth.ts';
import { setPusher } from '#engine/tenant/pushers.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { project } from '#engine/server/project.ts';
import { bobJoins, genesis } from '#tests/fixtures/genesis.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { advanceNotificationRead } from '#engine/server/notifications.ts';
import { queueBadge } from '#engine/server/push-queue.ts';
import {
  preparePushWork,
  type PushTarget,
  retryPushWork,
} from '#engine/server/push-work.ts';
import { startPushSender } from '#engine/push/sender.ts';
import { setConfigForTests } from '#engine/config.ts';
import { renderEvent } from '#engine/client/render.ts';
import { putAccountData } from '#engine/tenant/accountdata.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { sendGateway } from '#engine/push/transport.ts';

type Json = Record<string, unknown>;
async function fixture() {
  const dir = await Deno.makeTempDir();
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const schemas = {
    room: roomSchema,
    tenant: tenantSchema,
    server: serverSchema,
  };
  let store = await openStore(options, { schemas });
  let tenant = await openTenant(store, 'test', { create: true });
  await tenant.tx(async (tx) => {
    await tx.users.insert('dev', 'Dev');
    await tx.users.insert('bob', 'Bob');
  });
  const token = await issueToken(tenant, 'bob', 'B');
  const g = await genesis(store, { roomId: '!push-sender:test' });
  await bobJoins(g);
  await project(store, g.roomId);
  const register = async (format?: string) => {
    await setPusher(tenant, 'bob', token, {
      app_id: 'app',
      pushkey: 'key',
      kind: 'http',
      app_display_name: 'App',
      device_display_name: 'B',
      lang: 'en',
      data: {
        url: 'https://push.test/_matrix/push/v1/notify',
        ...(format ? { format } : {}),
        custom: 'kept',
      },
    });
    await projectTenant(store, 'test');
  };
  await register();
  return {
    get store() {
      return store;
    },
    get tenant() {
      return tenant;
    },
    token,
    g,
    register,
    send: async (body: string) => {
      const e = await sendLocal(await openRoom(store, g.roomId), {
        type: 'm.room.message',
        sender: g.creator,
        content: { body, msgtype: 'm.text', 'm.mentions': {} },
      }, g.signer);
      await project(store, g.roomId);
      return e.eventId;
    },
    read: async (event: string) => {
      const db = await store.server();
      await db.tx((tx) =>
        advanceNotificationRead(
          tx,
          '@bob:test',
          g.roomId,
          '',
          event,
          Date.now(),
        )
      );
    },
    reopen: async () => {
      await store.close();
      store = await openStore(options, { schemas });
      tenant = await openTenant(store, 'test');
    },
    close: async () => {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('standalone renderer: explicit tenant owns ignored users and nested thread consumers without an app singleton', async () => {
  const f = await fixture();
  try {
    const room = await openRoom(f.store, f.g.roomId);
    const root = await sendLocal(room, {
      type: 'm.room.message',
      sender: '@bob:test',
      content: { body: 'root', msgtype: 'm.text' },
    }, f.g.signer);
    const reply = await sendLocal(room, {
      type: 'm.room.message',
      sender: f.g.creator,
      content: {
        body: 'reply',
        msgtype: 'm.text',
        'm.relates_to': { rel_type: 'm.thread', event_id: root.eventId },
      },
    }, f.g.signer);
    await project(f.store, f.g.roomId);
    const viewer = { userId: '@bob:test', deviceId: null, tenant: f.tenant };
    const shown = await renderEvent(room, root.eventId, viewer);
    const thread =
      ((shown!.unsigned as Json)['m.relations'] as Json)['m.thread'] as Json;
    assertEquals(thread.count, 1);
    assertEquals((thread.latest_event as Json).event_id, reply.eventId);
    await putAccountData(f.tenant, 'bob', '', 'm.ignored_user_list', {
      ignored_users: { [f.g.creator]: {} },
    });
    const filtered = await renderEvent(room, root.eventId, viewer);
    assertEquals((filtered!.unsigned as Json)['m.relations'], undefined);
    assertEquals(await renderEvent(room, reply.eventId, viewer), null);
    assert(
      await renderEvent(room, f.g.createId, viewer),
      'ignoring a sender must not suppress state',
    );
  } finally {
    await f.close();
  }
});

Deno.test('push sender: saved decision reaches gateway, read-before-send suppresses alerts even with retention zero, explicit badge zero', async () => {
  setConfigForTests({ push: { readretentiondays: 0 } });
  const f = await fixture();
  const requests: Json[] = [];
  const sender = await startPushSender({
    store: f.store,
    tenant: f.tenant,
    automatic: false,
    send: (_url, body) => {
      requests.push(body as Json);
      return Promise.resolve([]);
    },
  });
  try {
    await sender.tick();
    assertEquals(requests, [], 'registration never probes a gateway');
    const event = await f.send('saved decision');
    await f.tenant.tx((tx) =>
      tx.pushRules.putDefault('bob', 'override', {
        rule_id: '.m.rule.master',
        default: true,
        enabled: true,
        conditions: [],
        actions: [],
      })
    );
    await sender.tick();
    const n = requests[0].notification as Json;
    assertEquals(n.event_id, event);
    assertEquals(n.content, {
      body: 'saved decision',
      msgtype: 'm.text',
      'm.mentions': {},
    });
    assertEquals(n.counts, { unread: 1 });
    assertEquals(n.sender, f.g.creator);
    await f.tenant.tx((tx) =>
      tx.pushRules.setEnabled('bob', 'override', '.m.rule.master', false)
    );
    const db = await f.store.server();
    assertEquals(
      (await db.query('SELECT state FROM push_delivery'))[0].state,
      'sent',
    );
    const readEvent = await f.send('read before send');
    await f.read(readEvent);
    assertEquals(
      await db.query('SELECT * FROM notification_history WHERE user=?', [
        '@bob:test',
      ]),
      [],
    );
    await sender.tick();
    assertEquals(requests.length, 2);
    assertEquals(Object.keys(requests[1].notification as Json).sort(), [
      'counts',
      'devices',
    ]);
    assertEquals((requests[1].notification as Json).counts, { unread: 0 });
    assertEquals(
      (await db.query('SELECT state FROM push_delivery WHERE event=?', [
        readEvent,
      ]))[0].state,
      'cancelled',
    );
    await sender.tick();
    assertEquals(requests.length, 2);
  } finally {
    await sender.stop();
    setConfigForTests({});
    await f.close();
  }
});

Deno.test('push sender: retry backoff persists across reopen; expiry never deletes unread facts or pretends badge success', async () => {
  const f = await fixture();
  let now = Date.now(), calls = 0;
  let sender = await startPushSender({
    store: f.store,
    tenant: f.tenant,
    automatic: false,
    now: () => now,
    random: () => 0.5,
    giveUpMs: 5000,
    send: () => {
      calls++;
      return Promise.reject(
        new UpstreamError('transport', {
          phase: 'connect',
          reason: 'retryable',
        }),
      );
    },
  });
  try {
    const event = await f.send('retry');
    await sender.tick();
    let db = await f.store.server();
    const first = (await db.query('SELECT * FROM push_delivery'))[0];
    assertEquals(first.state, 'pending');
    assertEquals(first.attempts, 1);
    assertEquals(first.next_ms, now + 1000);
    await sender.tick();
    assertEquals(calls, 1);
    await sender.stop();
    await f.reopen();
    sender = await startPushSender({
      store: f.store,
      tenant: f.tenant,
      automatic: false,
      now: () => now,
      random: () => 0.5,
      giveUpMs: 5000,
      send: () => {
        calls++;
        return Promise.reject(
          new UpstreamError('transport', {
            phase: 'connect',
            reason: 'retryable',
          }),
        );
      },
    });
    await sender.tick();
    assertEquals(calls, 1);
    now += 1000;
    await sender.tick();
    assertEquals(calls, 2);
    db = await f.store.server();
    assertEquals(
      (await db.query('SELECT * FROM push_delivery'))[0].next_ms,
      now + 2000,
    );
    now += 5000;
    await sender.tick();
    assertEquals(
      (await db.query('SELECT state FROM push_delivery'))[0].state,
      'expired',
    );
    const badge = (await db.query('SELECT * FROM push_badges'))[0];
    assertEquals(badge.sent_revision, 0);
    assertEquals(badge.expired_revision, badge.revision);
    assertEquals(
      (await db.query(
        'SELECT read_ms,withdrawn FROM notifications WHERE event=?',
        [event],
      ))[0],
      { read_ms: null, withdrawn: 0 },
    );
    await db.tx(async (tx) => {
      await queueBadge(tx, '@bob:test');
      // This fixture's clock has advanced independently of Date.now().
      await tx.execute('UPDATE push_badges SET created_ms=?', [now]);
    });
    await sender.tick();
    assertEquals(calls, 3, 'new revision gets a fresh retry lifetime');
  } finally {
    await sender.stop();
    await f.close();
  }
});

Deno.test('push sender: crash after send before acknowledgment retries the same stable event, current removal suppresses work after restart', async () => {
  const f = await fixture();
  const ids: unknown[] = [];
  let crash = true;
  let sender = await startPushSender({
    store: f.store,
    tenant: f.tenant,
    automatic: false,
    afterSend: () => {
      if (crash) throw new Error('simulated crash');
    },
    send: (_url, payload) => {
      ids.push((payload as { notification: Json }).notification.event_id);
      return Promise.resolve([]);
    },
  });
  try {
    const event = await f.send('at least once');
    await assertRejects(() => sender.tick(), Error, 'simulated crash');
    const db = await f.store.server();
    assertEquals(
      (await db.query('SELECT state,attempts FROM push_delivery'))[0],
      { state: 'pending', attempts: 0 },
    );
    await sender.stop();
    await f.reopen();
    crash = false;
    sender = await startPushSender({
      store: f.store,
      tenant: f.tenant,
      automatic: false,
      send: (_url, payload) => {
        ids.push((payload as { notification: Json }).notification.event_id);
        return Promise.resolve([]);
      },
    });
    await sender.tick();
    assertEquals(ids, [event, event]);
    await f.send('revoked');
    await revokeToken(f.tenant, f.token);
    await sender.stop();
    await f.reopen();
    sender = await startPushSender({
      store: f.store,
      tenant: f.tenant,
      automatic: false,
      send: () => {
        return Promise.reject(new Error('must not send'));
      },
    });
    await sender.tick();
    assertEquals(
      await (await f.store.server()).query(
        "SELECT state FROM push_delivery WHERE state='pending'",
      ),
      [],
    );
  } finally {
    await sender.stop();
    await f.close();
  }
});

Deno.test('push sender: old rejection cannot delete a replacement; one in-flight stable identity and a newer badge is not acknowledged', async () => {
  const f = await fixture();
  let release!: (keys: string[]) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => entered = resolve);
  const calls: Json[] = [];
  const sender = await startPushSender({
    store: f.store,
    tenant: f.tenant,
    automatic: false,
    send: async (_url, body) => {
      calls.push(body as Json);
      if (calls.length === 1) {
        entered();
        return await new Promise<string[]>((resolve) => release = resolve);
      }
      return ['unrelated-key'];
    },
  });
  try {
    const event = await f.send('old incarnation');
    const pending = sender.tick();
    await started;
    await f.register('event_id_only');
    const newer = await f.send('new incarnation');
    const concurrent = sender.tick();
    assertEquals(calls.length, 1);
    release(['key']);
    await pending;
    await concurrent;
    assertEquals(
      (await f.tenant.tx((tx) => tx.pushers.ofUser('bob'))).length,
      1,
    );
    await sender.tick();
    assertEquals(calls.length, 2);
    const n = calls[1].notification as Json;
    assertEquals(n.event_id, newer);
    assert(n.event_id !== event);
    assertEquals(n.content, undefined);
    assertEquals(
      (await f.tenant.tx((tx) => tx.pushers.ofUser('bob'))).length,
      1,
    );
  } finally {
    await sender.stop();
    await f.close();
  }
});

Deno.test('push sender: response acknowledges only the badge revision sent; shutdown aborts transport and leaves durable work', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => entered = resolve);
  const calls: Json[] = [];
  let sender = await startPushSender({
    store: f.store,
    tenant: f.tenant,
    automatic: false,
    send: async (_url, body) => {
      calls.push(body as Json);
      if (calls.length === 1) {
        entered();
        await new Promise<void>((resolve) => release = resolve);
      }
      return [];
    },
  });
  try {
    const event = await f.send('in flight');
    const pending = sender.tick();
    await started;
    await f.read(event);
    release();
    await pending;
    const db = await f.store.server();
    const badge = (await db.query('SELECT * FROM push_badges'))[0];
    assert(Number(badge.revision) > Number(badge.sent_revision));
    await sender.tick();
    assertEquals((calls[1].notification as Json).counts, { unread: 0 });
    await sender.stop();
    let aborted = false, began!: () => void;
    const ready = new Promise<void>((resolve) => began = resolve);
    sender = await startPushSender({
      store: f.store,
      tenant: f.tenant,
      automatic: false,
      send: async (_url, _body, signal) => {
        began();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(signal.reason);
          }, { once: true })
        );
        return [];
      },
    });
    const last = await f.send('stop me');
    const job = sender.tick();
    await ready;
    await sender.stop();
    await job;
    assert(aborted);
    assertEquals(
      (await db.query(
        'SELECT state,attempts FROM push_delivery WHERE event=?',
        [last],
      ))[0],
      { state: 'pending', attempts: 0 },
    );
  } finally {
    await sender.stop();
    await f.close();
  }
});

Deno.test('push sender: local faults are not peer retries or successful verdicts', async () => {
  const f = await fixture();
  const fault = new Error('local gateway dependency');
  const sender = await startPushSender({
    store: f.store,
    tenant: f.tenant,
    automatic: false,
    send: () => Promise.reject(fault),
  });
  try {
    await f.send('must stay pending');
    assertEquals(await assertRejects(() => sender.tick()), fault);
    const db = await f.store.server();
    const row =
      (await db.query('SELECT state, attempts FROM push_delivery'))[0];
    assertEquals(row, { state: 'pending', attempts: 0 });
    assertEquals(
      (await f.tenant.tx((tx) => tx.pushers.ofUser('bob'))).length,
      1,
    );
  } finally {
    await sender.stop();
    await f.close();
  }
});

Deno.test('push sender: invalid UTF8 rejected target cannot remove a pusher or acknowledge delivery', async () => {
  const f = await fixture();
  let calls = 0;
  const sender = await startPushSender({
    store: f.store,
    tenant: f.tenant,
    automatic: false,
    send: (url, payload, signal) =>
      sendGateway(url, payload, signal, {
        blocklist: [],
        allowlist: [],
        caCerts: [],
        timeoutMs: 1000,
      }, {
        resolve: () => Promise.resolve(['8.8.8.8']),
        dial: () => {
          calls++;
          return Promise.resolve({
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            body: new Uint8Array([
              ...new TextEncoder().encode('{"rejected":["key"],"extension":"'),
              255,
              ...new TextEncoder().encode('"}'),
            ]),
          });
        },
      }),
  });
  try {
    await f.send('invalid verdict');
    await sender.tick();
    assertEquals(calls, 1);
    assertEquals(
      (await f.tenant.tx((tx) => tx.pushers.ofUser('bob'))).length,
      1,
    );
    const db = await f.store.server();
    assertEquals(
      (await db.query('SELECT state, attempts FROM push_delivery'))[0],
      { state: 'pending', attempts: 1 },
    );
    assertEquals(await db.query('SELECT * FROM push_rejections'), []);
  } finally {
    await sender.stop();
    await f.close();
  }
});

Deno.test('push sender: persisted gateway rejection retries failed tenant cleanup without a pending tenant revision', async () => {
  const f = await fixture();
  let calls = 0;
  const sender = await startPushSender({
    store: f.store,
    tenant: f.tenant,
    automatic: false,
    send: () => {
      calls++;
      return Promise.resolve(['key']);
    },
  });
  const original = f.store.tenant.bind(f.store);
  try {
    await f.send('reject and recover');
    f.store.tenant = () => Promise.reject(new Error('tenant unavailable'));
    await assertRejects(() => sender.tick(), Error, 'tenant unavailable');
    f.store.tenant = original;
    const db = await f.store.server();
    const tenantDb = await f.store.tenant('test');
    assertEquals(
      await tenantDb.query(
        "SELECT value FROM counters WHERE name='projection_pending'",
      ),
      [],
    );
    assertEquals((await db.query('SELECT * FROM push_rejections')).length, 1);
    assertEquals(
      (await f.tenant.tx((tx) => tx.pushers.ofUser('bob'))).length,
      1,
    );
    await sender.tick();
    assertEquals(await f.tenant.tx((tx) => tx.pushers.ofUser('bob')), []);
    assertEquals(await db.query('SELECT * FROM push_rejections'), []);
    assertEquals(await db.query('SELECT * FROM push_targets'), []);
    assertEquals(
      calls,
      1,
      'rejection recovery never resends the rejected target',
    );
  } finally {
    f.store.tenant = original;
    await sender.stop();
    await f.close();
  }
});

Deno.test('push sender: refresh retains delivery, a matching rejected verdict deletes the registration, stale device generation cannot send', async () => {
  const f = await fixture();
  let calls = 0;
  const sender = await startPushSender({
    store: f.store,
    tenant: f.tenant,
    automatic: false,
    send: () => {
      calls++;
      return Promise.resolve(['key']);
    },
  });
  try {
    const refresh = await issueRefreshToken(f.tenant, 'bob', 'B', f.token);
    const rotated = await consumeRefreshToken(f.tenant, refresh);
    await revokeToken(f.tenant, f.token);
    await f.send('refresh preserved');
    await sender.tick();
    assertEquals(calls, 1);
    assertEquals(await f.tenant.tx((tx) => tx.pushers.ofUser('bob')), []);
    const db = await f.store.server();
    assertEquals(await db.query('SELECT * FROM push_rejections'), []);
    assertEquals(await db.query('SELECT * FROM push_targets'), []);
    await setPusher(f.tenant, 'bob', rotated.accessToken, {
      app_id: 'app',
      pushkey: 'key',
      kind: 'http',
      app_display_name: 'App',
      device_display_name: 'B',
      lang: 'en',
      data: { url: 'https://push.test/_matrix/push/v1/notify' },
    });
    await projectTenant(f.store, 'test');
    await f.send('old generation');
    // Deliberately leave stale token/registration projection as a recovery case.
    await (await f.store.tenant('test')).execute(
      "UPDATE devices SET generation=generation+1 WHERE localpart='bob' AND device_id='B'",
    );
    await sender.tick();
    assertEquals(calls, 1);
    assertEquals(
      await db.query("SELECT * FROM push_delivery WHERE state='pending'"),
      [],
    );
  } finally {
    await sender.stop();
    await f.close();
  }
});

Deno.test('push sender: bounded parallelism scans through more identities than the active limit', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const full = new Promise<void>((resolve) => entered = resolve);
  let active = 0, peak = 0;
  const keys: string[] = [];
  const sender = await startPushSender({
    store: f.store,
    tenant: f.tenant,
    automatic: false,
    send: async (_url, payload) => {
      keys.push(
        String(
          (((payload as Json).notification as Json).devices as Json[])[0]
            .pushkey,
        ),
      );
      active++;
      peak = Math.max(peak, active);
      if (active === 8) entered();
      await gate;
      active--;
      return [];
    },
  });
  try {
    for (let i = 1; i < 10; i++) {
      await setPusher(f.tenant, 'bob', f.token, {
        app_id: 'app',
        pushkey: 'key' + i,
        kind: 'http',
        app_display_name: 'App',
        device_display_name: 'B',
        lang: 'en',
        data: { url: 'https://push.test/_matrix/push/v1/notify' },
      });
    }
    await projectTenant(f.store, 'test');
    await f.send('fanout');
    const first = sender.tick();
    await full;
    assertEquals(keys.length, 8);
    release();
    await first;
    for (let i = 0; i < 4 && keys.length < 10; i++) await sender.tick();
    assertEquals(peak, 8);
    assertEquals(new Set(keys).size, 10);
    assertEquals(keys.length, 10);
  } finally {
    release();
    await sender.stop();
    await f.close();
  }
});

Deno.test('push sender: jitter stays within one second and one hour for both event and badge retries', async () => {
  const f = await fixture();
  try {
    await f.send('retry bounds');
    const db = await f.store.server();
    const target =
      (await db.query('SELECT * FROM push_targets'))[0] as PushTarget;
    const now = Date.now();
    const work = await db.tx((tx) =>
      preparePushWork(tx, target, now, 86400000)
    );
    assert(work.event && work.badge);
    await db.tx((tx) => retryPushWork(tx, target, work, now, 0));
    for (const table of ['push_delivery', 'push_badges']) {
      assertEquals(
        (await db.query(`SELECT next_ms FROM ${table}`))[0].next_ms,
        now + 1000,
      );
    }
    work.event.attempts = 20;
    work.badge.attempts = 20;
    await db.tx((tx) => retryPushWork(tx, target, work, now, 1));
    for (const table of ['push_delivery', 'push_badges']) {
      assertEquals(
        (await db.query(`SELECT next_ms FROM ${table}`))[0].next_ms,
        now + 3600000,
      );
    }
  } finally {
    await f.close();
  }
});
