import { assertEquals } from '@std/assert';
import { openStore, type Store } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import {
  completePublished,
  onProjected,
  project,
  projectThrough,
  publishThrough,
} from '#engine/server/project.ts';
import { waitForSync } from '#engine/sync-wait.ts';
import { genesis } from './fixtures/genesis.ts';

async function fixture(run: (store: Store, roomId: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: 'projection-pass-hints-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, {
    schemas: { room: roomSchema, server: serverSchema, tenant: tenantSchema },
  });
  try {
    await openTenant(store, 'test', { create: true });
    const { roomId } = await genesis(store, { roomId: '!pass-hints:test' });
    await project(store, roomId);
    await run(store, roomId);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('projection pass: late subscribers receive repeated no-op hints without repeating durable completion', async () => {
  await fixture(async (store, roomId) => {
    const room = await store.room(roomId);
    const [before] = await room.query('SELECT * FROM completion_state');
    const target = {
      roomId,
      generation: String(before.generation),
      through: Number(before.completed_through),
    };
    const seen: number[] = [];
    const remove = onProjected((_store, _room, through) => {
      seen.push(through);
    });
    try {
      await completePublished(store, target);
      await projectThrough(store, target);
      assertEquals(seen, []);
      await project(store, roomId);
      await project(store, roomId);
      assertEquals(seen, [target.through, target.through]);
      await completePublished(store, target);
      assertEquals(seen.length, 2);
      assertEquals(
        (await room.query('SELECT * FROM completion_state'))[0],
        before,
      );
    } finally {
      remove();
    }
  });
});

Deno.test('projection pass: a no-op hint during capture survives until the real sync waiter recaptures', async () => {
  await fixture(async (store, roomId) => {
    const tenant = await openTenant(store, 'test');
    const server = await store.server();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const recaptured = Promise.withResolvers<void>();
    const abort = new AbortController();
    let relevant = false, calls = 0;
    const remove = onProjected(() => {
      relevant = true;
    });
    const timeout = globalThis.setTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiting: Promise<boolean> | undefined;
    try {
      // Suppress only the poll fallback armed synchronously before capture.
      // The five-second watchdog below detects deadlock, not product latency.
      globalThis.setTimeout = ((_callback: unknown, delay?: number) =>
        timeout(() => {}, delay)) as typeof timeout;
      waiting = waitForSync({ store, tenant, server }, {
        timeoutMs: 30000,
        signal: abort.signal,
      }, async () => {
        calls++;
        const snapshot = relevant;
        if (calls === 1) {
          entered.resolve();
          await release.promise;
        } else recaptured.resolve();
        return { relevant: snapshot, value: snapshot };
      });
    } finally {
      globalThis.setTimeout = timeout;
    }
    void waiting!.catch(() => {});
    try {
      await entered.promise;
      await project(store, roomId);
      release.resolve();
      await Promise.race([
        recaptured.promise,
        new Promise<never>((_resolve, reject) => {
          timer = timeout(
            () =>
              reject(new Error('lost no-op projection hint during capture')),
            5000,
          );
        }),
      ]);
      assertEquals(await waiting!, true);
      assertEquals(calls, 2);
      // A hint emitted before a new waiter arms needs no replay: initial capture
      // observes the relevant state instead of relying on a future notification.
      assertEquals(
        await waitForSync(
          { store, tenant, server },
          { timeoutMs: 0 },
          () => Promise.resolve({ relevant, value: relevant }),
        ),
        true,
      );
    } finally {
      clearTimeout(timer);
      release.resolve();
      abort.abort();
      await waiting!.catch(() => {});
      remove();
    }
  });
});

Deno.test('projection pass: a late hint listener does not join behind an already dispatched completion callback', async () => {
  await fixture(async (store) => {
    const { roomId } = await genesis(store, { roomId: '!pass-held:test' });
    const room = await openRoom(store, roomId);
    const target = await room.tx((tx) => tx.completion.capture());
    await publishThrough(store, target, () => Promise.resolve());
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const hinted = Promise.withResolvers<void>();
    const removeHeld = onProjected(async () => {
      entered.resolve();
      await release.promise;
    });
    const completion = completePublished(store, target);
    let removeLate = () => {};
    let repeated: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered.promise;
      removeLate = onProjected(() => {
        hinted.resolve();
      });
      repeated = project(store, roomId);
      // Deadlock watchdog only: an observer explicitly remains held throughout.
      await Promise.race([
        hinted.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('late hint joined an old held completion')),
            5000,
          );
        }),
      ]);
      assertEquals(
        (await room.tx((tx) => tx.completion.state())).completedThrough <
          target.through,
        true,
      );
    } finally {
      clearTimeout(timer);
      release.resolve();
      await completion;
      await repeated;
      removeLate();
      removeHeld();
    }
  });
});
