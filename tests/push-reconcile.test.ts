import { assertEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import type { Pdu } from '#engine/pdu.ts';
import { openStore } from '#engine/store/index.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { ingestInTx, redactEvent } from '#engine/room/ingest.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { verify } from '#engine/room/verify.ts';
import { backfill } from '#engine/room/history.ts';
import { project } from '#engine/server/project.ts';
import { setReceipt } from '#engine/server/ephemeral.ts';
import {
  notificationSnapshot,
  syncNotificationCounts,
} from '#engine/server/notifications.ts';
import { relationsOf, threadOfEvent } from '#engine/server/read.ts';
import { fakeFetcher, fakeKeyResolver } from '#tests/fixtures/remote.ts';
import { fakeMessage, makeFakeRoom } from '#tests/fixtures/remote-room.ts';
import { testRemoteServer, testSigner } from '#tests/fixtures/signer.ts';

Deno.test('push reconciliation: a history parent moves only existing live decisions; redaction reapplies horizons and survives reopen', async () => {
  setConfigForTests({ push: { readretentiondays: 0 } });
  const dir = await Deno.makeTempDir();
  const config = {
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
  let store = await openStore(config, { schemas });
  try {
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx((tx) => tx.users.insert('bob', 'Bob'));
    const fr = await makeFakeRoom({
      roomId: '!reconcile:test',
      server: await testRemoteServer(),
    });
    await fr.addEvent({
      type: 'm.room.member',
      state_key: '@bob:test',
      content: { membership: 'invite' },
    });
    await fr.addEvent({
      type: 'm.room.member',
      sender: '@bob:test',
      state_key: '@bob:test',
      content: { membership: 'join' },
    });
    const initial = [...fr.events.values()];
    const root = await fakeMessage(fr, 'root');
    const parent = await fr.addEvent({
      type: 'm.room.message',
      content: {
        body: 'historical parent',
        'm.relates_to': { rel_type: 'm.thread', event_id: root.event_id },
      },
    });
    const gap = await fakeMessage(fr, 'gap boundary');
    const child = await fr.addEvent({
      type: 'm.room.message',
      content: {
        body: 'live child',
        'm.mentions': { user_ids: ['@bob:test'] },
        'm.relates_to': { rel_type: 'm.annotation', event_id: parent.event_id },
      },
    });
    const room = await openRoom(store, fr.roomId, { create: true });
    const keys = fakeKeyResolver(fr.server);
    const create = await verify(initial[0], fr.version, keys, {
      roomId: fr.roomId,
    });
    await room.tx(async (tx) => {
      const empty = await tx.materialize.newGroup(null, []);
      await tx.segments.create({ kind: 'stay', opening_group: empty });
      await ingestInTx(tx, fr.roomId, create.pdu, {
        remote: {
          origin: fr.server.name,
          self: 'test',
          oversized: create.oversized,
          ungroundedMs: 3600000,
        },
      });
    });
    const deps = {
      keys,
      self: 'test',
      limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
      ungroundedMs: 3600000,
      fetcher: fakeFetcher({}).fetcher,
    };
    await ingestRemote(room, [...initial.slice(1), root], fr.server.name, deps);
    deps.fetcher = fakeFetcher({
      missingEvents: [],
      stateIds: new Map([[gap.event_id!, fr.stateIdsAt(gap.event_id!)!]]),
      event: new Map(
        [...fr.events.entries()].map(([id, pdu]) => [id, pdu] as [string, Pdu]),
      ),
    }).fetcher;
    assertEquals(
      (await ingestRemote(room, [child], fr.server.name, deps))[0].outcome,
      'accepted',
    );
    await project(store, fr.roomId);
    let db = await store.server();
    const counts = () =>
      db.tx(async (tx) =>
        syncNotificationCounts(
          (await notificationSnapshot(tx, '@bob:test', 0)).rooms.get(fr.roomId),
          true,
        )
      );
    const c = (n: number, h = 0) => ({
      notification_count: n,
      highlight_count: h,
    });
    assertEquals(await counts(), {
      unread_notifications: c(3, 1),
    });
    const live = await db.query('SELECT event,seq FROM feed ORDER BY seq');
    const decisions = await db.query(
      'SELECT * FROM push_evaluations ORDER BY event',
    );
    // The thread-related receipt for the root is valid, but cannot read a child
    // beyond the root's live order. The later main receipt initially reads it.
    await setReceipt(
      db,
      fr.roomId,
      '@bob:test',
      'm.read.private',
      root.event_id!,
      { threadId: root.event_id! },
    );
    await setReceipt(db, fr.roomId, '@bob:test', 'm.read', child.event_id!, {
      threadId: 'main',
    });
    assertEquals(await counts(), {
      unread_notifications: c(0),
    });
    assertEquals(
      await db.query(
        'SELECT 1 FROM notification_history WHERE seq IN (SELECT seq FROM notifications WHERE user=? AND event=?)',
        ['@bob:test', child.event_id!],
      ),
      [],
    );
    deps.fetcher = fakeFetcher({
      backfill: (from, limit) => fr.backfillPdus(from, limit),
    }).fetcher;
    await backfill(room, {
      from: [parent.event_id!],
      limit: 5,
      via: fr.server.name,
    }, deps);
    await project(store, fr.roomId);
    assertEquals(
      await threadOfEvent(db, fr.roomId, child.event_id!),
      root.event_id,
    );
    assertEquals(await counts(), {
      unread_notifications: c(0),
      unread_thread_notifications: { [root.event_id!]: c(1, 1) },
    });
    assertEquals(
      (await db.query(
        'SELECT 1 FROM notification_history WHERE seq IN (SELECT seq FROM notifications WHERE user=? AND event=?)',
        ['@bob:test', child.event_id!],
      )).length,
      1,
    );
    assertEquals(
      (await relationsOf(db, fr.roomId, root.event_id!)).length,
      0,
      'history edge is not a live relation listing',
    );
    assertEquals(
      await db.query('SELECT event,seq FROM feed ORDER BY seq'),
      live,
    );
    assertEquals(
      await db.query('SELECT * FROM push_evaluations ORDER BY event'),
      decisions,
    );
    assertEquals(
      (await db.query('SELECT COUNT(*) AS n FROM notifications WHERE event=?', [
        parent.event_id!,
      ]))[0].n,
      0,
    );
    // Redacting the intermediate relation returns the child to main, where the
    // existing farther main horizon reads it. No new evaluation or historical alert.
    await redactEvent(room, fr.creator, parent.event_id!, await testSigner());
    await project(store, fr.roomId);
    assertEquals(await counts(), {
      unread_notifications: c(0),
    });
    assertEquals(await threadOfEvent(db, fr.roomId, child.event_id!), 'main');
    assertEquals(
      await db.query(
        'SELECT 1 FROM notification_history WHERE seq IN (SELECT seq FROM notifications WHERE user=? AND event=?)',
        ['@bob:test', child.event_id!],
      ),
      [],
    );
    await store.close();
    store = await openStore(config, { schemas });
    db = await store.server();
    await project(store, fr.roomId);
    assertEquals(await counts(), {
      unread_notifications: c(0),
    });
    assertEquals(
      (await db.query(
        'SELECT read_ms IS NOT NULL AS read FROM notifications WHERE event=?',
        [child.event_id!],
      ))[0].read,
      1,
    );
  } finally {
    setConfigForTests({});
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('push reconciliation: a late live parent reclassifies an own send and advances only its resolved bucket', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, {
    schemas: { room: roomSchema, tenant: tenantSchema, server: serverSchema },
  });
  try {
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx((tx) => tx.users.insert('bob', 'Bob'));
    const fr = await makeFakeRoom({
      roomId: '!late-own:test',
      server: await testRemoteServer(),
    });
    await fr.addEvent({
      type: 'm.room.member',
      state_key: '@bob:test',
      content: { membership: 'invite' },
    });
    await fr.addEvent({
      type: 'm.room.member',
      sender: '@bob:test',
      state_key: '@bob:test',
      content: { membership: 'join' },
    });
    const root = await fakeMessage(fr, 'root');
    const prior = await fr.addEvent({
      type: 'm.room.message',
      content: {
        body: 'prior',
        'm.relates_to': { rel_type: 'm.thread', event_id: root.event_id },
      },
    });
    const initial = [...fr.events.values()];
    const parent = await fr.addEvent({
      type: 'm.room.message',
      content: {
        body: 'late parent',
        'm.relates_to': { rel_type: 'm.thread', event_id: root.event_id },
      },
    });
    const own = await fr.addEvent({
      type: 'm.room.message',
      sender: '@bob:test',
      prev_events: [prior.event_id!],
      content: {
        body: 'own',
        'm.relates_to': { rel_type: 'm.annotation', event_id: parent.event_id },
      },
    });
    const room = await openRoom(store, fr.roomId, { create: true });
    const keys = fakeKeyResolver(fr.server);
    const create = await verify(initial[0], fr.version, keys, {
      roomId: fr.roomId,
    });
    await room.tx(async (tx) => {
      const empty = await tx.materialize.newGroup(null, []);
      await tx.segments.create({ kind: 'stay', opening_group: empty });
      await ingestInTx(tx, fr.roomId, create.pdu, {
        remote: {
          origin: fr.server.name,
          self: 'test',
          oversized: create.oversized,
          ungroundedMs: 3600000,
        },
      });
    });
    const deps = {
      keys,
      self: 'test',
      limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
      ungroundedMs: 3600000,
      fetcher: fakeFetcher({}).fetcher,
    };
    await ingestRemote(room, [...initial.slice(1), own], fr.server.name, deps);
    await project(store, fr.roomId);
    const db = await store.server();
    const counts = () =>
      db.tx(async (tx) =>
        syncNotificationCounts(
          (await notificationSnapshot(tx, '@bob:test', 0)).rooms.get(fr.roomId),
          true,
        )
      );
    const c = (n: number) => ({ notification_count: n, highlight_count: 0 });
    assertEquals(await counts(), {
      unread_notifications: c(0),
      unread_thread_notifications: { [root.event_id!]: c(1) },
    });
    await ingestRemote(room, [parent], fr.server.name, deps);
    await project(store, fr.roomId);
    assertEquals(
      await threadOfEvent(db, fr.roomId, own.event_id!),
      root.event_id,
    );
    // The parent publishes later than the own event. It remains unread while
    // the earlier thread event is cleared by the reclassified own-send horizon.
    assertEquals(await counts(), {
      unread_notifications: c(0),
      unread_thread_notifications: { [root.event_id!]: c(1) },
    });
    assertEquals(
      (await db.query(
        'SELECT read_ms IS NOT NULL AS read FROM notifications WHERE user=? AND event=?',
        ['@bob:test', prior.event_id!],
      ))[0].read,
      1,
    );
    assertEquals(
      (await db.query(
        'SELECT read_ms IS NOT NULL AS read FROM notifications WHERE user=? AND event=?',
        ['@bob:test', parent.event_id!],
      ))[0].read,
      0,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
