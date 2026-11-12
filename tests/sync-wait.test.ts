import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { eventStreamTx } from '#engine/server/stream.ts';
import { waitForSync } from '#engine/sync-wait.ts';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'sync-wait-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema, server: serverSchema } });
  const tenant = await openTenant(store, 'wait.test', { create: true });
  const server = await store.server();
  return {
    store,
    tenant,
    server,
    close: async () => {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('sync wait: arm before capture, recheck unrelated hints, and return only the relevant captured value', async () => {
  const f = await fixture();
  try {
    const first = deferred(), release = deferred(), second = deferred();
    let calls = 0, relevant = false, finished = false;
    const pending = waitForSync(f, { timeoutMs: 3000 }, async () => {
      const call = ++calls;
      if (call === 1) {
        first.resolve();
        await release.promise;
      }
      if (call === 2) second.resolve();
      return { relevant, value: { calls: call, relevant } };
    }).then((result) => {
      finished = true;
      return result;
    });
    await first.promise;
    // A commit between capture and waiting must not disappear. It is only a
    // hint: a different room/user's update cannot complete the response.
    await eventStreamTx(f.server, async () => {});
    release.resolve();
    await second.promise;
    assertEquals(finished, false);
    relevant = true;
    await f.tenant.tx((tx) => tx.counters.nextStream());
    const result = await pending;
    assertEquals(result.relevant, true);
    assertEquals(result.calls >= 3, true);
  } finally {
    await f.close();
  }
});

Deno.test('sync wait: config-only relevance returns immediately and timeout stays absolute under unrelated commits', async () => {
  const f = await fixture();
  try {
    assertEquals(
      await waitForSync(
        f,
        { timeoutMs: 30000 },
        () => Promise.resolve({ relevant: true, value: 'expanded' }),
      ),
      'expanded',
    );
    let calls = 0;
    const result = await waitForSync(f, { timeoutMs: 40 }, async () => {
      calls++;
      // Every read races another irrelevant stream commit. Restarting a
      // relative timeout here would never finish.
      await eventStreamTx(f.server, async () => {});
      return { relevant: false, value: 'timeout' };
    });
    assertEquals(result, 'timeout');
    assertEquals(calls > 1, true);
    assertEquals(
      await waitForSync(
        f,
        { timeoutMs: 0 },
        () => Promise.resolve({ relevant: false, value: 'no-wait' }),
      ),
      'no-wait',
    );
  } finally {
    await f.close();
  }
});

Deno.test('sync wait: an operator-validated timeout above thirty seconds is not silently capped', async () => {
  const f = await fixture();
  const original = Date.now;
  let now = original(), calls = 0;
  Date.now = () => now;
  try {
    const result = await waitForSync(f, { timeoutMs: 60000 }, async () => {
      calls++;
      if (calls === 1) {
        now += 31000;
        await eventStreamTx(f.server, async () => {});
      }
      return { relevant: calls > 1, value: calls };
    });
    assertEquals(result, 2);
  } finally {
    Date.now = original;
    await f.close();
  }
});

Deno.test('sync wait: abort while waiting or capturing rejects without returning a stale result; capture failures propagate', async () => {
  const f = await fixture();
  try {
    const captured = deferred(), controller = new AbortController();
    const pending = waitForSync(f, {
      timeoutMs: 30000,
      signal: controller.signal,
    }, () => {
      captured.resolve();
      return Promise.resolve({ relevant: false, value: 'stale' });
    });
    await captured.promise;
    controller.abort();
    await assertRejects(() => pending, DOMException, 'aborted');
    const during = new AbortController();
    await assertRejects(
      () =>
        waitForSync(f, { timeoutMs: 30000, signal: during.signal }, () => {
          during.abort();
          return Promise.resolve({ relevant: true, value: 'stale' });
        }),
      DOMException,
      'aborted',
    );
    await assertRejects(
      () =>
        waitForSync(
          f,
          { timeoutMs: 30000 },
          () => Promise.reject(new Error('capture failed')),
        ),
      Error,
      'capture failed',
    );
    // A later independent request is unaffected by cancelled listeners/timers.
    assertEquals(
      await waitForSync(
        f,
        { timeoutMs: 0 },
        () => Promise.resolve({ relevant: true, value: 'fresh' }),
      ),
      'fresh',
    );
  } finally {
    await f.close();
  }
});

Deno.test('sync wait: blocked capture does not delay abort or keep request listeners alive', async () => {
  const f = await fixture();
  const started = deferred(), release = deferred();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = waitForSync(f, {
    timeoutMs: 30000,
    signal: controller.signal,
  }, async () => {
    started.resolve();
    await release.promise;
    return { relevant: true, value: 'stale' };
  });
  const observed = pending.then(() => 'returned', () => 'aborted');
  try {
    await started.promise;
    controller.abort();
    const bound = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('still-blocked'), 200);
    });
    assertEquals(await Promise.race([observed, bound]), 'aborted');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    release.resolve();
    await observed;
    await f.close();
  }
});
