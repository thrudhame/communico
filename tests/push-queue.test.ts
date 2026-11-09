import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { issueToken, revokeToken } from '#engine/tenant/auth.ts';
import { setPusher } from '#engine/tenant/pushers.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { project } from '#engine/server/project.ts';
import { bobJoins, genesis } from '#tests/fixtures/genesis.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import {
  advanceNotificationRead,
  applyPushPublication,
} from '#engine/server/notifications.ts';
import { badgeCount, queueBadge } from '#engine/server/push-queue.ts';
import { gatewayPayload } from '#engine/push/payload.ts';
import { setConfigForTests } from '#engine/config.ts';

Deno.test('push queue: a failed publication transaction cannot expose feed, count or gateway intent', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema } });
  try {
    const db = await store.server();
    const publish = (fail: boolean) =>
      db.tx(async (tx) => {
        await tx.execute(
          "INSERT INTO event_index(event,room,pos,standing,grounding,seq) VALUES('$event','!room:test',1,'accepted','grounded',1)",
        );
        await tx.execute(
          "INSERT INTO feed VALUES(1,'!room:test',1,'$event',1)",
        );
        await applyPushPublication(tx, '!room:test', '$event', 1, 1, {
          sender: '@alice:test',
          decisions: [{
            tenant: 'test',
            user: '@bob:test',
            ruleRevision: 4,
            ignoreRevision: 2,
            pusherIncarnations: ['target-incarnation'],
            decision: {
              kind: 'underride',
              ruleId: '.m.rule.message',
              notify: true,
              highlight: false,
              actions: ['notify'],
              tweaks: {},
            },
          }],
        }, Date.now());
        if (fail) throw new Error('abort publication');
      });
    await assertRejects(() => publish(true), Error, 'abort publication');
    for (
      const table of [
        'feed',
        'notifications',
        'push_delivery',
        'push_badges',
        'notification_counts',
      ]
    ) assertEquals(await db.query(`SELECT * FROM ${table}`), []);
    await publish(false);
    for (
      const table of [
        'feed',
        'notifications',
        'push_delivery',
        'push_badges',
        'notification_counts',
      ]
    ) assertEquals((await db.query(`SELECT * FROM ${table}`)).length, 1);
    await db.execute(
      "UPDATE push_badges SET expired_revision=revision,attempts=4,next_ms=9999999999999,created_ms=1,error='expired'",
    );
    await db.tx((tx) => queueBadge(tx, '@bob:test', 'target-incarnation'));
    const badge = (await db.query('SELECT * FROM push_badges'))[0];
    assert(Number(badge.revision) > Number(badge.expired_revision));
    assertEquals(
      badge.sent_revision,
      0,
      'expiry is not a false delivery acknowledgment',
    );
    assertEquals(badge.attempts, 0);
    assertEquals(badge.next_ms, 0);
    assert(
      Number(badge.created_ms) > 1,
      'a later badge has its own retry lifetime',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('push queue: publication queues saved decisions only for the registered incarnation, read retention is independent and replay is inert', async () => {
  const dir = await Deno.makeTempDir();
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: { room: roomSchema, tenant: tenantSchema, server: serverSchema },
  });
  setConfigForTests({ push: { readretentiondays: 0 } });
  try {
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('dev', 'Dev');
      await tx.users.insert('bob', 'Bob');
    });
    const token = await issueToken(tenant, 'bob', 'B');
    const g = await genesis(store, { roomId: '!push-queue:test' });
    await bobJoins(g);
    const send = (body: string) =>
      sendLocal(g.room, {
        type: 'm.room.message',
        sender: g.creator,
        content: { body, msgtype: 'm.text' },
      }, g.signer);
    await send('before registration');
    await project(store, g.roomId);
    let db = await store.server();
    assertEquals(await db.query('SELECT * FROM push_delivery'), []);
    await setPusher(tenant, 'bob', token, {
      app_id: 'app',
      pushkey: 'key',
      kind: 'http',
      app_display_name: 'App',
      device_display_name: 'B',
      lang: 'en',
      data: { url: 'https://push.test/_matrix/push/v1/notify' },
    });
    await projectTenant(store, 'test');
    assertEquals(
      await db.query('SELECT * FROM push_delivery'),
      [],
      'registration sends no historical alert',
    );
    const event = await send('after registration');
    await project(store, g.roomId);
    const queued = await db.query('SELECT * FROM push_delivery');
    assertEquals(queued.length, 1);
    assertEquals(queued[0].event, event.eventId);
    assertEquals(await db.tx((tx) => badgeCount(tx, '@bob:test')), 2);
    await db.tx((tx) =>
      advanceNotificationRead(
        tx,
        '@bob:test',
        g.roomId,
        '',
        event.eventId,
        Date.now(),
      )
    );
    assertEquals(
      await db.query('SELECT * FROM notification_history WHERE user=?', [
        '@bob:test',
      ]),
      [],
    );
    assertEquals(
      (await db.query('SELECT state FROM push_delivery'))[0].state,
      'pending',
    );
    assertEquals(await db.tx((tx) => badgeCount(tx, '@bob:test')), 0);
    const dirty = (await db.query('SELECT revision FROM push_badges'))[0];
    assert(Number(dirty.revision) > 0);
    await project(store, g.roomId);
    assertEquals((await db.query('SELECT * FROM push_delivery')).length, 1);
    const facts = await db.query(
      'SELECT * FROM notifications WHERE user=? ORDER BY seq',
      ['@bob:test'],
    );
    assertEquals(
      facts.length,
      3,
      'saved invitation plus both message decisions',
    );
    await store.close();
    store = await openStore(options, {
      schemas: { room: roomSchema, tenant: tenantSchema, server: serverSchema },
    });
    db = await store.server();
    assertEquals((await db.query('SELECT * FROM push_delivery')).length, 1);
    const reopened = await openTenant(store, 'test');
    await revokeToken(reopened, token);
    await projectTenant(store, 'test');
    assertEquals(
      (await db.query('SELECT state FROM push_delivery'))[0].state,
      'cancelled',
    );
    assertEquals(await db.query('SELECT * FROM push_badges'), []);
    assertEquals(
      await db.query('SELECT * FROM notifications WHERE user=? ORDER BY seq', [
        '@bob:test',
      ]),
      facts,
    );
  } finally {
    setConfigForTests({});
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('push payload: explicit minimal, rich ciphertext/plaintext, saved tweaks, custom data and zero badges', () => {
  const target = {
    user: '@bob:test',
    app_id: 'app',
    pushkey: 'routing-key',
    payload: JSON.stringify({
      added_ms: 1700000123456,
      data: {
        url: 'https://push.test/_matrix/push/v1/notify',
        format: 'event_id_only',
        custom: { x: 1 },
      },
    }),
  };
  const event = {
    event_id: '$event',
    room_id: '!room:test',
    type: 'm.room.encrypted',
    sender: '@alice:test',
    content: { ciphertext: 'opaque', algorithm: 'm.megolm.v1.aes-sha2' },
  };
  const minimal = gatewayPayload(target, 3, event, ['notify', {
    set_tweak: 'sound',
    value: 'default',
  }]);
  assertEquals(minimal, {
    notification: {
      event_id: '$event',
      room_id: '!room:test',
      prio: 'high',
      counts: { unread: 3 },
      devices: [{
        app_id: 'app',
        pushkey: 'routing-key',
        pushkey_ts: 1700000123,
        data: { format: 'event_id_only', custom: { x: 1 } },
      }],
    },
  });
  const rich = {
    ...target,
    payload: JSON.stringify({
      added_ms: 1700000123456,
      data: { url: 'https://push.test/_matrix/push/v1/notify', custom: 7 },
    }),
  };
  const encrypted =
    gatewayPayload(rich, 1, event, ['notify', { set_tweak: 'highlight' }])
      .notification;
  assertEquals(encrypted.content, event.content);
  assertEquals(encrypted.sender, '@alice:test');
  assertEquals(encrypted.devices[0].tweaks, { highlight: true });
  const plain = gatewayPayload(rich, 2, {
    ...event,
    type: 'm.room.message',
    content: { body: 'visible plaintext' },
  }, ['notify']).notification;
  assertEquals(plain.content, { body: 'visible plaintext' });
  assertEquals(plain.prio, 'low');
  const badge = gatewayPayload(rich, 0, null, []).notification;
  assertEquals(Object.keys(badge).sort(), ['counts', 'devices']);
  assertEquals(badge.counts, { unread: 0 });
  assertEquals(badge.devices[0].data, { custom: 7 });
});

Deno.test('push badge: joined main/thread totals plus authoritative held/OOB invites once, excluding left rooms', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema } });
  try {
    const db = await store.server();
    await db.tx(async (tx) => {
      for (
        const [room, membership] of [['joined', 'join'], ['left', 'leave'], [
          'invite',
          'invite',
        ]]
      ) {
        await tx.execute('INSERT INTO memberships VALUES(?,?,?,?,1)', [
          '@bob:test',
          room,
          membership,
          '$' + room,
        ]);
      }
      for (
        const [room, thread, unread] of [
          ['joined', 'main', 2],
          ['joined', '$root', 3],
          ['left', 'main', 10],
          ['invite', 'main', 1],
        ] as const
      ) {
        await tx.execute('INSERT INTO notification_counts VALUES(?,?,?,?,0)', [
          '@bob:test',
          room,
          thread,
          unread,
        ]);
      }
      for (const room of ['invite', 'oob']) {
        await tx.execute(
          "INSERT INTO federation_invites VALUES(?,?,'$invite','10','{}','[]','remote',1,'pending',1)",
          [room, '@bob:test'],
        );
      }
    });
    assertEquals(await db.tx((tx) => badgeCount(tx, '@bob:test')), 7);
    await db.execute(
      "UPDATE federation_invites SET status='rejecting' WHERE room_id='invite'",
    );
    assertEquals(await db.tx((tx) => badgeCount(tx, '@bob:test')), 6);
    // OOB remains the authoritative membership until its owner marks it joined,
    // matching sync's selection even in the intermediate held-join window.
    await db.execute(
      "INSERT INTO memberships VALUES('@bob:test','oob','join','$join',2)",
    );
    await db.execute(
      "INSERT INTO notification_counts VALUES('@bob:test','oob','main',4,0)",
    );
    assertEquals(await db.tx((tx) => badgeCount(tx, '@bob:test')), 6);
    await db.execute(
      "UPDATE federation_invites SET status='joined' WHERE room_id='oob'",
    );
    assertEquals(await db.tx((tx) => badgeCount(tx, '@bob:test')), 9);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
