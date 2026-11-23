import { assertEquals, assertRejects } from '@std/assert';
import { setImmediate } from 'node:timers/promises';
import { cp } from 'node:fs/promises';
import { openStore, type Store } from '#engine/store/index.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import {
  onProjected,
  project,
  projectThrough,
  publishThrough,
  sourceOf,
  withProjectionLock,
} from '#engine/server/project.ts';
import { get } from '#engine/store/watermark.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { setReceipt } from '#engine/server/ephemeral.ts';
import { finishRoomRemoval } from '#engine/server/removal.ts';
import { advanceNotificationRead } from '#engine/server/notifications.ts';
import { bobJoins, genesis } from '#tests/fixtures/genesis.ts';

async function fixture(
  fn: (store: Store, rooms: {
    g: Awaited<ReturnType<typeof genesis>>;
    event: Awaited<ReturnType<typeof sendLocal>>;
  }[], dir: string) => Promise<void>,
  variant: 'plain' | 'relation' | 'membership' | 'reference' | 'many' = 'plain',
) {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 16,
    idleseconds: 300,
  }, {
    schemas: { room: roomSchema, server: serverSchema, tenant: tenantSchema },
  });
  try {
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('dev', 'Dev');
      await tx.users.insert('bob', 'Bob');
      if (variant === 'many') await tx.users.insert('charlie', 'Charlie');
    });
    const rooms = [];
    for (let n = 0; n < 2; n++) {
      const g = await genesis(store, {
        roomId: `!publication-batch-${n}:test`,
      });
      await bobJoins(g);
      await bobJoins(g, '@charlie:remote.test', 2000);
      if (variant === 'many') await bobJoins(g, '@charlie:test', 3000);
      await sendLocal(g.room, {
        type: 'm.room.message',
        sender: '@bob:test',
        content: { body: 'earlier unread', msgtype: 'm.text' },
      }, g.signer);
      await project(store, g.roomId);
      const event = await sendLocal(g.room, {
        type: variant === 'membership' ? 'm.room.member' : 'm.room.message',
        sender: g.creator,
        ...(variant === 'membership' ? { state_key: '@bob:test' } : {}),
        content: variant === 'membership' ? { membership: 'leave' } : {
          body: `batch ${n}`,
          msgtype: 'm.text',
          ...(variant === 'relation'
            ? { 'm.relates_to': { rel_type: 'm.thread', event_id: g.tipId } }
            : {}),
        },
      }, g.signer);
      rooms.push({ g, event });
    }
    await fn(store, rooms, dir);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

type TestRooms = Parameters<Parameters<typeof fixture>[0]>[1];

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('publication request stalled')),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Admit both fixed cuts before capture while the real writer is held. The
// larger first request selects one shared page covering the smaller request.
async function sharedCuts(
  store: Store,
  room: TestRooms[number],
  first: () => Promise<void>,
  observe: (small: Promise<void>, large: Promise<void>) => Promise<void>,
) {
  const originalRoom = store.room.bind(store);
  const prepared = Promise.withResolvers<void>();
  store.room = async (...args) => {
    const db = await originalRoom(...args);
    if (args[0] !== room.g.roomId) return db;
    return {
      ...db,
      tx: async (fn, options) => {
        const value = await db.tx(fn, options);
        if (isPreparedResult(value)) prepared.resolve();
        return value;
      },
    };
  };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const held = withProjectionLock(store, async () => {
    entered.resolve();
    await release.promise;
  });
  const jobs: Promise<void>[] = [];
  try {
    await bounded(entered.promise);
    const large = first();
    void large.catch(() => {});
    jobs.push(large);
    const small = projectThrough(store, room.event.completion!);
    void small.catch(() => {});
    jobs.push(small);
    await bounded(Promise.race([
      prepared.promise,
      large.then(() => {
        throw new Error('projection settled before preparation');
      }),
    ]));
    await setImmediate();
    release.resolve();
    await held;
    await observe(small, large);
  } finally {
    release.resolve();
    await held;
    await Promise.allSettled(jobs);
    store.room = originalRoom;
  }
}

Deno.test('publication batching review: pending progress belongs only to its request', async () => {
  await fixture(async (store, rooms) => {
    const room = rooms[0];
    const next = await sendLocal(room.g.room, {
      type: 'm.room.message',
      sender: room.g.creator,
      content: { body: 'larger progress cut', msgtype: 'm.text' },
    }, room.g.signer);
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let pending = false;
    try {
      await sharedCuts(
        store,
        room,
        () =>
          publishThrough(store, next.completion!, async () => {
            entered.resolve();
            await release.promise;
          }),
        async (small, large) => {
          void large.finally(() => {
            pending = false;
          }).catch(() => {});
          pending = true;
          try {
            await bounded(entered.promise);
            await bounded(small);
            assertEquals(
              pending,
              true,
              'larger callback still owns its settlement',
            );
            const later = await sendLocal(room.g.room, {
              type: 'm.room.message',
              sender: room.g.creator,
              content: { body: 'worker continues', msgtype: 'm.text' },
            }, room.g.signer);
            await bounded(projectThrough(store, later.completion!));
          } finally {
            release.resolve();
          }
        },
      );
    } finally {
      release.resolve();
    }
  });
});

Deno.test('publication batching review: a failing shared suffix preserves the smaller cut', async () => {
  await fixture(async (store, rooms) => {
    const room = rooms[0];
    const next = await sendLocal(room.g.room, {
      type: 'm.room.message',
      sender: room.g.creator,
      content: { body: 'failing later cut', msgtype: 'm.text' },
    }, room.g.signer);
    const server = await store.server();
    const original = server.tx.bind(server);
    let rollbacks = 0;
    server.tx = (fn, options) =>
      original(async (tx) => {
        const value = await fn(tx);
        if (
          (await tx.query('SELECT event FROM feed WHERE event=?', [
            next.eventId,
          ])).length
        ) {
          rollbacks++;
          throw new Error('permanent later-cut failure');
        }
        return value;
      }, options);
    try {
      await sharedCuts(
        store,
        room,
        () => projectThrough(store, next.completion!),
        async (small, large) => {
          const result = await bounded(Promise.allSettled([small, large]));
          assertEquals(result.map((r) => r.status), ['fulfilled', 'rejected']);
          assertEquals(
            await get(server, sourceOf(room.g.roomId)),
            room.event.completion!.through,
          );
          assertEquals(
            (await server.query(
              'SELECT event FROM feed WHERE event IN (?,?) ORDER BY seq',
              [room.event.eventId, next.eventId],
            )).map((r) => r.event),
            [room.event.eventId],
          );
          assertEquals(
            rollbacks > 0,
            true,
            'shared transaction really rolled back',
          );
        },
      );
    } finally {
      server.tx = original;
    }
    await projectThrough(store, next.completion!);
    assertEquals(
      (await server.query(
        'SELECT event FROM feed WHERE event IN (?,?) ORDER BY seq',
        [room.event.eventId, next.eventId],
      )).map((r) => r.event),
      [room.event.eventId, next.eventId],
    );
  });
});

function isPreparedResult(value: unknown): boolean {
  const result =
    value !== null && typeof value === 'object' && 'result' in value
      ? value.result
      : undefined;
  return (Array.isArray(result) && result.length > 0 &&
    result.every((entry) =>
      entry !== null && typeof entry === 'object' && 'index' in entry &&
      'publication' in entry
    )) ||
    (result !== null && typeof result === 'object' && 'prepared' in result &&
      'publications' in result && Array.isArray(result.publications) &&
      result.publications.length === 0);
}

// The same causal native-preparation observation as the queue fixture above.
// Holding the real owner, not racing a timer, makes every supplied unit ready.
async function together(
  store: Store,
  rooms: TestRooms,
  beforeRelease: () => Promise<void> = () => Promise.resolve(),
  between: (at: number) => Promise<void> = () => Promise.resolve(),
): Promise<PromiseSettledResult<void>[]> {
  const originalRoom = store.room.bind(store);
  const ready = rooms.map(() => Promise.withResolvers<void>());
  store.room = async (...args) => {
    const db = await originalRoom(...args);
    const index = rooms.findIndex(({ g }) => g.roomId === args[0]);
    if (index < 0) return db;
    return {
      ...db,
      tx: async (fn, options) => {
        const value = await db.tx(fn, options);
        const result =
          value !== null && typeof value === 'object' && 'result' in value
            ? value.result
            : undefined;
        if (
          (Array.isArray(result) && result.length &&
            result.every((entry) =>
              entry !== null && typeof entry === 'object' && 'index' in entry &&
              'publication' in entry
            )) ||
          (result !== null && typeof result === 'object' &&
            'prepared' in result && 'publications' in result &&
            Array.isArray(result.publications) &&
            result.publications.length === 0)
        ) ready[index].resolve();
        return value;
      },
    };
  };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const held = withProjectionLock(store, async () => {
    entered.resolve();
    await release.promise;
  });
  const jobs: Promise<void>[] = [];
  try {
    await entered.promise;
    for (let at = 0; at < rooms.length; at++) {
      await between(at);
      const job = projectThrough(store, rooms[at].event.completion!);
      void job.catch(() => {});
      jobs.push(job);
      await Promise.race([ready[at].promise, job]);
      await setImmediate();
    }
    await beforeRelease();
    release.resolve();
    await held;
    return await Promise.allSettled(jobs);
  } finally {
    release.resolve();
    await held;
    await Promise.allSettled(jobs);
    store.room = originalRoom;
  }
}

async function durableTables(store: Store) {
  const server = await store.server();
  const tables = await server.query(
    // MVCC transaction timestamps describe the native commit history, which
    // batching intentionally changes; they are not an application-owned table.
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'__turso_internal_mvcc_meta' ORDER BY name",
  );
  const result: Record<string, string[]> = {};
  for (const { name } of tables) {
    result[String(name)] = (await server.query(
      `SELECT * FROM "${String(name).replaceAll('"', '""')}"`,
    )).map((row) => JSON.stringify(row)).sort();
  }
  return result;
}

for (const changes of [35, 335]) {
  Deno.test(`publication batching: a contended ${changes}-change same-room ready prefix takes one commit`, async () => {
    await fixture(async (store, rooms) => {
      const { g } = rooms[0];
      const expectedByRoom: string[][] = [];
      // Two change rows per live message (event plus its delivery effect),
      // and one standalone signature intent reproduce the odd 335-row page.
      for (const room of rooms) {
        const expected = [room.event.eventId];
        expectedByRoom.push(expected);
        await room.g.room.tx((tx) =>
          tx.changes.append('signature', room.g.tipId, {})
        );
        for (let at = 0; at < (changes - 3) / 2; at++) {
          const event = await sendLocal(room.g.room, {
            type: 'm.room.message',
            sender: at % 2 ? '@bob:test' : room.g.creator,
            content: { body: `prefix ${at}`, msgtype: 'm.text' },
          }, room.g.signer);
          room.event = event;
          expected.push(event.eventId);
        }
      }
      const expected = expectedByRoom[0];
      const server = await store.server();
      const mark = await get(server, sourceOf(g.roomId));
      assertEquals(rooms[0].event.completion!.through - mark, changes);
      const original = server.tx.bind(server);
      const commits: string[][] = [];
      server.tx = async (fn, options) => {
        const committed = await original(async (tx) => {
          const execute = tx.execute.bind(tx);
          let publishes = false;
          tx.execute = (sql, values) => {
            if (sql.includes('INSERT INTO feed')) publishes = true;
            return execute(sql, values);
          };
          const value = await fn(tx);
          const published = publishes
            ? (await tx.query(
              'SELECT event FROM feed WHERE room=? AND pos>? ORDER BY seq',
              [g.roomId, mark],
            )).map((row) => String(row.event))
            : null;
          if (publishes) {
            assertEquals(
              (await tx.query(
                'SELECT event FROM feed WHERE room=? AND event IN (SELECT CAST(value AS TEXT) FROM json_each(?)) ORDER BY seq',
                [rooms[1].g.roomId, JSON.stringify(expectedByRoom[1])],
              )).map((row) => row.event),
              expectedByRoom[1],
              'every already-ready room progresses in this same commit',
            );
          }
          return { value, published };
        }, options);
        if (committed.published !== null) commits.push(committed.published);
        return committed.value;
      };
      try {
        assertEquals((await together(store, rooms)).map((r) => r.status), [
          'fulfilled',
          'fulfilled',
        ]);
        assertEquals(
          commits.length,
          1,
          'commit turns must not scale with ready units',
        );
        assertEquals(
          commits[0],
          expected,
          'the first group includes the whole ready prefix',
        );
        assertEquals(
          (await server.query('SELECT event FROM feed WHERE event=?', [
            rooms[1].event.eventId,
          ])).length,
          1,
          'the other ready room progresses in the same group',
        );
        const beforeReplay = commits.length;
        await Promise.all(
          rooms.map(({ event }) => projectThrough(store, event.completion!)),
        );
        assertEquals(
          commits.length,
          beforeReplay,
          'replay publishes no duplicate feed rows',
        );
        assertEquals(
          (await server.query(
            'SELECT event FROM feed WHERE room=? AND pos>? ORDER BY seq',
            [
              g.roomId,
              mark,
            ],
          )).map((row) => row.event),
          expected,
        );
      } finally {
        server.tx = original;
      }
    });
  });
}

Deno.test('publication batching: fixed-cut callers share ready preparation, not callback completion', async () => {
  await fixture(async (store, rooms) => {
    const originalRoom = store.room.bind(store);
    const captures = new Map<string, number>();
    store.room = async (...args) => {
      const db = await originalRoom(...args);
      return {
        ...db,
        tx: async (fn, options) => {
          const value = await db.tx(fn, options);
          if (isPreparedResult(value)) {
            captures.set(args[0], (captures.get(args[0]) ?? 0) + 1);
          }
          return value;
        },
      };
    };
    const duplicates: Promise<void>[] = [];
    try {
      const result = await together(store, rooms, async () => {
        for (const { event } of rooms) {
          duplicates.push(projectThrough(store, event.completion!));
          duplicates.push(projectThrough(store, event.completion!));
        }
        await setImmediate();
      });
      await Promise.all(duplicates);
      assertEquals(
        result.map((r) => r.status),
        ['fulfilled', 'fulfilled'],
      );
      assertEquals(rooms.map(({ g }) => captures.get(g.roomId)), [1, 1]);
    } finally {
      await Promise.allSettled(duplicates);
      store.room = originalRoom;
    }

    const { g } = rooms[0];
    const first = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'held callback', msgtype: 'm.text' },
    }, g.signer);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stop = onProjected(async (candidate, roomId, through) => {
      if (
        candidate === store && roomId === g.roomId &&
        through === first.completion!.through
      ) {
        entered.resolve();
        await release.promise;
      }
    });
    const pending = projectThrough(store, first.completion!);
    try {
      await entered.promise;
      const next = await sendLocal(g.room, {
        type: 'm.room.message',
        sender: g.creator,
        content: { body: 'later fixed cut', msgtype: 'm.text' },
      }, g.signer);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          projectThrough(store, next.completion!),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('callback retained room preparation')),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      assertEquals(
        (await (await store.server()).query(
          'SELECT event FROM feed WHERE event=?',
          [next.eventId],
        )).length,
        1,
      );
    } finally {
      release.resolve();
      await pending;
      stop();
    }
  });
});

Deno.test('publication batching: a single ready unit uses set-wise notification work with identical durable facts', async () => {
  await fixture(async (baseline, rooms, dir) => {
    const tenant = await openTenant(baseline, 'test');
    await tenant.tx(async (tx) => {
      for (const user of ['dev', 'bob']) {
        await tx.pushers.upsert(user, {
          app_id: 'single-app',
          pushkey: 'key-' + user,
          kind: 'http',
          app_display_name: 'Test',
          device_display_name: 'Test',
          lang: 'en',
          data: { url: 'https://push.example/_matrix/push/v1/notify' },
        }, 'test-access-hash');
      }
    });
    await projectTenant(baseline, 'test');
    await baseline.close();
    const now = Date.now;
    Date.now = () => 1800000000000;
    const results = [];
    const work = [];
    try {
      for (const ordered of [true, false]) {
        const copy = dir + (ordered ? '-ordered-one' : '-set-one');
        await cp(dir, copy, { recursive: true });
        const store = await openStore({
          dir: copy,
          library: './.native/libturso_ffi.so',
          checkpointlogbytes: 65536,
          maxopenfiles: 16,
          idleseconds: 300,
        }, {
          schemas: {
            room: roomSchema,
            server: serverSchema,
            tenant: tenantSchema,
          },
        });
        try {
          const db = await store.server();
          const original = db.tx.bind(db);
          const statements: string[] = [];
          db.tx = (fn, options) =>
            original(async (tx) => {
              const query = tx.query.bind(tx);
              const execute = tx.execute.bind(tx);
              tx.query = (sql, values) => {
                statements.push(sql);
                // Force only the existing dependency fallback, without changing
                // any durable fact, to retain an independent ordered oracle.
                if (
                  ordered &&
                  sql.startsWith(
                    'SELECT 1 FROM json_each(?) j JOIN event_index i',
                  )
                ) {
                  return Promise.resolve([{ '1': 1 }]);
                }
                return query(sql, values);
              };
              tx.execute = (sql, values) => {
                statements.push(sql);
                return execute(sql, values);
              };
              return await fn(tx);
            }, options);
          await projectThrough(store, rooms[0].event.completion!);
          work.push(
            statements.filter((sql) =>
              sql.includes('INSERT INTO push_evaluations')
            ).length,
          );
          results.push(await durableTables(store));
          assertEquals(
            (await db.query('SELECT event FROM feed WHERE event=?', [
              rooms[0].event.eventId,
            ])).length,
            1,
          );
          const beforeReplay = statements.length;
          await projectThrough(store, rooms[0].event.completion!);
          assertEquals(
            statements.slice(beforeReplay).filter((sql) =>
              sql.includes('INSERT INTO push_evaluations')
            ).length,
            0,
          );
        } finally {
          await store.close();
          await Deno.remove(copy, { recursive: true });
        }
      }
      assertEquals(
        results[1],
        results[0],
        'all durable server tables match ordered application, including notification sequences and badges',
      );
      assertEquals(
        work[1],
        1,
        'one notification evaluation statement per ready unit, not per recipient',
      );
      assertEquals(
        work[0] > work[1],
        true,
        'the ordered control exercises recipient-proportional SQL',
      );
    } finally {
      Date.now = now;
    }
  }, 'many');
});

for (
  const variant of ['plain', 'relation', 'membership', 'reference'] as const
) {
  Deno.test(`publication batching: ${variant} durable tables equal the individual FIFO path`, async () => {
    await fixture(async (baseline, rooms, dir) => {
      // Seed real active push targets and old unread facts in both rooms. This
      // exercises negative implicit-read deltas and shared recipient badge order.
      const tenant = await openTenant(baseline, 'test');
      await tenant.tx(async (tx) => {
        for (const user of ['dev', 'bob']) {
          await tx.pushers.upsert(user, {
            app_id: 'batch-app',
            pushkey: 'key-' + user,
            kind: 'http',
            app_display_name: 'Test',
            device_display_name: 'Test',
            lang: 'en',
            data: { url: 'https://push.example/_matrix/push/v1/notify' },
          }, 'test-access-hash');
        }
      });
      await projectTenant(baseline, 'test');
      for (const { g } of rooms) {
        await setReceipt(
          await baseline.server(),
          g.roomId,
          '@bob:test',
          'm.read',
          g.tipId,
        );
      }
      if (variant === 'reference') {
        await (await baseline.server()).tx(async (tx) => {
          for (const { event } of rooms) {
            await advanceNotificationRead(
              tx,
              '@bob:test',
              '!wrong-room:test',
              '',
              event.eventId,
              Date.now(),
            );
          }
        });
      }
      await baseline.close();
      const now = Date.now;
      Date.now = () => 1800000000000;
      const results = [];
      const graphWrites: number[] = [];
      try {
        for (const grouped of [false, true]) {
          const copy = dir + (grouped ? '-group' : '-single');
          await Deno.mkdir(copy);
          await cp(dir, copy, { recursive: true });
          const store = await openStore({
            dir: copy,
            library: './.native/libturso_ffi.so',
            checkpointlogbytes: 65536,
            maxopenfiles: 16,
            idleseconds: 300,
          }, {
            schemas: {
              room: roomSchema,
              server: serverSchema,
              tenant: tenantSchema,
            },
          });
          try {
            const db = await store.server();
            const original = db.tx.bind(db);
            let writes = 0;
            db.tx = (fn, options) =>
              original(async (tx) => {
                const execute = tx.execute.bind(tx);
                tx.execute = (sql, values) => {
                  if (sql.includes('INSERT INTO receipt_dag_nodes')) writes++;
                  return execute(sql, values);
                };
                return await fn(tx);
              }, options);
            if (grouped) {
              assertEquals(
                (await together(store, rooms)).map((r) => r.status),
                [
                  'fulfilled',
                  'fulfilled',
                ],
              );
            } else {for (const { event } of rooms) {
                await projectThrough(store, event.completion!);
              }}
            graphWrites.push(writes);
            results.push(await durableTables(store));
          } finally {
            await store.close();
            await Deno.remove(copy, { recursive: true });
          }
        }
        assertEquals(
          results[1],
          results[0],
          'every durable server table, including allocators, matches individual FIFO application',
        );
        assertEquals(
          graphWrites,
          variant === 'plain' ? [2, 1] : [2, 2],
          'the owner applies independent graph facts with one native statement',
        );
      } finally {
        Date.now = now;
      }
    }, variant);
  });
}

Deno.test('publication batching: same-room dependent effects equal ordered unit commits', async () => {
  await fixture(async (baseline, rooms, dir) => {
    const { g, event } = rooms[0];
    const events = [event];
    events.push(
      await sendLocal(g.room, {
        type: 'm.room.message',
        sender: '@bob:test',
        content: {
          body: 'reply',
          msgtype: 'm.text',
          'm.relates_to': { rel_type: 'm.thread', event_id: event.eventId },
        },
      }, g.signer),
    );
    events.push(
      await sendLocal(g.room, {
        type: 'm.room.redaction',
        sender: g.creator,
        content: { redacts: events[1].eventId },
      }, g.signer),
    );
    events.push(
      await sendLocal(g.room, {
        type: 'm.room.member',
        sender: g.creator,
        state_key: '@bob:test',
        content: { membership: 'leave' },
      }, g.signer),
    );
    events.push(
      await sendLocal(g.room, {
        type: 'm.room.encryption',
        sender: g.creator,
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      }, g.signer),
    );
    await setReceipt(
      await baseline.server(),
      g.roomId,
      '@bob:test',
      'm.read',
      events[1].eventId,
    );
    await baseline.close();
    const now = Date.now;
    Date.now = () => 1800000000000;
    const results = [];
    try {
      for (const grouped of [false, true]) {
        const copy = dir +
          (grouped ? '-dependent-group' : '-dependent-ordered');
        await cp(dir, copy, { recursive: true });
        const store = await openStore({
          dir: copy,
          library: './.native/libturso_ffi.so',
          checkpointlogbytes: 65536,
          maxopenfiles: 16,
          idleseconds: 300,
        }, {
          schemas: {
            room: roomSchema,
            server: serverSchema,
            tenant: tenantSchema,
          },
        });
        try {
          if (grouped) await projectThrough(store, events.at(-1)!.completion!);
          else {for (const entry of events) {
              await projectThrough(store, entry.completion!);
            }}
          results.push(await durableTables(store));
          await projectThrough(store, events.at(-1)!.completion!);
          assertEquals(
            await durableTables(store),
            results.at(-1),
            'replay changes no durable dependent facts',
          );
        } finally {
          await store.close();
          await Deno.remove(copy, { recursive: true });
        }
      }
      assertEquals(
        results[1],
        results[0],
        'feed, receipts, notifications, redactions, relations, membership and device facts match the ordered baseline',
      );
    } finally {
      Date.now = now;
    }
  });
});

Deno.test('publication batching: rollback acknowledges nothing and isolates a permanently failing room without consuming sequences', async () => {
  await fixture(async (store, rooms) => {
    const server = await store.server();
    const original = server.tx.bind(server);
    const ids = rooms.map((r) => r.event.eventId);
    const mark = await get(server, sourceOf(rooms[0].g.roomId));
    const priorSeq = Number(
      (await server.query("SELECT value FROM counters WHERE name='events'"))[0]
        .value,
    );
    let groupedRollback = false;
    let individualSawCleanRollback = false;
    const callbacks: string[] = [];
    const unlisten = onProjected((owner, roomId) => {
      if (owner === store) callbacks.push(roomId);
    });
    server.tx = (fn, options) =>
      original(async (tx) => {
        const before = await tx.query(
          'SELECT event FROM feed WHERE event IN (?,?)',
          ids,
        );
        if (groupedRollback && !before.length) {
          individualSawCleanRollback = true;
          assertEquals(
            Number(
              (await tx.query(
                "SELECT value FROM counters WHERE name='events'",
              ))[0].value,
            ),
            priorSeq,
          );
          assertEquals(
            Number(
              (await tx.query(
                'SELECT position FROM watermarks WHERE source=?',
                [sourceOf(rooms[0].g.roomId)],
              ))[0].position,
            ),
            mark,
          );
          assertEquals(callbacks, []);
        }
        const value = await fn(tx);
        const after = await tx.query(
          'SELECT event FROM feed WHERE event IN (?,?)',
          ids,
        );
        if (after.length === 2 && !before.length) groupedRollback = true;
        if (after.some((row) => row.event === ids[0])) {
          throw new Error('permanent failing publication');
        }
        return value;
      }, options);
    try {
      const result = await together(store, rooms);
      assertEquals(result.map((r) => r.status), ['rejected', 'fulfilled']);
      assertEquals(groupedRollback, true);
      assertEquals(individualSawCleanRollback, true);
      assertEquals(
        await server.query(
          'SELECT event,seq FROM feed WHERE event IN (?,?)',
          ids,
        ),
        [{ event: ids[1], seq: priorSeq + 1 }],
      );
      assertEquals(await get(server, sourceOf(rooms[0].g.roomId)), mark);
      assertEquals(callbacks, [rooms[1].g.roomId]);
      await assertRejects(
        () => projectThrough(store, rooms[0].event.completion!),
        Error,
        'permanent failing publication',
      );
      server.tx = original;
      await projectThrough(store, rooms[0].event.completion!);
      assertEquals(
        (await server.query('SELECT seq FROM feed WHERE event=?', [ids[0]]))[0]
          .seq,
        priorSeq + 2,
      );
    } finally {
      server.tx = original;
      unlisten();
    }
  });
});

Deno.test('publication batching: later acceptance cannot enlarge either prepared room cut', async () => {
  await fixture(async (store, rooms) => {
    let later: Awaited<ReturnType<typeof sendLocal>> | undefined;
    const results = await together(store, rooms, async () => {
      later = await sendLocal(rooms[0].g.room, {
        type: 'm.room.message',
        sender: rooms[0].g.creator,
        content: { body: 'later', msgtype: 'm.text' },
      }, rooms[0].g.signer);
    });
    assertEquals(results.map((r) => r.status), ['fulfilled', 'fulfilled']);
    const server = await store.server();
    assertEquals(
      await server.query('SELECT event FROM feed WHERE event=?', [
        later!.eventId,
      ]),
      [],
    );
    for (const { g, event } of rooms) {
      assertEquals(
        await get(server, sourceOf(g.roomId)),
        event.completion!.through,
      );
    }
    await projectThrough(store, later!.completion!);
    assertEquals(
      (await server.query('SELECT event FROM feed WHERE event=?', [
        later!.eventId,
      ]))[0].event,
      later!.eventId,
    );
  });
});

Deno.test('publication batching: queued rooms capture policy after ready-room preparation', async () => {
  await fixture(async (store, rooms) => {
    const result = await together(store, rooms, async () => {
      const tenant = await openTenant(store, 'test');
      await tenant.tx((tx) => tx.users.markDeactivated('bob'));
    });
    assertEquals(result.map((r) => r.status), ['fulfilled', 'fulfilled']);
    const server = await store.server();
    assertEquals(
      await server.query(
        'SELECT event FROM push_evaluations WHERE user=? AND event IN (?,?)',
        [
          '@bob:test',
          ...rooms.map((r) => r.event.eventId),
        ],
      ),
      [],
    );
    assertEquals(
      await server.query(
        'SELECT event FROM notifications WHERE user=? AND event IN (?,?)',
        [
          '@bob:test',
          ...rooms.map((r) => r.event.eventId),
        ],
      ),
      [],
    );
  });
});

Deno.test('publication batching: lifecycle replacement fences a prepared generation and does not strand the earlier room', async () => {
  await fixture(async (store, rooms) => {
    let replacement: Promise<void> | undefined;
    const result = await together(store, rooms, undefined, (at) => {
      if (at !== 1) return Promise.resolve();
      replacement = withProjectionLock(store, async () => {
        await finishRoomRemoval(store, rooms[1].g.roomId, {
          why: 'batch generation fence',
          intents: [],
        }, null);
        await genesis(store, { roomId: rooms[1].g.roomId });
      });
      void replacement.catch(() => {});
      return Promise.resolve();
    });
    await replacement;
    assertEquals(result.map((r) => r.status), ['fulfilled', 'rejected']);
    const server = await store.server();
    assertEquals(
      await server.query('SELECT event FROM feed WHERE event=?', [
        rooms[1].event.eventId,
      ]),
      [],
    );
    assertEquals(
      await get(server, sourceOf(rooms[0].g.roomId)),
      rooms[0].event.completion!.through,
    );
    await project(store, rooms[1].g.roomId);
    assertEquals(
      await server.query('SELECT event FROM feed WHERE event=?', [
        rooms[1].event.eventId,
      ]),
      [],
    );
  });
});

Deno.test('publication batching: a different Store has an independent commit owner', async () => {
  await fixture(async (first, rooms) => {
    await fixture(async (second, others) => {
      const server = await first.server();
      const originalTx = server.tx.bind(server);
      const ids = rooms.map((r) => r.event.eventId);
      const commits: string[][] = [];
      server.tx = async (fn, options) => {
        const result = await originalTx(async (tx) => {
          const before = new Set(
            (await tx.query('SELECT event FROM feed WHERE event IN (?,?)', ids))
              .map((r) => String(r.event)),
          );
          const value = await fn(tx);
          const added = (await tx.query(
            'SELECT event FROM feed WHERE event IN (?,?) ORDER BY seq',
            ids,
          )).map((r) => String(r.event)).filter((id) => !before.has(id));
          return { value, added };
        }, options);
        if (result.added.length) commits.push(result.added);
        return result.value;
      };
      const originalRoom = second.room.bind(second);
      const prepared = Promise.withResolvers<void>();
      second.room = async (...args) => {
        const db = await originalRoom(...args);
        return {
          ...db,
          tx: async (fn, options) => {
            const value = await db.tx(fn, options);
            if (
              args[0] === others[0].g.roomId && isPreparedResult(value)
            ) prepared.resolve();
            return value;
          },
        };
      };
      let middle: Promise<void> | undefined;
      try {
        const result = await together(first, rooms, undefined, async (at) => {
          if (at !== 1) return;
          middle = projectThrough(second, others[0].event.completion!);
          void middle.catch(() => {});
          await Promise.race([prepared.promise, middle]);
          await setImmediate();
          // The first Store's real writer is still held. Another Store must
          // finish, not merely enqueue behind that unrelated owner's barrier.
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              middle,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(new Error('unrelated Store blocked publication')),
                  5000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        });
        await middle;
        assertEquals(result.map((r) => r.status), ['fulfilled', 'fulfilled']);
        assertEquals(commits, [ids]);
        assertEquals(
          await get(await second.server(), sourceOf(others[0].g.roomId)),
          others[0].event.completion!.through,
        );
      } finally {
        await Promise.allSettled(middle === undefined ? [] : [middle]);
        second.room = originalRoom;
        server.tx = originalTx;
      }
    });
  });
});

for (const lifecycle of [false, true]) {
  Deno.test(`publication batching: ready FIFO rooms ${lifecycle ? 'stop at a lifecycle boundary' : 'share one durable commit'}`, async () => {
    await fixture(async (store, rooms) => {
      const originalRoom = store.room.bind(store);
      const ready = rooms.map(() => Promise.withResolvers<void>());
      // Observe completion of preparation's final room snapshot, not a clock
      // delay or a policy capture moved outside its freshness boundary.
      store.room = async (...args) => {
        const db = await originalRoom(...args);
        const index = rooms.findIndex(({ g }) => g.roomId === args[0]);
        if (index < 0) return db;
        return {
          ...db,
          tx: async (fn, options) => {
            const value = await db.tx(fn, options);
            // Room.tx's storage callback owns its edge/cache commit envelope.
            const result = value !== null && typeof value === 'object' &&
                'result' in value
              ? value.result
              : undefined;
            const completedPublication = Array.isArray(result) &&
              result.length && result.every((entry) =>
                entry !== null && typeof entry === 'object' &&
                'index' in entry && 'publication' in entry
              );
            // Ordinary messages reuse unchanged publication membership and
            // therefore need no final membership hydration transaction.
            const unchangedPublication = result !== null &&
              typeof result === 'object' && 'prepared' in result &&
              'publications' in result && Array.isArray(result.publications) &&
              result.publications.length === 0;
            if (completedPublication || unchangedPublication) {
              ready[index].resolve();
            }
            return value;
          },
        };
      };
      const server = await store.server();
      const originalTx = server.tx.bind(server);
      const ids = rooms.map(({ event }) =>
        event.eventId
      );
      const select = 'SELECT event FROM feed WHERE event IN (?,?) ORDER BY seq';
      const committed: string[][] = [];
      // Observe committed facts through the connection, independent of whether
      // the implementation emits scalar INSERTs, JSON inputs or set-based SQL.
      server.tx = async (fn, options) => {
        const result = await originalTx(async (tx) => {
          const before = new Set(
            (await tx.query(select, ids)).map((r) => r.event),
          );
          const value = await fn(tx);
          const published = (await tx.query(select, ids)).map((r) =>
            String(r.event)
          )
            .filter((event) => !before.has(event));
          return { value, published };
        }, options);
        if (result.published.length) committed.push(result.published);
        return result.value;
      };
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const held = withProjectionLock(store, async () => {
        entered.resolve();
        await release.promise;
      });
      const jobs: Promise<void>[] = [];
      let atBoundary: string[] | undefined;
      try {
        await entered.promise;
        for (let index = 0; index < rooms.length; index++) {
          if (index === 1 && lifecycle) {
            jobs.push(withProjectionLock(store, async () => {
              atBoundary = (await server.query(select, ids)).map((r) =>
                String(r.event)
              );
            }));
          }
          jobs.push(projectThrough(store, rooms[index].event.completion!));
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              ready[index].promise,
              new Promise<never>((_, reject) => {
                // Broken-fixture deadlock guard only, not a readiness delay or
                // a product latency expectation. Finally releases the writer.
                timer = setTimeout(
                  () =>
                    reject(new Error('preparation observer did not complete')),
                  30000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
          // The final native preparation snapshot above has completed. Drain
          // its promise continuations through writer enqueue while the real
          // writer remains explicitly held; this is one event-loop checkpoint,
          // not a sleep whose duration decides product readiness.
          await setImmediate();
        }
        assertEquals(await server.query(select, ids), []);
        release.resolve();
        await held;
        await Promise.all(jobs);
        assertEquals(
          (await server.query(select, ids)).map((r) => r.event),
          ids,
          'the committed live stream retains FIFO event identities',
        );
        for (const { g, event } of rooms) {
          assertEquals(
            await get(server, sourceOf(g.roomId)),
            event.completion!.through,
          );
        }
        if (lifecycle) {
          assertEquals(
            atBoundary,
            [ids[0]],
            'lifecycle work cannot be crossed by a batch',
          );
          assertEquals(committed, [[ids[0]], [ids[1]]]);
        } else {
          assertEquals(
            committed,
            [ids],
            'independent already-ready rooms share one durable publication commit',
          );
        }
      } finally {
        release.resolve();
        await held;
        await Promise.allSettled(jobs);
        server.tx = originalTx;
        store.room = originalRoom;
      }
    });
  });
}
