import { assertEquals, assertRejects } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import {
  receiveTransaction,
  type TransactionDeps,
} from '#engine/federation/transactions.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { roomSchema } from '#engine/room/schema.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { authAt } from './fixtures/auth.ts';
import { genesis } from './fixtures/genesis.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
} from './fixtures/remote.ts';

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

function emptyBody(origin = 'remote.test') {
  return {
    origin,
    origin_server_ts: 1,
    pdus: [],
    edus: [{ edu_type: 'test.flight', content: {} }],
  };
}

function dependencies(store: Store): TransactionDeps {
  return {
    store,
    self: 'test',
    keys: fakeKeyResolver(),
    fetcher: fakeFetcher({}).fetcher,
    edus: { dispatch: () => Promise.resolve() },
  };
}

Deno.test('inbound flight: concurrent retries share recovery, EDU dispatch and the durable answer', async () => {
  await withStore(async (store) => {
    setConfigForTests({ federation: { missingwaitms: 0 } });
    try {
      const g = await genesis(store, {
        roomId: '!inflight:test',
        joinRule: 'public',
      });
      const peer = await makeRemoteServer('remote.test');
      const user = '@remote:remote.test';
      const join = await remoteEvent(g.roomId, peer, '11', {
        type: 'm.room.member',
        sender: user,
        state_key: user,
        content: { membership: 'join' },
        prev_events: [g.tipId],
        auth_events: await authAt(g.room, {
          type: 'm.room.member',
          sender: user,
          state_key: user,
          content: { membership: 'join' },
        }, g.tipId),
      });
      const deps = dependencies(store);
      deps.keys = fakeKeyResolver(peer);
      assertEquals(
        (await ingestRemote(g.room, [join], peer.name, {
          ...deps,
          limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
          ungroundedMs: 3_600_000,
        }))[0].outcome,
        'accepted',
      );
      const pdu = await remoteEvent(g.roomId, peer, '11', {
        type: 'm.room.message',
        sender: user,
        content: { body: 'shared missing parent' },
        prev_events: ['$unavailable'],
        auth_events: await authAt(g.room, {
          type: 'm.room.message',
          sender: user,
          content: {},
        }, join.event_id!),
      });
      const missing = fakeFetcher({});
      deps.fetcher = missing.fetcher;
      let dispatches = 0;
      deps.edus = {
        dispatch: () => {
          dispatches++;
          return Promise.resolve();
        },
      };
      const body = { ...emptyBody(), pdus: [pdu] };
      const answers = await Promise.all(
        Array.from(
          { length: 4 },
          () =>
            receiveTransaction(peer.name, 'retry', structuredClone(body), {
              ...deps,
            }),
        ),
      );
      assertEquals(answers.map((answer) => answer.status), [
        200,
        200,
        200,
        200,
      ]);
      for (const answer of answers) assertEquals(answer, answers[0]);
      const status = await g.room.tx((tx) =>
        tx.events.getStatus(pdu.event_id!)
      );
      assertEquals(status?.grounding, 'pending');
      assertEquals(missing.calls.missingEvents.length, 1);
      assertEquals(dispatches, 1);
      answers[0].body.pdus = 'caller mutation';
      assertEquals(typeof answers[1].body.pdus, 'object');
      const replay = await receiveTransaction(peer.name, 'retry', body, deps);
      assertEquals(replay, answers[1]);
      assertEquals(dispatches, 1);
    } finally {
      setConfigForTests({ federation: { missingwaitms: 750 } });
    }
  });
});

Deno.test('inbound flight: store, origin and transaction identity remain independent', async () => {
  await withStore(async (store) => {
    await withStore(async (otherStore) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let dispatches = 0;
      const deps = dependencies(store);
      deps.edus = {
        dispatch: async () => {
          dispatches++;
          entered.resolve();
          await release.promise;
        },
      };
      const owner = receiveTransaction(
        'remote.test',
        'same',
        emptyBody(),
        deps,
      );
      await entered.promise;
      const retry = receiveTransaction('remote.test', 'same', emptyBody(), {
        ...deps,
      });
      try {
        for (
          const [origin, id, independent] of [
            ['remote.test', 'different', dependencies(store)],
            ['other.test', 'same', dependencies(store)],
            ['remote.test', 'same', dependencies(otherStore)],
          ] as const
        ) {
          assertEquals(
            (await receiveTransaction(
              origin,
              id,
              emptyBody(origin),
              independent,
            ))
              .status,
            200,
          );
        }
      } finally {
        release.resolve();
        await Promise.all([owner, retry]);
      }
      assertEquals(dispatches, 1);
    });
  });
});

Deno.test('inbound flight: local failure reaches every waiter and a later retry can own the work', async () => {
  await withStore(async (store) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failure = new Error('local EDU publication failed');
    let dispatches = 0;
    const deps = dependencies(store);
    deps.edus = {
      dispatch: async () => {
        dispatches++;
        entered.resolve();
        await release.promise;
        throw failure;
      },
    };
    const pending = Promise.allSettled(
      Array.from(
        { length: 4 },
        () =>
          receiveTransaction('remote.test', 'failure', emptyBody(), {
            ...deps,
          }),
      ),
    );
    await entered.promise;
    // An independent durable operation can finish while this flight is held.
    await receiveTransaction(
      'other.test',
      'progress',
      emptyBody('other.test'),
      {
        ...dependencies(store),
      },
    );
    release.resolve();
    const results = await pending;
    assertEquals(
      results.map((result) =>
        result.status === 'rejected' && result.reason === failure
      ),
      [true, true, true, true],
    );
    assertEquals(dispatches, 1);
    const server = await store.server();
    assertEquals(
      await server.query(
        'SELECT response FROM federation_txns WHERE origin=? AND txn_id=?',
        ['remote.test', 'failure'],
      ),
      [],
    );
    deps.edus = {
      dispatch: () => {
        dispatches++;
        return Promise.resolve();
      },
    };
    assertEquals(
      (await receiveTransaction('remote.test', 'failure', emptyBody(), deps))
        .status,
      200,
    );
    assertEquals(dispatches, 2);
  });
});

Deno.test('inbound flight: malformed retries still cross envelope admission', async () => {
  await withStore(async (store) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const deps = dependencies(store);
    deps.edus = {
      dispatch: async () => {
        entered.resolve();
        await release.promise;
      },
    };
    const owner = receiveTransaction(
      'remote.test',
      'admission',
      emptyBody(),
      deps,
    );
    await entered.promise;
    try {
      await assertRejects(
        () => receiveTransaction('remote.test', 'admission', {}, deps),
        MatrixError,
      );
    } finally {
      release.resolve();
      await owner;
    }
  });
});
