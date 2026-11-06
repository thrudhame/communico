// Immutable edges amortize deep auth walks; status remains transaction-fresh.
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  buildInTx,
  finalizeBuilt,
  loadRulebookStore,
  withRulebookEvent,
} from '#engine/room/build.ts';
import { EdgeCache } from '#engine/room/edges.ts';
import type { Pdu } from '#engine/pdu.ts';
import { ancestors, authClosure, insertEvent } from '#engine/room/events.ts';
import { openRoom, roomSchema, type RoomTx } from '#engine/room/index.ts';
import { ingestInTx } from '#engine/room/ingest.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import { Conn } from '#engine/store/db.ts';
import { StoreError } from '#engine/store/ffi.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { genesis } from './fixtures/genesis.ts';

async function withStore(fn: (store: Store) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 2,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

function raw(auth: string[], prev = auth) {
  return JSON.stringify({
    type: 'm.room.message',
    sender: '@a:test',
    depth: 1,
    origin_server_ts: 1,
    content: {},
    auth_events: auth,
    prev_events: prev,
  });
}

async function countEdges(fn: () => Promise<void>) {
  const query = Conn.prototype.query;
  let count = 0;
  Conn.prototype.query = function (sql, values) {
    if (/\b(auth_edges|prev_edges)\b/.test(sql)) count++;
    return query.call(this, sql, values);
  };
  try {
    await fn();
    return count;
  } finally {
    Conn.prototype.query = query;
  }
}

Deno.test('edge cache: D=200 auth chain and N=10 live fork ingests use at most D+2N+20 queries', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!deep:test' });
    const db = await store.room(g.roomId);
    // Persist through the uncached data layer: the first live walk is cold.
    await db.tx(async (conn) => {
      for (let i = 0; i < 200; i++) {
        await insertEvent(
          conn,
          '$chain' + i,
          JSON.stringify({
            ...JSON.parse(raw(i ? ['$chain' + (i - 1)] : [])),
            type: 'm.room.member',
            state_key: g.creator,
            room_id: g.roomId,
            content: { membership: 'join' },
          }),
        );
      }
    });
    const template = await g.room.tx((tx) =>
      buildInTx(tx, g.roomId, {
        type: 'm.room.message',
        sender: g.creator,
        content: { body: 'fork' },
        prev_events: [g.tipId],
        origin_server_ts: 100,
      }, g.signer)
    );
    const expectedState = await g.room.tx(async (tx) =>
      tx.state.groupMap(
        (await tx.state.current((await tx.segments.openStay())!.id))!,
      )
    );
    const member = expectedState.get('m.room.member\0' + g.creator)!;
    // An alternative declared membership models a deep remote evidence chain.
    // Remote selection permits the same auth key from a different fork.
    let totalLoads = 0;
    const queries = await countEdges(async () => {
      for (let i = 0; i < 10; i++) {
        const { event_id: _id, ...body } = template;
        void _id;
        const pdu = await finalizeBuilt(
          {
            ...body,
            origin_server_ts: 100 + i,
            auth_events: template.auth_events!.map((id) =>
              id === member ? '$chain199' : id
            ),
            hashes: { sha256: '' },
            signatures: {},
          },
          getRulebook('11'),
          g.signer,
        );
        const room = await openRoom(store, g.roomId);
        const { result, loads } = await room.tx(async (tx) => {
          let loads = 0;
          const closure = tx.events.authClosure;
          tx.events.authClosure = (...args) => {
            loads++;
            return closure(...args);
          };
          const result = await ingestInTx(tx, g.roomId, pdu, {
            remote: {
              origin: 'test',
              self: 'test',
              oversized: false,
              ungroundedMs: 1000,
            },
          });
          return { result, loads };
        });
        totalLoads += loads;
        assertEquals(result.standing, 'accepted');
        await room.tx(async (tx) => {
          assertEquals(
            (await tx.events.getStatus(result.eventId))?.standing,
            'accepted',
          );
          const stay = (await tx.segments.openStay())!;
          const current = (await tx.state.current(stay.id))!;
          assertEquals(await tx.state.groupMap(current), expectedState);
        });
      }
    });
    console.log({ depth: 200, live: 10, edgeQueries: queries, bound: 240 });
    assert(queries <= 240, `edge queries ${queries} exceed D+2N+20=240`);
    assertEquals(totalLoads, 10);
  });
});

Deno.test('edge cache: room and global LRU caps, commit-only touches, and owner isolation', () => {
  const cache = new EdgeCache(2, 3);
  const owner = {}, other = {};
  const fill = (room: string, id: string) => {
    const tx = cache.attempt(owner, room, cache.cutoff());
    tx.set(id, 'auth', [id + '-auth']);
    tx.set(id, 'prev', []);
    tx.commit();
  };
  const read = (room: string, id: string) =>
    cache.attempt(owner, room, cache.cutoff()).get(id, 'auth');
  fill('r', 'a');
  fill('r', 'b');
  const snapshot = cache.attempt(owner, 'r', cache.cutoff());
  // An abandoned attempt's read of a must not change LRU order.
  assertEquals(read('r', 'a'), ['a-auth']);
  fill('r', 'c');
  assertEquals(read('r', 'a'), undefined);
  const touch = cache.attempt(owner, 'r', cache.cutoff());
  assertEquals(touch.get('b', 'auth'), ['b-auth']);
  touch.commit();
  assertEquals(snapshot.get('b', 'auth'), ['b-auth']);
  fill('r', 'd');
  assertEquals(read('r', 'c'), undefined);
  fill('s', 'a');
  fill('t', 'a');
  assertEquals(read('r', 'b'), undefined); // global oldest
  assertEquals(read('r', 'd'), ['d-auth']);
  assertEquals(read('s', 'a'), ['a-auth']);
  assertEquals(
    cache.attempt(other, 's', cache.cutoff()).get('a', 'auth'),
    undefined,
  );
  const old = cache.attempt(owner, 'u', cache.cutoff());
  fill('u', 'late');
  assertEquals(old.get('late', 'auth'), undefined);
});

Deno.test('edge cache: cache fills from rows and inserts, preserves edge order and returns defensive copies', async () => {
  await withStore(async (store) => {
    const room = await openRoom(store, '!rows:test', { create: true });
    const db = await store.room(room.id);
    await db.tx(async (conn) => {
      await insertEvent(conn, '$row', raw(['$z', '$a'], ['$a', '$z']));
      await insertEvent(conn, '$leaf', raw([]));
    });
    await room.tx(async (tx) => {
      await tx.events.get('$row');
      await tx.events.list(['$leaf']);
    });
    await room.tx((tx) => tx.events.insert('$insert', raw(['$row'])));
    const queries = await countEdges(async () => {
      const reopened = await openRoom(store, room.id);
      await reopened.tx(async (tx) => {
        const ids = await tx.events.authsOf('$row');
        assertEquals(ids, ['$z', '$a']);
        ids.reverse();
        assertEquals(await tx.events.authsOf('$row'), ['$z', '$a']);
        assertEquals(await tx.events.prevsOf('$row'), ['$a', '$z']);
        assertEquals(await tx.events.authsOf('$leaf'), []);
        assertEquals(await tx.events.authsOf('$insert'), ['$row']);
      });
    });
    assertEquals(queries, 0);
  });
});

Deno.test('edge cache: concurrent cache commits do not leak new events into an older MVCC snapshot', async () => {
  await withStore(async (store) => {
    const room = await openRoom(store, '!snapshot:test', { create: true });
    await room.tx((tx) => tx.events.insert('$anchor', raw([])));
    let started!: () => void, resume!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const old = room.tx(async (tx) => {
      await tx.events.get('$anchor');
      started();
      await wait;
      assertEquals(await tx.events.get('$late'), null);
      assertEquals(await tx.events.authClosure(['$late'], 100), {
        ids: ['$late'],
        truncated: false,
      });
    });
    await ready;
    try {
      await room.tx((tx) => tx.events.insert('$late', raw(['$new-auth'])));
    } finally {
      resume();
    }
    await old;
    await room.tx(async (tx) =>
      assertEquals(await tx.events.authsOf('$late'), ['$new-auth'])
    );
  });
});

Deno.test('edge cache: cached graph never freezes standing or grounding across reads and transactions', async () => {
  await withStore(async (store) => {
    const room = await openRoom(store, '!status:test', { create: true });
    await room.tx(async (tx) => {
      await tx.events.insert('$e', raw([]));
      await tx.events.setStatus('$e', {
        standing: 'rejected',
        grounding: 'pending',
        origin: null,
        received_ts: 1,
      });
    });
    await room.tx(async (tx) => {
      assertEquals(
        (await loadRulebookStore(tx, ['$e'])).isRejected('$e'),
        true,
      );
      await tx.events.setStatus('$e', {
        standing: 'accepted',
        grounding: 'grounded',
        origin: null,
        received_ts: 2,
      });
      assertEquals(
        (await loadRulebookStore(tx, ['$e'])).isRejected('$e'),
        false,
      );
      assertEquals((await tx.events.getStatus('$e'))?.grounding, 'grounded');
    });
    await room.tx(async (tx) => {
      assertEquals(
        (await loadRulebookStore(tx, ['$e'])).isRejected('$e'),
        false,
      );
      await tx.events.setStatus('$e', {
        standing: 'rejected',
        grounding: 'evidence',
        origin: null,
        received_ts: 3,
      });
    });
    await room.tx(async (tx) => {
      assertEquals(
        (await loadRulebookStore(tx, ['$e'])).isRejected('$e'),
        true,
      );
      assertEquals(
        (await tx.events.statuses(['$e'])).get('$e')?.grounding,
        'evidence',
      );
    });
  });
});

Deno.test('edge cache: cached reads preserve the transaction capability lifetime after commit and rollback', async () => {
  await withStore(async (store) => {
    const room = await openRoom(store, '!lifetime:test', { create: true });
    let escaped!: RoomTx;
    await room.tx(async (tx) => {
      await tx.events.insert('$cached', raw([]));
      escaped = tx;
    });
    const check = async () => {
      await assertRejects(
        () => escaped.events.authsOf('$cached'),
        Error,
        'released',
      );
      await assertRejects(
        () => escaped.events.prevsOf('$cached'),
        Error,
        'released',
      );
      await assertRejects(
        () => escaped.events.authClosure(['$cached'], 100),
        Error,
        'released',
      );
      await assertRejects(
        () => escaped.events.ancestors(['$cached'], [], 100),
        Error,
        'released',
      );
    };
    await check();
    await assertRejects(
      () =>
        room.tx(async (tx) => {
          await tx.events.authsOf('$cached');
          escaped = tx;
          throw new Error('abort');
        }),
      Error,
      'abort',
    );
    await check();
  });
});

Deno.test('edge cache: cold frontiers query only misses in 500-id chunks, including zero-edge leaves', async () => {
  await withStore(async (store) => {
    const room = await openRoom(store, '!chunks:test', { create: true });
    const db = await store.room(room.id);
    const leaves = Array.from({ length: 501 }, (_, i) => '$leaf' + i);
    await db.tx(async (conn) => {
      for (const id of leaves) await insertEvent(conn, id, raw([]));
      await insertEvent(conn, '$root', raw(leaves));
    });
    const expected = await db.tx((conn) => authClosure(conn, ['$root'], 1000));
    const read = async () => {
      await room.tx(async (tx) =>
        assertEquals(await tx.events.authClosure(['$root'], 1000), expected)
      );
    };
    assertEquals(await countEdges(read), 3);
    assertEquals(await countEdges(read), 0);
  });
});

Deno.test('edge cache: publication reuses the closure with the same guard including its new event and missing ids', () => {
  const a = JSON.parse(raw(['$b'])) as Pdu;
  const b = JSON.parse(raw(['$missing'])) as Pdu;
  const next = JSON.parse(raw(['$a'])) as Pdu;
  const pdus = new Map([['$a', a], ['$b', b]]);
  const store = {
    get: (id: string) => pdus.get(id),
    isRejected: (id: string) => id === '$b' || id === '$new',
  };
  const extended = withRulebookEvent(store, '$new', next, ['$new'], 4);
  assertEquals(extended.get('$new'), next);
  assertEquals(extended.isRejected('$new'), false);
  assertEquals(extended.isRejected('$b'), true);
  assertThrows(
    () => withRulebookEvent(store, '$new', next, ['$new'], 3),
    Error,
    'E_AUTH_CLOSURE',
  );
  // Unrelated authorization seeds do not count toward publication's closure.
  withRulebookEvent(store, '$new', next, ['$b'], 2);
});

Deno.test('edge cache: rollback/retry discards inserted and read edges; missing ids are never negative-cached', async () => {
  await withStore(async (store) => {
    const room = await openRoom(store, '!rollback:test', { create: true });
    const db = await store.room(room.id);
    await db.tx((conn) => insertEvent(conn, '$read', raw(['$parent'])));
    const abort = async (retry: boolean) => {
      let attempts = 0;
      await room.tx(async (tx) => {
        if (++attempts === 1) {
          await tx.events.insert('$aborted', raw(['$ghost']));
          await tx.events.authClosure(['$read', '$aborted'], 100);
          throw retry
            ? new StoreError(517, 'snapshot conflict', 'BusySnapshot')
            : new Error('abort');
        }
      });
      assertEquals(attempts, 2);
    };
    await assertRejects(() => abort(false), Error, 'abort');
    await abort(true);
    // Reading an existing edge in a failed attempt must not warm the cache.
    assert(
      (await countEdges(async () => {
        await room.tx(async (tx) => {
          assertEquals(await tx.events.authClosure(['$aborted'], 100), {
            ids: ['$aborted'],
            truncated: false,
          });
          assertEquals(await tx.events.authsOf('$read'), ['$parent']);
        });
      })) >= 2,
    );
    await room.tx((tx) => tx.events.insert('$aborted', raw(['$real'])));
    await room.tx(async (tx) => {
      assertEquals(await tx.events.authsOf('$aborted'), ['$real']);
      assertEquals(await tx.events.prevsOf('$aborted'), ['$real']);
    });
  });
});

Deno.test('edge cache: cached and uncached walks agree on order, stops, truncation and unknown arrival', async () => {
  await withStore(async (store) => {
    const room = await openRoom(store, '!walk:test', { create: true });
    await room.tx(async (tx) => {
      await tx.events.insert('$a', raw(['$c', '$b'], ['$b', '$c']));
      await tx.events.insert('$b', raw(['$d']));
      await tx.events.insert('$c', raw(['$b', '$missing']));
      await tx.events.insert('$d', raw([]));
    });
    const db = await store.room(room.id);
    for (const limit of [1, 2, 4, 100000]) {
      for (const stops of [[], ['$b']]) {
        const expected = await db.tx(async (conn) => ({
          auth: await authClosure(conn, ['$a'], limit),
          prev: await ancestors(conn, ['$a'], stops, limit),
        }));
        await room.tx(async (tx) => {
          assertEquals(
            await tx.events.authClosure(['$a'], limit),
            expected.auth,
          );
          assertEquals(
            await tx.events.ancestors(['$a'], stops, limit),
            expected.prev,
          );
        });
      }
    }
    await room.tx((tx) => tx.events.insert('$missing', raw(['$later'])));
    await room.tx(async (tx) =>
      assert((await tx.events.authClosure(['$a'], 100)).ids.includes('$later'))
    );
  });
});
