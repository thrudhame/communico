import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore, type Store } from '#engine/store/index.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { buildInTx } from '#engine/room/build.ts';
import { ingestInTx } from '#engine/room/ingest.ts';
import { serverSchema } from '#engine/server/schema.ts';
import {
  CompletionFailure,
  completionService,
} from '#engine/server/completion.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import { onProjected, publishThrough } from '#engine/server/project.ts';
import { type Genesis, genesis } from '#tests/fixtures/genesis.ts';

installServerHooks();
const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});
const schemas = { room: roomSchema, server: serverSchema };
async function committed(g: Genesis, body: string) {
  return (await g.room.tx(async (tx) =>
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
}
async function withStore(fn: (store: Store) => Promise<void>) {
  const root = await Deno.makeTempDir();
  const store = await openStore(config(root), { schemas });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
}
function guard<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('completion test did not progress')),
        10000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

Deno.test('completion owner: callback failure is explicit, publication is independent, retry needs no arrival', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!owned-retry:test' });
    const target = await committed(g, 'one durable event');
    const retried = Promise.withResolvers<void>();
    let attempts = 0;
    const dispose = onProjected((owner, room, through) => {
      if (owner !== store || room !== g.roomId || through < target.through) {
        return;
      }
      if (++attempts === 1) throw new Error('required callback failed once');
      retried.resolve();
    });
    try {
      const owner = completionService(store);
      const failed = assertRejects(
        () => owner.wait(target, 'completion', undefined, g.signer.serverName),
        CompletionFailure,
      );
      await owner.wait(target, 'publication', undefined, g.signer.serverName);
      const error = await failed;
      assertEquals(error.phase, 'completion');
      await guard(retried.promise); // No new request or arrival starts the retry.
      await owner.wait(target, 'completion', undefined, g.signer.serverName);
      assertEquals(
        (await (await store.server()).query(
          'SELECT event FROM feed WHERE room=? AND event=?',
          [g.roomId, target.eventId],
        )).length,
        1,
      );
      assert(
        (await g.room.tx((tx) => tx.completion.state())).completedThrough >=
          target.through,
      );
    } finally {
      dispose();
    }
  });
});

Deno.test('completion owner: a smaller fixed callback cut progresses while a larger callback is held', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!owned-prefix:test' });
    const smaller = await committed(g, 'first');
    const larger = await committed(g, 'later');
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const dispose = onProjected(async (owner, room, through) => {
      if (owner === store && room === g.roomId && through === larger.through) {
        entered.resolve();
        await release.promise;
      }
    });
    const owner = completionService(store);
    const big = owner.wait(
      larger,
      'completion',
      undefined,
      g.signer.serverName,
    );
    try {
      await guard(entered.promise);
      await guard(
        owner.wait(smaller, 'completion', undefined, g.signer.serverName),
      );
      const state = await g.room.tx((tx) => tx.completion.state());
      assertEquals(state.completedThrough, smaller.through);
    } finally {
      release.resolve();
      await big;
      dispose();
    }
  });
});

Deno.test('completion owner: cancelling a waiter retains work and close keeps native storage until completion', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!owned-close:test' });
    const target = await committed(g, 'retained');
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const dispose = onProjected(async (owner, room, through) => {
      if (owner === store && room === g.roomId && through === target.through) {
        entered.resolve();
        await release.promise;
      }
    });
    const abort = new AbortController();
    const waiter = completionService(store).wait(
      target,
      'completion',
      abort.signal,
      g.signer.serverName,
    );
    void waiter.catch(() => {});
    let closing: Promise<void> | undefined;
    try {
      await guard(entered.promise);
      abort.abort(new Error('only this waiter'));
      await assertRejects(() => waiter, Error, 'only this waiter');
      let closed = false;
      closing = store.close().then(() => {
        closed = true;
      });
      await assertRejects(
        () => store.accept(() => Promise.resolve()),
        Error,
        'acceptance closed',
      );
      assertEquals(closed, false);
      assertEquals(
        (await g.room.tx((tx) => tx.events.get(target.eventId)))?.id,
        target.eventId,
      );
      release.resolve();
      await closing;
      assertEquals(closed, true);
    } finally {
      release.resolve();
      await closing;
      dispose();
    }
  });
});

Deno.test('completion owner: committed room with a lost wake rolls forward after reopen without a send', async () => {
  const root = await Deno.makeTempDir();
  let store = await openStore(config(root), { schemas });
  try {
    const g = await genesis(store, { roomId: '!owned-reopen:test' });
    const target = await committed(g, 'wake was lost');
    const published = await genesis(store, {
      roomId: '!owned-publication-gap:test',
    });
    const publishedTarget = await committed(
      published,
      'server committed, progress not recorded',
    );
    await publishThrough(store, publishedTarget, () => Promise.resolve());
    assert(
      (await published.room.tx((tx) => tx.completion.state()))
        .completedThrough < publishedTarget.through,
    );
    await store.close();
    store = await openStore(config(root), { schemas });
    // The schema-enabled store composition itself discovers lost obligations.
    const reopened = await openRoom(store, g.roomId);
    assert(
      (await reopened.tx((tx) => tx.completion.state())).completedThrough >=
        target.through,
    );
    const reopenedPublished = await openRoom(store, published.roomId);
    assert(
      (await reopenedPublished.tx((tx) => tx.completion.state()))
        .completedThrough >= publishedTarget.through,
    );
    const rows = await (await store.server()).query(
      'SELECT event FROM feed WHERE room=? AND event=?',
      [g.roomId, target.eventId],
    );
    assertEquals(rows, [{ event: target.eventId }]);
    await completionService(store).wait(
      target,
      'completion',
      undefined,
      g.signer.serverName,
    );
  } finally {
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('completion owner: invalid identity admission is an explicit unavailable failure', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!owned-fence:test' });
    const target = await committed(g, 'fenced');
    for (
      const invalid of [
        { ...target, generation: 'replaced-generation' },
        { ...target, roomId: '!missing:test' },
      ]
    ) {
      const failure = await assertRejects(
        () => completionService(store).wait(invalid, 'publication'),
        CompletionFailure,
      );
      assertEquals(failure.status, 503);
      assertEquals(failure.target, invalid);
    }
  });
});

Deno.test('completion owner: failure without a full waiter is observable and autonomously retried', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!owned-visible:test' });
    const target = await committed(g, 'no request owns this callback');
    const retried = Promise.withResolvers<void>();
    const logs: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => logs.push(args);
    let attempts = 0;
    const dispose = onProjected((owner, room) => {
      if (owner !== store || room !== g.roomId) return;
      if (++attempts === 1) throw new Error('unattended callback failure');
      retried.resolve();
    });
    try {
      completionService(store).enroll(g.room, g.signer.serverName, target);
      await guard(retried.promise);
      assert(
        logs.some((args) =>
          args.some((arg) =>
            arg instanceof CompletionFailure &&
            arg.target.roomId === g.roomId &&
            arg.target.through === target.through && arg.phase === 'completion'
          )
        ),
        'owner swallowed a failure without a full waiter',
      );
    } finally {
      console.error = original;
      dispose();
    }
  });
});
