import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { openStore } from '#engine/store/index.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { closeApp, openApp } from '#engine/app.ts';
import { buildInTx } from '#engine/room/build.ts';
import { ingestInTx, sendLocal } from '#engine/room/ingest.ts';
import { completionService } from '#engine/server/completion.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import {
  completePublished,
  onProjected,
  publishThrough,
} from '#engine/server/project.ts';
import { dropOperatorRoom } from '#engine/room/operator.ts';
import { registerRoom } from '#engine/server/registry.ts';
import { auditSnapshot } from '#engine/backup/audit.ts';
import { createRoom } from '#engine/room/create.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { deviceIdentity, transactionSubmission } from '#engine/tenant/txns.ts';
import { genesis } from '#tests/fixtures/genesis.ts';
import { setConfigForTests } from '#engine/config.ts';

installServerHooks();
const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 16,
  idleseconds: 300,
});
function guard<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('completion boundary did not progress')),
        10000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

Deno.test('completion boundary: a shared older ready capture cannot replace the caller target', async () => {
  const root = await Deno.makeTempDir();
  const store = await openStore(config(root), {
    schemas: { room: roomSchema, server: serverSchema },
  });
  const ready = Promise.withResolvers<void>(),
    releaseReady = Promise.withResolvers<void>();
  const callback = Promise.withResolvers<void>(),
    releaseCallback = Promise.withResolvers<void>();
  let off = () => {}, restore = () => {}, helper: Promise<void> | undefined;
  try {
    const g = await genesis(store, { roomId: '!shared-ready-own-cut:test' });
    const committed = async (body: string) =>
      (await g.room.tx(async (tx) =>
        ingestInTx(
          tx,
          g.roomId,
          await buildInTx(tx, g.roomId, {
            type: 'm.room.message',
            sender: g.creator,
            content: { msgtype: 'm.text', body },
          }, g.signer),
          { self: g.signer.serverName },
        )
      )).completion!;
    const first = await committed('older shared ready capture');
    const transaction = g.room.tx.bind(g.room);
    let captured = false;
    g.room.tx = async (fn) => {
      let selected = false;
      const result = await transaction((tx) => {
        const capture = tx.completion.capture.bind(tx.completion);
        tx.completion.capture = async () => {
          const cut = await capture();
          if (!captured) {
            captured = true;
            selected = true;
          }
          return cut;
        };
        return fn(tx);
      });
      if (selected) {
        ready.resolve();
        await releaseReady.promise;
      }
      return result;
    };
    restore = () => {
      g.room.tx = transaction;
    };
    const owner = completionService(store);
    owner.enroll(g.room, g.signer.serverName, first);
    await guard(ready.promise);
    const own = await committed('the concurrent caller owns this newer cut');
    assert(own.through > first.through);
    off = onProjected(async (_store, roomId, through) => {
      if (roomId === g.roomId && through === own.through) {
        callback.resolve();
        await releaseCallback.promise;
      }
    });
    const awaited = Promise.withResolvers<number>();
    const wait = owner.wait.bind(owner);
    owner.wait = async (...args) => {
      awaited.resolve(args[0].through);
      return await wait(...args);
    };
    let returned = false;
    helper = owner.complete(g.room, g.signer.serverName, own).then(() => {
      returned = true;
    });
    releaseReady.resolve();
    await guard(callback.promise);
    assertEquals(
      await guard(awaited.promise),
      own.through,
      'helper substituted the older shared ready cut',
    );
    assertEquals(
      returned,
      false,
      'helper completed while its own callback was held',
    );
    releaseCallback.resolve();
    await guard(helper);
    assert(
      (await g.room.tx((tx) => tx.completion.state())).completedThrough >=
        own.through,
    );
  } finally {
    releaseReady.resolve();
    releaseCallback.resolve();
    off();
    restore();
    await helper?.catch(() => {});
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('completion boundary: intentional retirement preserves audited receipts across room ID reuse', async (t) => {
  // genesis() signs for test; the reused room ID must have that same domain.
  setConfigForTests({ server: { name: 'test' } });
  const root = await Deno.makeTempDir();
  const settings = config(join(root, 'live'));
  const app = await openApp(settings);
  const { store, tenant } = app;
  try {
    const alice = await registerUser(tenant, {
      localpart: 'retired-receipt',
      password: 'pw',
    });
    const device = await deviceIdentity(
      tenant,
      'retired-receipt',
      alice.device_id!,
    );
    const created = await createRoom(store, {
      creator: alice.user_id,
      preset: 'public_chat',
    }, tenant.signer());
    const room = await openRoom(store, created.roomId);
    await registerRoom(store, room.id);
    const result = await sendLocal(
      room,
      {
        type: 'm.room.message',
        sender: alice.user_id,
        content: { msgtype: 'm.text', body: 'historical receipt' },
      },
      tenant.signer(),
      transactionSubmission(tenant, device, {
        kind: 'send',
        roomId: room.id,
        eventType: 'm.room.message',
      }, 'retired-receipt'),
    );
    await completionService(store).complete(
      room,
      tenant.serverName,
      result.completion!,
    );
    const db = await store.tenant(tenant.serverName);
    let serial = 0;
    const audit = async () => {
      const destination = join(root, 'snapshot-' + ++serial);
      const cut = await store.snapshot(destination);
      return await auditSnapshot(
        settings,
        destination,
        cut.files,
        tenant.serverName,
        root,
      );
    };
    await audit();
    await dropOperatorRoom(app, room.id);
    await audit();
    const replacement = await genesis(store, { roomId: room.id });
    await registerRoom(store, room.id);
    const generation = await replacement.room.tx((tx) =>
      tx.completion.capture()
    );
    assert(generation.generation !== result.completion!.generation);
    await completionService(store).complete(
      replacement.room,
      tenant.serverName,
      generation,
    );
    await t.step(
      'old exact receipt remains valid beside the replacement incarnation',
      async () => {
        await audit();
      },
    );
    assertEquals(
      (await db.query(
        'SELECT event_id FROM transaction_completions WHERE txn_id=?',
        ['retired-receipt'],
      ))[0].event_id,
      result.eventId,
    );
    assertEquals(await tenant.tx((tx) => tx.completion.pending(device)), []);
    await t.step(
      'a missing retirement witness is corruption, not another historical exception',
      async () => {
        await db.execute(
          'UPDATE transaction_completions SET retired=0 WHERE txn_id=?',
          ['retired-receipt'],
        );
        await assertRejects(audit, Error, 'completion');
        await db.execute(
          'UPDATE transaction_completions SET retired=1 WHERE txn_id=?',
          ['retired-receipt'],
        );
        await audit();
      },
    );
  } finally {
    await closeApp();
    setConfigForTests({});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('completion boundary: concurrent callback consumers share one durable witness', async () => {
  const root = await Deno.makeTempDir();
  const store = await openStore(config(root), {
    schemas: { room: roomSchema, server: serverSchema },
  });
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let off = () => {};
  const jobs: Promise<void>[] = [];
  try {
    const g = await genesis(store, { roomId: '!callback-witness:test' });
    const target = (await g.room.tx(async (tx) =>
      ingestInTx(
        tx,
        g.roomId,
        await buildInTx(tx, g.roomId, {
          type: 'm.room.message',
          sender: g.creator,
          content: { msgtype: 'm.text', body: 'one callback obligation' },
        }, g.signer),
        { self: g.signer.serverName },
      )
    )).completion!;
    await publishThrough(store, target, async () => {});
    let observed = 0;
    off = onProjected(async (owner, roomId) => {
      if (owner === store && roomId === g.roomId) {
        observed++;
        entered.resolve();
        await release.promise;
      }
    });
    const first = completePublished(store, target);
    jobs.push(first);
    await guard(entered.promise);
    await guard(assertRejects(
      () => completePublished(store, { ...target, eventId: '$absent' }),
      Error,
      'E_COMPLETION_TARGET',
    ));
    const second = completePublished(store, target);
    jobs.push(second);
    release.resolve();
    await guard(Promise.all(jobs));
    assertEquals(
      observed,
      1,
      'concurrent callback consumers acquired duplicate owners',
    );
    await completePublished(store, target);
    assertEquals(observed, 1, 'completed callback witness was replayed');
  } finally {
    release.resolve();
    await Promise.allSettled(jobs);
    off();
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});
