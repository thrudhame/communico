import { assertEquals, assertRejects } from '@std/assert';
import { ServerLifetime } from '#root/api/server-lifetime.ts';
import { setConfigForTests } from '#engine/config.ts';
import {
  receiveTransaction,
  type TransactionDeps,
} from '#engine/federation/transactions.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import type { RemoteDeps } from '#engine/room/deps.ts';
import { roomSchema } from '#engine/room/schema.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { genesis } from './fixtures/genesis.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
} from './fixtures/remote.ts';
import { keyStore } from '#engine/federation/keys.ts';
import { directOnly, makeDoc, makeServer } from './federation/doc-helper.ts';
import { askWitnesses } from '#engine/federation/witness.ts';
import { fetchBoundaryEvents } from '#engine/room/boundary-fetch.ts';
import { setRoomHooks } from '#engine/room/hooks.ts';
import { project } from '#engine/server/project.ts';
import { authAt } from './fixtures/auth.ts';
import {
  afterRoomCommit,
  ingestInTx,
  resumeWaits,
} from '#engine/room/ingest.ts';

const receive = receiveTransaction;

async function withStore(fn: (store: Store) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 4120000,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema, server: serverSchema } });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('request cancellation: listener cancellation reaches the body owner without releasing a running handler', async () => {
  for (const cause of ['disconnect', 'shutdown'] as const) {
    const lifetime = new ServerLifetime();
    const entered = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const handler = lifetime.wrap<Deno.NetAddr>(
      'federation',
      async (request) => {
        assertEquals(await request.text(), 'owned body');
        entered.resolve(request.signal);
        await release.promise;
        return new Response('done');
      },
    );
    const run = handler(
      new Request('http://local/send', { method: 'PUT', body: 'owned body' }),
      { completed: completed.promise } as Parameters<
        Deno.ServeHandler<Deno.NetAddr>
      >[1],
    );
    const signal = await entered.promise;
    try {
      if (cause === 'disconnect') {
        completed.reject(new Error('transport disconnected'));
      } else lifetime.abort();
      await Promise.resolve();
      assertEquals(signal.aborted, true, cause);
      assertEquals(
        lifetime.count,
        1,
        'transport completion is not callback settlement',
      );
    } finally {
      release.resolve();
      completed.resolve();
      await run;
    }
    await lifetime.settled();
    assertEquals(lifetime.count, 0);
  }
});

async function fixture(store: Store, controller: AbortController) {
  const g = await genesis(store, {
    roomId: '!cancellation:test',
    joinRule: 'public',
  });
  const peer = await makeRemoteServer('remote.test');
  const pdu = await remoteEvent(g.roomId, peer, '11', {
    type: 'm.room.message',
    sender: '@remote:remote.test',
    content: { body: 'abandoned recovery' },
    prev_events: ['$missing'],
    auth_events: [],
  });
  const entered = Promise.withResolvers<AbortSignal | undefined>();
  const release = Promise.withResolvers<void>();
  const deps: RemoteDeps & { signal: AbortSignal } = {
    keys: fakeKeyResolver(peer),
    fetcher: fakeFetcher({}).fetcher,
    self: 'test',
    limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
    ungroundedMs: 3600000,
    signal: controller.signal,
  };
  deps.fetcher.missingEvents = async (...args: unknown[]) => {
    entered.resolve(args[5] as AbortSignal | undefined);
    await release.promise;
    return [];
  };
  return { g, peer, pdu, deps, entered, release };
}

Deno.test('request cancellation: abandoned native recovery stops before pending event storage', async () => {
  await withStore(async (store) => {
    const controller = new AbortController();
    const f = await fixture(store, controller);
    const run = ingestRemote(f.g.room, [f.pdu], f.peer.name, f.deps);
    const settled = Promise.allSettled([run]);
    await f.entered.promise;
    controller.abort();
    f.release.resolve();
    assertEquals((await settled)[0].status, 'rejected');
    assertEquals(
      await f.g.room.tx((tx) => tx.events.get(f.pdu.event_id!)),
      null,
    );
  });
});

Deno.test('request cancellation: last flight subscriber aborts the work but retains ownership until it settles', async () => {
  await withStore(async (store) => {
    setConfigForTests({ federation: { missingwaitms: 0 } });
    const a = new AbortController(), b = new AbortController();
    const f = await fixture(store, a);
    const deps: TransactionDeps = {
      ...f.deps,
      store,
      edus: { dispatch: () => Promise.resolve() },
    };
    const body = {
      origin: f.peer.name,
      origin_server_ts: 1,
      pdus: [f.pdu],
      edus: [],
    };
    let ownerSettled = false;
    const first = receive(
      f.peer.name,
      'cancelled',
      structuredClone(body),
      deps,
      a.signal,
    );
    void first.then(() => ownerSettled = true, () => ownerSettled = true);
    const second = receive(
      f.peer.name,
      'cancelled',
      structuredClone(body),
      deps,
      b.signal,
    );
    const settled = Promise.allSettled([first, second]);
    try {
      const demand = await f.entered.promise;
      a.abort();
      await Promise.resolve();
      assertEquals(
        demand?.aborted,
        false,
        'the other subscriber still needs this recovery',
      );
      b.abort();
      await Promise.resolve();
      assertEquals(
        demand?.aborted,
        true,
        'last subscriber cancellation reaches the real fetch',
      );
      assertEquals(
        ownerSettled,
        false,
        'a noncooperative fetch still owns the handler',
      );
    } finally {
      f.release.resolve();
      await settled;
      setConfigForTests({ federation: { missingwaitms: 750 } });
    }
    assertEquals((await settled).map((r) => r.status), [
      'rejected',
      'rejected',
    ]);
    const server = await store.server();
    assertEquals(
      await server.query(
        'SELECT response FROM federation_txns WHERE txn_id=?',
        ['cancelled'],
      ),
      [],
    );
    const empty = { ...body, pdus: [] };
    assertEquals(
      (await receive(f.peer.name, 'cancelled', empty, deps)).status,
      200,
    );
    const cancelled = new AbortController();
    cancelled.abort();
    await assertRejects(
      () => receive(f.peer.name, 'not-admitted', empty, deps, cancelled.signal),
      DOMException,
    );
    assertEquals(
      await server.query(
        'SELECT response FROM federation_txns WHERE txn_id=?',
        ['not-admitted'],
      ),
      [],
    );
  });
});

Deno.test('request cancellation: shared key acquisition has subscriber demand and never persists an abandoned answer', async () => {
  await withStore(async (store) => {
    const remote = await makeServer('cancel-key.test');
    const doc = await makeDoc(remote);
    const entered = Promise.withResolvers<AbortSignal | undefined>();
    const release = Promise.withResolvers<void>();
    const deps = directOnly(doc);
    let reads = 0;
    deps.directGet = async (...args: unknown[]) => {
      reads++;
      entered.resolve(args[2] as AbortSignal | undefined);
      await release.promise;
      return doc;
    };
    const server = await store.server();
    const captured = Promise.withResolvers<void>();
    const query = server.query.bind(server);
    let captures = 0;
    server.query = async (sql, values) => {
      const rows = await query(sql, values);
      if (
        sql.includes('SELECT key_json, fetched_ms, via FROM server_key_docs') &&
        ++captures === 2
      ) captured.resolve();
      return rows;
    };
    const keys = keyStore(server, { deps });
    const a = new AbortController(), b = new AbortController();
    const first = keys.acquireKeyDoc(remote.name, 0, {
      roomId: undefined,
      ...{ signal: a.signal },
    });
    const second = keys.acquireKeyDoc(remote.name, 0, {
      roomId: undefined,
      ...{ signal: b.signal },
    });
    const done = Promise.allSettled([first, second]);
    try {
      const demand = await entered.promise;
      // Each caller first checks its own cached-key horizon. Observe both
      // actual native captures, then let their continuations join the flight.
      await captured.promise;
      for (let turn = 0; turn < 4; turn++) await Promise.resolve();
      a.abort();
      assertEquals(demand?.aborted, false);
      b.abort();
      assertEquals(demand?.aborted, true);
    } finally {
      release.resolve();
      await done;
    }
    assertEquals((await done).map((r) => r.status), ['rejected', 'rejected']);
    assertEquals((await keys.listServerKeys(remote.name))[0].doc, null);
    assertEquals(await keys.acquireKeyDoc(remote.name, 0), doc);
    assertEquals(reads, 2, 'caller cancellation is not cached as peer backoff');
  });
});

Deno.test('request cancellation: a surviving transaction subscriber receives the real result and durable replay', async () => {
  await withStore(async (store) => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let dispatches = 0;
    const deps: TransactionDeps = {
      store,
      self: 'test',
      keys: fakeKeyResolver(),
      fetcher: fakeFetcher({}).fetcher,
      edus: {
        dispatch: async () => {
          dispatches++;
          entered.resolve();
          await release.promise;
        },
      },
    };
    const body = {
      origin: 'remote.test',
      origin_server_ts: 1,
      pdus: [],
      edus: [{ edu_type: 'test.survivor', content: {} }],
    };
    const abandoned = new AbortController();
    const first = receive(
      'remote.test',
      'survivor',
      body,
      deps,
      abandoned.signal,
    );
    const second = receive('remote.test', 'survivor', body, deps);
    const done = Promise.allSettled([first, second]);
    await entered.promise;
    abandoned.abort();
    release.resolve();
    assertEquals((await done).map((r) => r.status), ['rejected', 'fulfilled']);
    assertEquals((await second).status, 200);
    assertEquals(
      await receive('remote.test', 'survivor', body, deps),
      await second,
    );
    assertEquals(dispatches, 1);
  });
});

Deno.test('request cancellation: a failed witness wave owns its other running callbacks through settlement', async () => {
  const entered = Promise.withResolvers<void>(),
    fail = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let settled = false;
  const failure = new Error('local witness callback failed');
  const run = askWitnesses({
    serverName: 'remote.test',
    minimumValidUntilTs: 0,
    peers: ['failed.test', 'held.test'],
    query: async (peer) => {
      if (peer === 'failed.test') {
        await fail.promise;
        throw failure;
      }
      entered.resolve();
      await release.promise;
      return { server_keys: [] };
    },
    selfCheck: (doc) => Promise.resolve(doc),
    witnessCheck: () => Promise.resolve(true),
  });
  const done = run.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  try {
    await entered.promise;
    fail.resolve();
    // The known failure has propagated through the first query's await chain,
    // while the second callback is deliberately still owned and held.
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    assertEquals(settled, false);
  } finally {
    release.resolve();
    await done;
  }
  await assertRejects(() => run, Error, failure.message);
});

Deno.test('request cancellation: a failed boundary wave owns its other running callbacks through settlement', async () => {
  const entered = Promise.withResolvers<void>(),
    fail = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const failure = new Error('local boundary callback failed');
  const fetcher = fakeFetcher({}).fetcher;
  fetcher.event = async (id) => {
    if (id === '$failed') {
      await fail.promise;
      throw failure;
    }
    entered.resolve();
    await release.promise;
    return null;
  };
  let settled = false;
  const run = fetchBoundaryEvents(['$failed', '$held'], 2, {
    roomId: '!wave:test',
    at: '$tip',
    via: 'remote.test',
    version: '11',
    fetcher,
    keys: fakeKeyResolver(),
    concurrency: 8,
    active: () => true,
    read: (op) => op(),
  });
  const done = run.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  try {
    await entered.promise;
    fail.resolve();
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    assertEquals(settled, false);
  } finally {
    release.resolve();
    await done;
  }
  await assertRejects(() => run, Error, failure.message);
});

async function validMessage(store: Store) {
  const g = await genesis(store, { roomId: '!committed-cancellation:test' });
  const peer = await makeRemoteServer('test');
  const pdu = await remoteEvent(g.roomId, peer, '11', {
    type: 'm.room.message',
    sender: g.creator,
    content: { body: 'committed publication' },
    prev_events: [g.tipId],
    auth_events: await authAt(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: {},
    }, g.tipId),
  });
  return {
    g,
    peer,
    pdu,
    deps: {
      keys: fakeKeyResolver(peer),
      fetcher: fakeFetcher({}).fetcher,
      self: 'test',
      limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
      ungroundedMs: 3600000,
    },
  };
}

Deno.test('request cancellation: a committed room write retains projection ownership and does not cache abandoned transaction success', async () => {
  await withStore(async (store) => {
    const f = await validMessage(store);
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const controller = new AbortController();
    setRoomHooks({
      project: async (actualStore, roomId) => {
        assertEquals(
          (await f.g.room.tx((tx) => tx.events.getStatus(f.pdu.event_id!)))
            ?.grounding,
          'grounded',
        );
        entered.resolve();
        await release.promise;
        await project(actualStore, roomId);
      },
      register: () => Promise.resolve(),
    });
    let settled = false;
    const run = receive(
      'test',
      'after-commit',
      { origin: 'test', origin_server_ts: 1, pdus: [f.pdu], edus: [] },
      {
        ...f.deps,
        store,
        edus: { dispatch: () => Promise.resolve() },
      },
      controller.signal,
    );
    const done = run.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    try {
      await entered.promise;
      controller.abort();
      await Promise.resolve();
      assertEquals(
        settled,
        false,
        'transport cancellation cannot release committed projection',
      );
    } finally {
      release.resolve();
      await done;
      setRoomHooks({
        project: () => Promise.resolve(),
        register: () => Promise.resolve(),
      });
    }
    await assertRejects(() => run, DOMException);
    const server = await store.server();
    assertEquals(
      (await server.query('SELECT event FROM feed WHERE event=?', [
        f.pdu.event_id!,
      ])).map((r) => r.event),
      [f.pdu.event_id!],
    );
    assertEquals(
      await server.query(
        'SELECT response FROM federation_txns WHERE txn_id=?',
        ['after-commit'],
      ),
      [],
    );
  });
});

Deno.test('request cancellation: cancellation inside live ingest rolls back rather than publishing a partial batch', async () => {
  await withStore(async (store) => {
    const f = await validMessage(store);
    const controller = new AbortController();
    const transaction = f.g.room.tx.bind(f.g.room);
    f.g.room.tx = (fn) =>
      transaction(async (tx) => {
        const insert = tx.events.insert.bind(tx.events);
        tx.events.insert = async (...args) => {
          await insert(...args);
          if (args[0] === f.pdu.event_id) controller.abort();
        };
        return await fn(tx);
      });
    await assertRejects(
      () =>
        ingestRemote(f.g.room, [f.pdu], 'test', {
          ...f.deps,
          signal: controller.signal,
        }),
      DOMException,
    );
    assertEquals(
      await transaction((tx) => tx.events.get(f.pdu.event_id!)),
      null,
    );
    assertEquals(
      await (await store.server()).query(
        'SELECT event FROM feed WHERE event=?',
        [f.pdu.event_id!],
      ),
      [],
    );
  });
});

Deno.test('request cancellation: ready drain stops between committed turns and preserves the remaining durable waiter', async () => {
  await withStore(async (store) => {
    const f = await validMessage(store);
    const child = await remoteEvent(f.g.roomId, f.peer, '11', {
      ...f.pdu,
      prev_events: [f.pdu.event_id!],
      content: { body: 'first ready waiter' },
    });
    const tail = await remoteEvent(f.g.roomId, f.peer, '11', {
      ...f.pdu,
      prev_events: [child.event_id!],
      content: { body: 'second ready waiter' },
    });
    const staged = await ingestRemote(f.g.room, [child, tail], 'test', {
      ...f.deps,
      limits: { waitMs: 0, limit: 10, budgetMs: 0 },
    });
    assertEquals(staged.map((r) => r.outcome), ['pending', 'pending']);
    await f.g.room.tx((tx) =>
      ingestInTx(tx, f.g.roomId, f.pdu, { self: 'test' })
    );
    const controller = new AbortController();
    const transaction = f.g.room.tx.bind(f.g.room);
    f.g.room.tx = async (fn) => {
      const result = await transaction(fn);
      if (
        (await transaction((tx) => tx.events.getStatus(child.event_id!)))
          ?.grounding === 'grounded'
      ) controller.abort();
      return result;
    };
    const demand = { self: 'test', signal: controller.signal };
    assertEquals(await resumeWaits(f.g.room, demand, []), 1);
    assertEquals(
      (await transaction((tx) => tx.events.getStatus(tail.event_id!)))
        ?.grounding,
      'pending',
    );
    f.g.room.tx = transaction;
    assertEquals(await resumeWaits(f.g.room, { self: 'test' }, []), 1);
    assertEquals(
      (await transaction((tx) => tx.events.getStatus(tail.event_id!)))
        ?.grounding,
      'grounded',
    );
  });
});

Deno.test('request cancellation: shared completion projects committed work after an aborted or failed retry drain', async () => {
  for (const cause of ['abort', 'failure'] as const) {
    await withStore(async (store) => {
      const f = await validMessage(store);
      const committed = await ingestRemote(f.g.room, [f.pdu], 'test', f.deps);
      assertEquals(committed.map((result) => result.outcome), ['accepted']);
      const transaction = f.g.room.tx.bind(f.g.room);
      const failure = new Error('retry capture failed');
      let reads = 0, projections = 0;
      f.g.room.tx = (_fn) => {
        reads++;
        return Promise.reject(failure);
      };
      setRoomHooks({
        project: async (actualStore, roomId) => {
          projections++;
          f.g.room.tx = transaction;
          await project(actualStore, roomId);
        },
        register: () => Promise.resolve(),
      });
      const controller = new AbortController();
      if (cause === 'abort') controller.abort();
      try {
        const run = () =>
          afterRoomCommit(f.g.room, 'test', [], controller.signal);
        if (cause === 'abort') await run();
        else await assertRejects(run, Error, failure.message);
        assertEquals(reads, cause === 'abort' ? 0 : 1);
        assertEquals(projections, 1);
        assertEquals(
          (await (await store.server()).query(
            'SELECT event FROM feed WHERE event=?',
            [f.pdu.event_id!],
          )).map((row) => row.event),
          [f.pdu.event_id!],
        );
      } finally {
        f.g.room.tx = transaction;
        setRoomHooks({
          project: () => Promise.resolve(),
          register: () => Promise.resolve(),
        });
      }
    });
  }
});
