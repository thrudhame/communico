// Force shutdown interleavings through existing database/transport seams.
// Long timers remain real; a one-second assertion bounds every stop.
import { assertEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { listOutbox, startSender } from '#engine/federation/sender.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { type Conn, operations } from '#engine/store/db.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
} from '#engine/signing-primitives.js';
import { startFakeServer } from './federation/fake-server.ts';
import { testRemoteServer, testSigner } from './fixtures/signer.ts';

const HOUR = 3_600_000;

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('sender stop exceeded 1s')),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withStore(fn: (store: Store) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema } });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function queue(store: Store, destination: string, backoff = false) {
  const server = await store.server();
  await server.execute(
    "INSERT INTO outbox(room,pos,destination,event,state,added_ms) VALUES('!missing:test',1,?,'$e','pending',?)",
    [destination, Date.now()],
  );
  if (backoff) {
    await server.execute(
      'INSERT INTO peer_status(destination,next_attempt_ms) VALUES(?,?)',
      [destination, Date.now() + HOUR],
    );
  }
}

// Preserve timer behavior while observing exactly when backoff is registered.
function watchSleeps(expected: number) {
  const registered = latch();
  const active = new Set<Parameters<typeof clearTimeout>[0]>();
  let count = 0;
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  globalThis.setTimeout = Object.assign(
    (...args: Parameters<typeof setTimeout>) => {
      const timer = set(...args);
      if (Number(args[1]) > HOUR / 2) {
        active.add(timer);
        if (++count === expected) registered.resolve();
      }
      return timer;
    },
    set,
  );
  globalThis.clearTimeout = (timer) => {
    if (timer !== undefined) active.delete(timer);
    clear(timer);
  };
  return {
    registered: registered.promise,
    count: () => count,
    active,
    restore: () => {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
    },
  };
}

for (const mode of ['parked', 'late', 'late-multiple'] as const) {
  Deno.test(`sender stop: ${mode} hour-long backoff cannot hold shutdown`, async () => {
    await withStore(async (store) => {
      const destinations = mode === 'late'
        ? ['one.test']
        : ['one.test', 'two.test'];
      for (const dest of destinations) await queue(store, dest, true);
      const reached = latch(), release = latch();
      const original = store.server.bind(store);
      let reads = 0;
      store.server = async () => {
        const db = await original();
        return operations((fn, options) =>
          db.tx((conn) =>
            fn(
              new Proxy(conn, {
                get(target, key) {
                  if (key === 'query') {
                    return async (...args: Parameters<Conn['query']>) => {
                      const rows = await target.query(...args);
                      if (
                        args[0] ===
                          'SELECT * FROM peer_status WHERE destination = ?'
                      ) {
                        if (++reads === destinations.length) reached.resolve();
                        if (mode !== 'parked') await release.promise;
                      }
                      return rows;
                    };
                  }
                  const value = Reflect.get(target, key);
                  return typeof value === 'function'
                    ? value.bind(target)
                    : value;
                },
              }),
            ), options), db.path);
      };
      const timers = watchSleeps(destinations.length);
      const sender = startSender({ store, signer: await testSigner() });
      try {
        await bounded(mode === 'parked' ? timers.registered : reached.promise);
        const stopping = Promise.all([sender.stop(), sender.stop()]);
        release.resolve();
        await bounded(stopping);
        assertEquals(
          timers.count(),
          mode === 'parked' ? destinations.length : 0,
        );
        assertEquals(timers.active.size, 0);
        // Delayed producer wakes and repeated stops cannot reopen the worker.
        for (const dest of destinations) sender.wake(dest);
        await bounded(sender.stop());
        assertEquals(timers.active.size, 0);
        assertEquals(
          (await listOutbox(await original())).map((r) => r.state),
          destinations.map(() => 'pending'),
        );
      } finally {
        release.resolve();
        for (const dest of destinations) sender.wake(dest);
        await sender.stop();
        timers.restore();
        store.server = original;
      }
    });
  });
}

Deno.test('sender stop: an intent prepared across stop is not started', async () => {
  await withStore(async (store) => {
    await queue(store, 'intent.test');
    const reached = latch(), release = latch();
    let runs = 0;
    const sender = startSender({ store, signer: await testSigner() });
    sender.setIntentProvider(async () => {
      reached.resolve();
      await release.promise;
      return {
        id: 'held-intent',
        run: () => {
          runs++;
          return Promise.resolve();
        },
        failed: () => Promise.resolve(),
      };
    });
    try {
      await bounded(reached.promise);
      const stopping = sender.stop();
      release.resolve();
      await bounded(stopping);
      assertEquals(runs, 0);
    } finally {
      release.resolve();
      await sender.stop();
    }
  });
});

for (
  const phase of [
    'preparing',
    'in-flight-success',
    'in-flight-failure',
  ] as const
) {
  Deno.test(`sender stop: ${phase} TLS delivery drains without a backoff or another request`, async () => {
    await withStore(async (store) => {
      setConfigForTests({
        federation: {
          cacerts: ['tests/fixtures/tls/ca.crt'],
          backoffstartmillihours: 1000,
        },
      });
      resetCaCertsForTests();
      const us = await testRemoteServer();
      const key = b64encodeStd(await exportPublicKeyRaw(us.kp.publicKey));
      const reached = latch(), release = latch();
      let sends = 0;
      const fake = await startFakeServer({
        ourKeyDoc: () =>
          Promise.resolve({
            server_name: us.name,
            verify_keys: { [us.keyId]: { key } },
          }),
        handlers: async () => {
          sends++;
          reached.resolve();
          await release.promise;
          return Response.json({ pdus: {} }, {
            status: phase === 'in-flight-failure' ? 500 : 200,
          });
        },
      });
      const room = store.room.bind(store);
      if (phase === 'preparing') {
        store.room = async (...args) => {
          reached.resolve();
          await release.promise;
          return await room(...args);
        };
      }
      const server = await store.server();
      await server.execute(
        "INSERT INTO feed(seq,room,pos,event,stay) VALUES(1,'!missing:test',1,'$e',1)",
      );
      await queue(store, fake.name);
      const sender = startSender({ store, signer: await testSigner() });
      try {
        await bounded(reached.promise);
        let stopped = false;
        const stopping = sender.stop().then(() => {
          stopped = true;
        });
        await Promise.resolve();
        assertEquals(
          stopped,
          false,
          'stop waits for its held in-flight operation',
        );
        release.resolve();
        await bounded(stopping);
        assertEquals(sends, phase === 'preparing' ? 0 : 1);
        const rows = await listOutbox(server);
        assertEquals(
          rows[0].state,
          phase === 'in-flight-success' ? 'sent' : 'pending',
        );
        assertEquals(rows[0].attempts, phase === 'in-flight-failure' ? 1 : 0);
      } finally {
        release.resolve();
        await sender.stop();
        store.room = room;
        await fake.close();
        setConfigForTests({
          federation: { cacerts: [], backoffstartmillihours: 125 },
        });
        resetCaCertsForTests();
      }
    });
  });
}
