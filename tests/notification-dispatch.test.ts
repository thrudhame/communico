import { assertEquals } from '@std/assert';
import { openStore, type Store } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import {
  onProjected,
  project,
  withProjectionLock,
} from '#engine/server/project.ts';
import { eventStreamTx, onEventStream } from '#engine/server/stream.ts';
import {
  onTenantStream,
  tenantStreamCommitted,
} from '#engine/tenant/streams.ts';
import { onEphemeral, setPresence } from '#engine/server/ephemeral.ts';
import { onTypingChange, setTyping } from '#engine/typing.ts';
import { waitForSync } from '#engine/sync-wait.ts';
import { genesis } from './fixtures/genesis.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}

async function withStore(fn: (store: Store) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: 'notification-dispatch-' });
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
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('dev', 'Dev');
      await tx.users.insert('bob', 'Bob');
    });
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('projection dispatch: self-removal cannot skip another committed wake', async () => {
  await withStore(async (store) => {
    const { roomId } = await genesis(store, { roomId: '!wake-remove:test' });
    const seen: string[] = [];
    let removeFirst = () => {};
    removeFirst = onProjected(() => {
      seen.push('first');
      removeFirst();
    });
    const removeSecond = onProjected(() => {
      seen.push('second');
    });
    try {
      await project(store, roomId);
      assertEquals(seen, ['first', 'second']);
    } finally {
      removeFirst();
      removeSecond();
    }
  });
});

Deno.test('projection dispatch: slow observer cannot delay later hints, but completion stays owned', async () => {
  await withStore(async (store) => {
    const { roomId } = await genesis(store, { roomId: '!wake-held:test' });
    const entered = deferred(), release = deferred();
    let notified = false, completed = false;
    const removeFirst = onProjected(async () => {
      entered.resolve();
      await release.promise;
    });
    const removeSecond = onProjected(() => {
      notified = true;
    });
    const pending = project(store, roomId).then(() => completed = true);
    try {
      await entered.promise;
      assertEquals(
        notified,
        true,
        'later listener must receive the committed hint',
      );
      assertEquals(
        completed,
        false,
        'projection still owns asynchronous observers',
      );
    } finally {
      release.resolve();
      await pending;
      removeFirst();
      removeSecond();
    }
    assertEquals(completed, true);
  });
});

Deno.test('projection dispatch: asynchronous observer does not retain the global writer', async () => {
  await withStore(async (store) => {
    const { roomId } = await genesis(store, { roomId: '!wake-writer:test' });
    const entered = deferred(), release = deferred();
    const remove = onProjected(async () => {
      entered.resolve();
      await release.promise;
    });
    const pending = project(store, roomId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let writer: Promise<string> | undefined;
    try {
      await entered.promise;
      writer = withProjectionLock(
        store,
        () => Promise.resolve('writer acquired'),
      );
      // Test deadlock watchdog, not a product response-latency target. The
      // observer is still explicitly held when the independent writer finishes.
      const watchdog = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('writer blocked by observer'), 5000);
      });
      assertEquals(await Promise.race([writer, watchdog]), 'writer acquired');
    } finally {
      clearTimeout(timer);
      release.resolve();
      await pending;
      await writer;
      remove();
    }
  });
});

Deno.test('projection dispatch: a real sync waiter recaptures while an unrelated observer is held', async () => {
  await withStore(async (store) => {
    const { roomId } = await genesis(store, { roomId: '!wake-consumer:test' });
    await project(store, roomId);
    const tenant = await openTenant(store, 'test');
    const server = await store.server();
    const captured = deferred(), entered = deferred(), release = deferred();
    let relevant = false;
    const remove = onProjected(async () => {
      relevant = true;
      entered.resolve();
      await release.promise;
    });
    let calls = 0;
    // Suppress only this waiter's first polling fallback. Native projection
    // duration must not turn a lost notification into a false passing test.
    // waitForSync arms its timer synchronously before calling capture.
    const setTimeout = globalThis.setTimeout;
    let waiting: Promise<boolean>;
    try {
      globalThis.setTimeout = ((_callback: unknown, delay?: number) =>
        setTimeout(() => {}, delay)) as typeof setTimeout;
      waiting = waitForSync(
        { store, server, tenant },
        { timeoutMs: 30000 },
        () => {
          captured.resolve();
          calls++;
          return Promise.resolve({ relevant, value: relevant });
        },
      );
    } finally {
      globalThis.setTimeout = setTimeout;
    }
    await captured.promise;
    // The room is already projected: no event-stream notification can mask
    // a missed projection hint. The owner probe below observes dispatch before
    // any clock-based polling fallback can supply a different wake.
    const pending = project(store, roomId);
    try {
      await entered.promise;
      // All callbacks have started in the same synchronous emission before
      // the observer's entered promise can resume this continuation.
      await Promise.resolve();
      assertEquals(calls, 2);
      assertEquals(await waiting, true);
    } finally {
      release.resolve();
      await pending;
      remove();
      await waiting;
    }
  });
});

// A committed emission owns its original audience. Enrollment changes apply
// only to the next emission, even when callbacks remove or enroll other callbacks.
async function membership(
  subscribe: (fn: () => void) => () => void,
  emit: () => void | Promise<unknown>,
) {
  const seen: string[] = [];
  let removeSecond = () => {}, removeLate = () => {};
  let enrolled = false;
  const removeFirst = subscribe(() => {
    seen.push('first');
    removeSecond();
    if (!enrolled) {
      enrolled = true;
      removeLate = subscribe(() => {
        seen.push('late');
      });
    }
  });
  removeSecond = subscribe(() => {
    seen.push('second');
  });
  try {
    await emit();
    assertEquals(seen, ['first', 'second']);
    seen.length = 0;
    await emit();
    assertEquals(seen, ['first', 'late']);
  } finally {
    removeFirst();
    removeSecond();
    removeLate();
  }
}

Deno.test('notification owners capture emission membership before invoking callbacks', async (t) => {
  await withStore(async (store) => {
    const { roomId } = await genesis(store, {
      roomId: '!wake-membership:test',
    });
    await project(store, roomId);
    const server = await store.server();
    await t.step(
      'projection',
      () => membership(onProjected, () => project(store, roomId)),
    );
    await t.step(
      'event stream',
      () =>
        membership(onEventStream, () => eventStreamTx(server, async () => {})),
    );
    await t.step(
      'tenant stream',
      () =>
        membership(onTenantStream, () => tenantStreamCommitted(store, 'test')),
    );
    await t.step(
      'ephemeral stream',
      () =>
        membership(
          onEphemeral,
          () => setPresence(server, '@dev:test', 'online'),
        ),
    );
    await t.step(
      'typing admission',
      () =>
        membership(
          onTypingChange,
          () => setTyping(server, roomId, '@dev:test', false),
        ),
    );
  });
});

Deno.test('committed stream notifications isolate observer exceptions', async (t) => {
  await withStore(async (store) => {
    const server = await store.server();
    async function exercise(
      subscribe: (fn: () => void) => () => void,
      emit: () => void | Promise<unknown>,
    ) {
      let notified = false;
      const removeFirst = subscribe(() => {
        throw new Error('expected observer failure');
      });
      const removeSecond = subscribe(() => {
        notified = true;
      });
      try {
        await emit();
        assertEquals(notified, true);
      } finally {
        removeFirst();
        removeSecond();
      }
    }
    await t.step(
      'event stream',
      () =>
        exercise(onEventStream, () => eventStreamTx(server, async () => {})),
    );
    await t.step(
      'tenant stream',
      () =>
        exercise(onTenantStream, () => tenantStreamCommitted(store, 'test')),
    );
  });
});

Deno.test('replica tenant hints preserve their source and key intent across a captured audience', async () => {
  await withStore(async (store) => {
    await store.server();
    const seen: unknown[] = [];
    let removeSecond = () => {};
    const removeFirst = onTenantStream((owner, tenant, source, keys) => {
      assertEquals(owner, store);
      removeSecond();
      seen.push(['first', tenant, source, keys]);
    });
    removeSecond = onTenantStream((_owner, tenant, source, keys) => {
      seen.push(['second', tenant, source, keys]);
    });
    try {
      tenantStreamCommitted(store, 'test', 'replica', true);
      assertEquals(seen, [
        ['first', 'test', 'replica', true],
        ['second', 'test', 'replica', true],
      ]);
      seen.length = 0;
      tenantStreamCommitted(store, 'test');
      assertEquals(seen, [['first', 'test', 'local', false]]);
    } finally {
      removeFirst();
      removeSecond();
    }
  });
});
