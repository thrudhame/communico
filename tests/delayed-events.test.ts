import { assert, assertEquals, assertRejects } from '@std/assert';
import { closeApp, openApp } from '#engine/app.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { DelayedEvents } from '#engine/delayed-events.ts';
import { createRoom, writeStateKey } from '#engine/client/write.ts';
import { join as joinRoom } from '#engine/client/membership.ts';
import { deactivateUser, registerUser } from '#engine/tenant/users.ts';
import { openRoom } from '#engine/room/index.ts';
import { readStateKey } from '#engine/client/state.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { openStore } from '#engine/store/index.ts';
import { tenantSchema } from '#engine/tenant/index.ts';

async function setup(name: string) {
  const dir = await Deno.makeTempDir({ prefix: 'delayed-' });
  const storage = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  setConfigForTests({ delayedevents: { maxdelayms: 60000 } });
  const app = await openApp(storage);
  await app.delayedEvents.stop(); // Explicit deterministic driver, no live timer.
  const a = await registerUser(app.tenant, { localpart: name, password: 'pw' });
  const room = await createRoom({ creator: a.user_id });
  const user = a.user_id;
  return {
    dir,
    storage,
    app,
    user,
    room: room.roomId,
    cleanup: async () => {
      await closeApp();
      setConfigForTests({});
      await Deno.remove(dir, { recursive: true });
    },
  };
}
function schedule(
  room: string,
  userId: string,
  key = 'key',
  content: Record<string, unknown> = { value: 'later' },
) {
  return {
    roomId: room,
    userId,
    type: 'test.delayed',
    stateKey: key,
    content,
    delay: 60000,
    deviceId: null,
  };
}
Deno.test('delayed: persisted schedule/restart/cancel and overdue startup delivery', async () => {
  const f = await setup('delay-reopen');
  try {
    const worker = new DelayedEvents(f.app);
    const { delay_id: id } = await worker.schedule(schedule(f.room, f.user));
    await worker.stop();
    await closeApp();
    const app = await openApp(f.storage);
    await app.delayedEvents.stop();
    const restored = new DelayedEvents(app);
    const before = await app.tenant.tx((tx) => tx.delayedEvents.get(id));
    assert(before);
    assertEquals(before.content, { value: 'later' });
    await restored.action(id, 'restart');
    const after = await app.tenant.tx((tx) => tx.delayedEvents.get(id));
    assert(after);
    assert(after.since >= before.since);
    assertEquals(after.due - after.since, 60000);
    await app.tenant.tx((tx) =>
      tx.delayedEvents.action(id, 'send', Date.now() - 1)
    );
    await restored.stop();
    await closeApp();
    const startup = await openApp(f.storage);
    const deadline = Date.now() + 5000;
    while (
      await startup.tenant.tx((tx) => tx.delayedEvents.get(id)) &&
      Date.now() < deadline
    ) await new Promise((r) => setTimeout(r, 20));
    assertEquals(
      await readStateKey(f.room, f.user, 'test.delayed', 'key', null),
      { value: 'later' },
    );
    assertEquals(
      await startup.tenant.tx((tx) => tx.delayedEvents.get(id)),
      null,
    );
  } finally {
    await f.cleanup();
  }
});
Deno.test('delayed: other-sender publication cancels, own update preserves the leave', async () => {
  const f = await setup('delay-owner');
  const worker = new DelayedEvents(f.app);
  try {
    const b = await registerUser(f.app.tenant, {
      localpart: 'delay-foreign',
      password: 'pw',
    });
    // Public join rules and explicit state power permit the second sender.
    await writeStateKey(f.room, f.user, 'm.room.join_rules', '', {
      join_rule: 'public',
    });
    await joinRoom(f.room, b.user_id);
    await writeStateKey(f.room, f.user, 'm.room.power_levels', '', {
      users: { [f.user]: 100, [b.user_id]: 100 },
      state_default: 0,
    });
    await writeStateKey(f.room, f.user, 'test.delayed', 'key', { old: true });
    const first = await worker.schedule(schedule(f.room, f.user));
    await writeStateKey(f.room, b.user_id, 'test.delayed', 'key', {
      foreign: true,
    });
    await writeStateKey(f.room, f.user, 'test.delayed', 'key', { own: true });
    assertEquals(await worker.list(f.user), { delayed_events: [] });
    await assertRejects(
      () => worker.action(first.delay_id, 'send'),
      MatrixError,
      'M_NOT_FOUND',
    );
    const second = await worker.schedule(schedule(f.room, f.user, 'own', {}));
    await writeStateKey(f.room, f.user, 'test.delayed', 'own', {
      active: true,
    });
    await worker.action(second.delay_id, 'send');
    assertEquals(
      await readStateKey(f.room, f.user, 'test.delayed', 'own', null),
      {},
    );
  } finally {
    await worker.stop();
    await f.cleanup();
  }
});
Deno.test('delayed: current authorization and encryption policy apply at delivery', async () => {
  const f = await setup('delay-auth');
  const worker = new DelayedEvents(f.app);
  try {
    await writeStateKey(f.room, f.user, 'm.room.join_rules', '', {
      join_rule: 'public',
    });
    const first = await worker.schedule(schedule(f.room, f.user));
    await writeStateKey(f.room, f.user, 'm.room.member', f.user, {
      membership: 'leave',
    });
    await assertRejects(
      () => worker.action(first.delay_id, 'send'),
      MatrixError,
    );
    assertEquals(
      await f.app.tenant.tx((tx) => tx.delayedEvents.get(first.delay_id)),
      null,
    );
    await joinRoom(f.room, f.user);
    const second = await worker.schedule({
      ...schedule(f.room, f.user),
      stateKey: null,
      type: 'm.room.message',
      content: { body: 'must not leak', msgtype: 'm.text' },
    });
    await writeStateKey(f.room, f.user, 'm.room.encryption', '', {
      algorithm: 'm.megolm.v1.aes-sha2',
    });
    setConfigForTests({
      delayedevents: { maxdelayms: 60000 },
      encryption: { allowunencryptedmessages: false },
    });
    await assertRejects(
      () => worker.action(second.delay_id, 'send'),
      MatrixError,
    );
    assertEquals(
      await f.app.tenant.tx((tx) => tx.delayedEvents.get(second.delay_id)),
      null,
    );
  } finally {
    await worker.stop();
    await f.cleanup();
  }
});
Deno.test('delayed: crash after room commit replays exact signed receipt once', async () => {
  const f = await setup('delay-receipt');
  let fail = true;
  const worker = new DelayedEvents({
    store: f.app.store,
    tenant: {
      ...f.app.tenant,
      tx: (fn) =>
        f.app.tenant.tx((tx) =>
          fn({
            ...tx,
            delayedEvents: {
              ...tx.delayedEvents,
              finish: async (id: string) => {
                if (fail) {
                  fail = false;
                  throw new Error('simulated receipt gap');
                }
                await tx.delayedEvents.finish(id);
              },
            },
          })
        ),
    },
  });
  try {
    const { delay_id: id } = await worker.schedule({
      ...schedule(f.room, f.user),
      stateKey: null,
      type: 'm.room.encrypted',
      content: { algorithm: 'test', ciphertext: 'once' },
    });
    await assertRejects(
      () => worker.action(id, 'send'),
      Error,
      'simulated receipt gap',
    );
    const pending = await f.app.tenant.tx((tx) =>
      tx.delayedEvents.submission(id)
    );
    assert(pending?.pdu);
    const room = await openRoom(f.app.store, f.room);
    const firstHead = await room.tx((tx) => tx.changes.head());
    await worker.stop();
    await closeApp();
    const app = await openApp(f.storage);
    const deadline = Date.now() + 5000;
    while (
      await app.tenant.tx((tx) => tx.delayedEvents.get(id)) &&
      Date.now() < deadline
    ) await new Promise((r) => setTimeout(r, 20));
    const replayRoom = await openRoom(app.store, f.room);
    assertEquals(await replayRoom.tx((tx) => tx.changes.head()), firstHead);
    assertEquals(await app.tenant.tx((tx) => tx.delayedEvents.get(id)), null);
  } finally {
    await worker.stop();
    await f.cleanup();
  }
});
Deno.test('delayed: inactive accounts retire pending commands', async () => {
  const f = await setup('delay-deactivated');
  const worker = new DelayedEvents(f.app);
  try {
    const { delay_id: id } = await worker.schedule(schedule(f.room, f.user));
    await deactivateUser(f.app.tenant, 'delay-deactivated');
    assertEquals(await f.app.tenant.tx((tx) => tx.delayedEvents.get(id)), null);
  } finally {
    await worker.stop();
    await f.cleanup();
  }
});
Deno.test('delayed: v19 upgrade keeps credentials and adds empty scheduling owner', async () => {
  const dir = await Deno.makeTempDir();
  const storage = {
    ...config().store,
    dir,
    library: './.native/libturso_ffi.so',
  };
  let store = await openStore(storage, {
    schemas: {
      tenant: {
        version: 19,
        apply: async (db) => {
          await tenantSchema.apply(db);
          await db.exec(
            'DROP TABLE delayed_events;DROP TABLE delayed_event_receipts',
          );
        },
      },
    },
  });
  try {
    const db = await store.tenant('upgrade-delay.test', { create: true });
    await db.exec("INSERT INTO users(localpart) VALUES('kept')");
    await store.close();
    store = await openStore(storage, { schemas: { tenant: tenantSchema } });
    const upgraded = await store.tenant('upgrade-delay.test');
    assertEquals(await upgraded.query('SELECT localpart FROM users'), [{
      localpart: 'kept',
    }]);
    assertEquals(await upgraded.query('SELECT * FROM delayed_events'), []);
    assertEquals(
      (await upgraded.query("SELECT v FROM meta WHERE k='schema_version'"))[0]
        .v,
      String(tenantSchema.version),
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('delayed: a heartbeat restart fences a stale due-event selection', async () => {
  const f = await setup('delay-stale-due');
  const owner = new DelayedEvents(f.app);
  let raced: DelayedEvents | undefined;
  try {
    const { delay_id: id } = await owner.schedule(schedule(f.room, f.user));
    await owner.stop();
    await f.app.tenant.tx((tx) =>
      tx.delayedEvents.action(id, 'send', Date.now() - 1)
    );
    raced = new DelayedEvents({
      store: f.app.store,
      tenant: {
        ...f.app.tenant,
        tx: (fn) =>
          f.app.tenant.tx((tx) =>
            fn({
              ...tx,
              delayedEvents: {
                ...tx.delayedEvents,
                due: async (now: number) => {
                  const selected = await tx.delayedEvents.due(now);
                  for (const event of selected) {
                    await tx.delayedEvents.action(
                      event.id,
                      'restart',
                      Date.now(),
                    );
                  }
                  return selected;
                },
              },
            })
          ),
      },
    });
    await raced.drain();
    const pending = await f.app.tenant.tx((tx) => tx.delayedEvents.get(id));
    assert(
      pending,
      'a restarted command must not be sent from a stale selection',
    );
    assert(pending.due > Date.now());
    await assertRejects(
      () => readStateKey(f.room, f.user, 'test.delayed', 'key', null),
      MatrixError,
      'M_NOT_FOUND',
    );
  } finally {
    await raced?.stop();
    await owner.stop();
    await f.cleanup();
  }
});

Deno.test('delayed: disabling new scheduling still delivers previously durable work', async () => {
  const f = await setup('delay-config-off');
  const owner = new DelayedEvents(f.app);
  let delivery: DelayedEvents | undefined;
  try {
    const { delay_id: id } = await owner.schedule(schedule(f.room, f.user));
    await owner.stop();
    await f.app.tenant.tx((tx) =>
      tx.delayedEvents.action(id, 'send', Date.now() - 1)
    );
    setConfigForTests({ delayedevents: { maxdelayms: 0 } });
    delivery = new DelayedEvents(f.app);
    await delivery.drain();
    assertEquals(
      await readStateKey(f.room, f.user, 'test.delayed', 'key', null),
      { value: 'later' },
    );
    assertEquals(await f.app.tenant.tx((tx) => tx.delayedEvents.get(id)), null);
    await assertRejects(
      () => delivery!.schedule(schedule(f.room, f.user, 'new')),
      MatrixError,
      'disabled',
    );
  } finally {
    await delivery?.stop();
    await owner.stop();
    await f.cleanup();
  }
});
