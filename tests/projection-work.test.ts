import { assertEquals, assertRejects } from '@std/assert';
import { openStore, type Store } from '#engine/store/index.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import {
  onProjected,
  project,
  withProjectionLock,
} from '#engine/server/project.ts';
import { finishRoomRemoval } from '#engine/server/removal.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { bobJoins, genesis } from '#tests/fixtures/genesis.ts';
import { setTyping, typingIn } from '#engine/typing.ts';
import { observePublication } from '#tests/support/hold-publication.ts';
import { onEventStream } from '#engine/server/stream.ts';

async function withStore(fn: (store: Store) => Promise<void>) {
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
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

// Hold a real room read, not the server writer. The liveness guard below only
// terminates a broken test; it is not a product latency objective.
function holdEvent(
  store: Store,
  roomId: string,
  eventId: string,
  afterTransaction = false,
) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = store.room.bind(store);
  let held = false;
  store.room = async (...args) => {
    const db = await original(...args);
    if (args[0] !== roomId) return db;
    const tx = db.tx.bind(db);
    db.tx = async (fn, options) => {
      let selected = false;
      const result = await tx((conn) => {
        const query = conn.query.bind(conn);
        conn.query = async (sql, values = []) => {
          const rows = await query(sql, values);
          if (
            !held && sql.includes('FROM events') && values.includes(eventId)
          ) {
            held = true;
            selected = true;
            if (!afterTransaction) {
              entered.resolve();
              await release.promise;
            }
          }
          return rows;
        };
        return fn(conn);
      }, options);
      if (selected && afterTransaction) {
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    return db;
  };
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    restore: () => {
      store.room = original;
    },
  };
}

Deno.test('projection work: independent room publication does not wait for another room capture', async () => {
  await withStore(async (store) => {
    const slow = await genesis(store, { roomId: '!capture-slow:test' });
    const fast = await genesis(store, { roomId: '!capture-fast:test' });
    await project(store, slow.roomId);
    await project(store, fast.roomId);
    const write = async (g: typeof slow) =>
      await sendLocal(g.room, {
        type: 'm.room.message',
        sender: g.creator,
        content: { body: 'independent', msgtype: 'm.text' },
      }, g.signer);
    const a = await write(slow);
    const b = await write(fast);
    const hold = holdEvent(store, slow.roomId, a.eventId);
    const pending = project(store, slow.roomId);
    const jobs: Promise<void>[] = [pending];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await hold.entered;
      const independent = project(store, fast.roomId);
      jobs.push(independent);
      const finished = await Promise.race([
        independent.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 1000);
        }),
      ]);
      assertEquals(
        finished,
        true,
        'independent projection remained behind a held room read',
      );
      const db = await store.server();
      assertEquals(
        (await db.query('SELECT event FROM feed WHERE event=?', [b.eventId]))
          .map((r) => r.event),
        [b.eventId],
      );
    } finally {
      clearTimeout(timer);
      hold.release();
      await Promise.all(jobs);
      hold.restore();
    }
  });
});

Deno.test('projection work: queued same-room callers owe separate finite cuts in room order', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!capture-cuts:test' });
    await project(store, g.roomId);
    const write = (body: string) =>
      sendLocal(g.room, {
        type: 'm.room.message',
        sender: g.creator,
        content: { body, msgtype: 'm.text' },
      }, g.signer);
    const first = await write('first cut');
    const hold = holdEvent(store, g.roomId, first.eventId, true);
    const pending = project(store, g.roomId);
    const jobs = [pending];
    const observed = new Map<number, unknown[]>();
    const entered = Promise.withResolvers<void>();
    const allowRead = Promise.withResolvers<void>();
    let removeListener = () => {};
    let removeCommitListener = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await hold.entered;
      const second = await write('later cut');
      const db = await store.server();
      const firstCut = first.completion!.through;
      const secondCut = second.completion!.through;
      let commits = 0;
      removeCommitListener = onEventStream((path) => {
        if (path === db.path) commits++;
      });
      const callbacks: number[] = [];
      removeListener = onProjected(async (owner, id, through) => {
        if (owner === store && id === g.roomId) {
          callbacks.push(through);
          if (through === firstCut) {
            entered.resolve();
            await allowRead.promise;
          }
          // The callback carries a room cut, not a snapshot of the live feed.
          observed.set(
            through,
            (await db.query(
              'SELECT event FROM feed WHERE room=? AND pos<=? AND event IN (?,?) ORDER BY seq',
              [id, through, first.eventId, second.eventId],
            )).map((r) => r.event),
          );
        }
      });
      jobs.push(project(store, g.roomId));
      hold.release();
      await Promise.race([
        (async () => {
          await Promise.race([entered.promise, pending]);
          // Force the first callback to read after the second publication.
          await jobs[1];
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('later projection retained by callback')),
            5000,
          );
        }),
      ]);
      allowRead.resolve();
      await Promise.all(jobs);
      assertEquals(commits, 2, 'each admitted cut gets its own writer turn');
      assertEquals(callbacks.toSorted((a, b) => a - b), [
        firstCut,
        secondCut,
      ]);
      assertEquals(observed.get(firstCut), [first.eventId]);
      assertEquals(observed.get(secondCut), [first.eventId, second.eventId]);
    } finally {
      clearTimeout(timer);
      hold.release();
      allowRead.resolve();
      await Promise.allSettled(jobs);
      removeListener();
      removeCommitListener();
      hold.restore();
    }
  });
});

Deno.test('projection work: queued callers never inherit later room writes', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!admission-cut:test' });
    await project(store, g.roomId);
    const write = (body: string) =>
      sendLocal(g.room, {
        type: 'm.room.message',
        sender: g.creator,
        content: { body, msgtype: 'm.text' },
      }, g.signer);
    const first = await write('first owner');
    const firstHold = holdEvent(store, g.roomId, first.eventId, true);
    const jobs = [project(store, g.roomId)];
    let laterHold: ReturnType<typeof holdEvent> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let late: Awaited<ReturnType<typeof write>> | undefined;
    let invoked = false;
    const callbackWrite = Promise.withResolvers<void>();
    let unlisten = () => {};
    try {
      await firstHold.entered;
      const admitted = await write('queued callers own cut');
      unlisten = onProjected(async (owner, id) => {
        if (owner !== store || id !== g.roomId || invoked) return;
        invoked = true;
        late = await write('future write outside the queued callers cut');
        laterHold = holdEvent(store, g.roomId, late.eventId, true);
        callbackWrite.resolve();
      });
      const caller = project(store, g.roomId);
      jobs.push(caller);
      firstHold.release();
      const completed = await Promise.race([
        caller.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 30000);
        }),
      ]);
      assertEquals(
        completed,
        true,
        'queued projection inherited a later event and blocked in its capture',
      );
      assertEquals(invoked, true);
      // Callbacks no longer retain the room preparation owner. Wait for this
      // callback's own write before inspecting it, not for unrelated callers.
      await callbackWrite.promise;
      const server = await store.server();
      assertEquals(
        (await server.query(
          'SELECT event FROM feed WHERE event IN (?,?) ORDER BY seq',
          [admitted.eventId, late!.eventId],
        )).map((row) => row.event),
        [admitted.eventId],
      );
    } finally {
      clearTimeout(timer);
      firstHold.release();
      laterHold?.release();
      await Promise.all(jobs);
      laterHold?.restore();
      firstHold.restore();
      unlisten();
    }
    await project(store, g.roomId);
    const server = await store.server();
    assertEquals(
      (await server.query('SELECT event FROM feed WHERE event=?', [
        late!.eventId,
      ])).map((row) => row.event),
      [late!.eventId],
    );
  });
});

Deno.test('projection work: a live backlog releases the writer between complete capture pages', async () => {
  await withStore(async (store) => {
    const backlog = await genesis(store, { roomId: '!capture-backlog:test' });
    await bobJoins(backlog);
    const other = await genesis(store, {
      roomId: '!capture-between-pages:test',
    });
    await project(store, other.roomId);
    for (let i = 0; i < 300; i++) {
      await sendLocal(backlog.room, {
        type: 'm.room.message',
        sender: backlog.creator,
        content: { body: 'backlog ' + i, msgtype: 'm.text' },
      }, backlog.signer);
    }
    const changes = await backlog.room.tx((tx) => tx.changes.after(0, 1000));
    let pageEnd = 500;
    while (
      changes[pageEnd]?.event === changes[pageEnd - 1].event &&
      !['event', 'transition', 'history', 'drop'].includes(
        changes[pageEnd].kind,
      )
    ) pageEnd++;
    const secondPage = changes.slice(pageEnd).find((c) => c.kind === 'event')!;
    const event = await sendLocal(other.room, {
      type: 'm.room.message',
      sender: other.creator,
      content: { body: 'between pages', msgtype: 'm.text' },
    }, other.signer);
    const hold = holdEvent(store, backlog.roomId, secondPage.event!, true);
    const pending = project(store, backlog.roomId);
    try {
      await hold.entered;
      await project(store, other.roomId);
      const db = await store.server();
      assertEquals(
        (await db.query('SELECT position FROM watermarks WHERE source=?', [
          'room:' + backlog.roomId,
        ]))[0].position,
        changes[pageEnd - 1].pos,
      );
      assertEquals(
        (await db.query('SELECT event FROM feed WHERE event=?', [
          event.eventId,
        ])).map((r) => r.event),
        [event.eventId],
      );
      assertEquals(
        await db.query('SELECT event FROM feed WHERE event=?', [
          secondPage.event!,
        ]),
        [],
      );
      hold.release();
      await pending;
      assertEquals(
        (await db.query('SELECT position FROM watermarks WHERE source=?', [
          'room:' + backlog.roomId,
        ]))[0].position,
        changes.at(-1)!.pos,
      );
    } finally {
      hold.release();
      await pending;
      hold.restore();
    }
  });
});

Deno.test('projection work: failed application releases the room owner and rolls forward exactly once', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!capture-retry:test' });
    await project(store, g.roomId);
    const event = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'retry', msgtype: 'm.text' },
    }, g.signer);
    const db = await store.server();
    let failed = false;
    const restore = observePublication(
      { server: db },
      g.roomId,
      async (conn) => {
        if (
          !failed &&
          (await conn.query('SELECT 1 FROM feed WHERE event=?', [
            event.eventId,
          ])).length
        ) {
          failed = true;
          throw new Error('injected projection failure');
        }
      },
    );
    try {
      await assertRejects(
        () => project(store, g.roomId),
        Error,
        'injected projection failure',
      );
      assertEquals(
        await db.query('SELECT event FROM feed WHERE event=?', [event.eventId]),
        [],
      );
    } finally {
      restore();
    }
    await Promise.all([project(store, g.roomId), project(store, g.roomId)]);
    assertEquals(
      (await db.query('SELECT event FROM feed WHERE event=?', [event.eventId]))
        .map((r) => r.event),
      [event.eventId],
    );
  });
});

Deno.test('projection work: captured old incarnation cannot resurrect a removed and recreated room', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!capture-incarnation:test' });
    await project(store, g.roomId);
    const event = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'old incarnation', msgtype: 'm.text' },
    }, g.signer);
    const hold = holdEvent(store, g.roomId, event.eventId, true);
    const pending = project(store, g.roomId);
    const rejected = assertRejects(
      () => pending,
      Deno.errors.NotFound,
      'removed rooms database',
    );
    try {
      await hold.entered;
      await withProjectionLock(store, () =>
        finishRoomRemoval(
          store,
          g.roomId,
          { why: 'test removal', intents: [] },
          null,
        ));
      hold.restore();
      await genesis(store, { roomId: g.roomId });
      hold.release();
      await rejected;
      await project(store, g.roomId);
      const db = await store.server();
      assertEquals(
        await db.query('SELECT event FROM feed WHERE event=?', [event.eventId]),
        [],
      );
      assertEquals(
        (await db.query('SELECT COUNT(*) AS n FROM feed WHERE room=?', [
          g.roomId,
        ]))[0].n,
        5,
      );
    } finally {
      hold.release();
      hold.restore();
      await rejected;
    }
  });
});

Deno.test('projection work: tenant deactivation during room capture is not undone by stale push decisions', async () => {
  await withStore(async (store) => {
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('dev', 'Dev');
      await tx.users.insert('bob', 'Bob');
    });
    const g = await genesis(store, { roomId: '!capture-deactivation:test' });
    await bobJoins(g);
    await project(store, g.roomId);
    const event = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'held during deactivate', msgtype: 'm.text' },
    }, g.signer);
    const hold = holdEvent(store, g.roomId, event.eventId, true);
    const pending = project(store, g.roomId);
    try {
      await hold.entered;
      await tenant.tx((tx) => tx.users.markDeactivated('bob'));
      await projectTenant(store, 'test');
      hold.release();
      await pending;
      const db = await store.server();
      assertEquals(
        await db.query('SELECT event FROM notifications WHERE user=?', [
          '@bob:test',
        ]),
        [],
      );
      assertEquals(
        await db.query('SELECT event FROM push_evaluations WHERE user=?', [
          '@bob:test',
        ]),
        [],
      );
      assertEquals(
        (await db.query('SELECT event FROM feed WHERE event=?', [
          event.eventId,
        ])).map((r) => r.event),
        [event.eventId],
      );
    } finally {
      hold.release();
      await pending;
      hold.restore();
    }
  });
});

Deno.test('projection work: room removal reconciles typing before notifying completed projection', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!capture-drop-completion:test' });
    await project(store, g.roomId);
    const server = await store.server();
    assertEquals(await setTyping(server, g.roomId, g.creator, true), true);
    const observed: { typing: string[]; feed: unknown[] }[] = [];
    const unlisten = onProjected(async (owner, roomId) => {
      if (owner !== store || roomId !== g.roomId) return;
      observed.push({
        typing: typingIn(roomId).userIds,
        feed: await server.query('SELECT event FROM feed WHERE room=?', [
          roomId,
        ]),
      });
    });
    try {
      await g.room.tx((tx) =>
        tx.changes.append('drop', null, {
          why: 'completion regression',
          intents: [],
        })
      );
      await project(store, g.roomId);
      assertEquals(
        { observed, typing: typingIn(g.roomId).userIds },
        { observed: [{ typing: [], feed: [] }], typing: [] },
      );
    } finally {
      unlisten();
      await setTyping(server, g.roomId, g.creator, false);
    }
  });
});

Deno.test('projection work: a lifecycle arrival observes the complete already-admitted page and the next page recaptures policy', async () => {
  await withStore(async (store) => {
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('dev', 'Dev');
      await tx.users.insert('bob', 'Bob');
    });
    const g = await genesis(store, { roomId: '!writer-changes:test' });
    await bobJoins(g);
    await project(store, g.roomId);
    const events: Awaited<ReturnType<typeof sendLocal>>[] = [];
    for (const body of ['first', 'second', 'third']) {
      events.push(
        await sendLocal(g.room, {
          type: 'm.room.message',
          sender: g.creator,
          content: { body, msgtype: 'm.text' },
        }, g.signer),
      );
    }
    const last = events.at(-1)!.completion!;
    const db = await store.server();
    const original = store.tenant.bind(store);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    store.tenant = async (...args) => {
      const file = await original(...args);
      return {
        ...file,
        tx: async (fn, options) => {
          const result = await file.tx(fn, options);
          // Hold after the first policy snapshot, outside its transaction. The
          // queued writer then determines this turn's complete accepted prefix.
          if (!held) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          return result;
        },
      };
    };
    const projecting = project(store, g.roomId);
    let between: Promise<void> = Promise.resolve();
    try {
      await entered.promise;
      between = withProjectionLock(store, async () => {
        assertEquals(
          (await db.query(
            'SELECT event FROM feed WHERE event IN (?,?,?) ORDER BY seq',
            events.map((e) => e.eventId),
          )).map((r) => r.event),
          events.map((event) => event.eventId),
          'a lifecycle arrival must observe the finite admitted group whole',
        );
        assertEquals(
          (await db.query('SELECT position FROM watermarks WHERE source=?', [
            'room:' + g.roomId,
          ]))[0].position,
          last.through,
        );
        // New demand after the lifecycle turn cannot retain this policy.
        await tenant.tx((tx) => tx.users.markDeactivated('bob'));
      });
      release.resolve();
      await Promise.all([projecting, between]);
      assertEquals(
        (await db.query(
          'SELECT event FROM feed WHERE event IN (?,?,?) ORDER BY seq',
          events.map((e) => e.eventId),
        )).map((r) => r.event),
        events.map((e) => e.eventId),
      );
      assertEquals(
        (await db.query(
          'SELECT event FROM push_evaluations WHERE user=? AND event IN (?,?,?) ORDER BY event_seq',
          ['@bob:test', ...events.map((e) => e.eventId)],
        )).map((r) => r.event),
        events.map((event) => event.eventId),
      );
      const later = await sendLocal(g.room, {
        type: 'm.room.message',
        sender: g.creator,
        content: { body: 'after lifecycle', msgtype: 'm.text' },
      }, g.signer);
      await project(store, g.roomId);
      assertEquals(
        await db.query(
          'SELECT event FROM push_evaluations WHERE user=? AND event=?',
          ['@bob:test', later.eventId],
        ),
        [],
      );
      await projectTenant(store, 'test');
      assertEquals(
        await db.query('SELECT event FROM notifications WHERE user=?', [
          '@bob:test',
        ]),
        [],
      );
    } finally {
      release.resolve();
      await Promise.allSettled([projecting, between]);
      store.tenant = original;
    }
  });
});

Deno.test('projection work: a prepared prefix is not truncated by demand arriving during application', async () => {
  await withStore(async (store) => {
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('dev', 'Dev');
      await tx.users.insert('bob', 'Bob');
    });
    const g = await genesis(store, { roomId: '!writer-prepared-prefix:test' });
    await bobJoins(g);
    await project(store, g.roomId);
    const write = (body: string) =>
      sendLocal(g.room, {
        type: 'm.room.message',
        sender: g.creator,
        content: { body, msgtype: 'm.text' },
      }, g.signer);
    const events: Awaited<ReturnType<typeof write>>[] = [];
    for (const body of ['one', 'two', 'three']) events.push(await write(body));
    const db = await store.server();
    let queued = false;
    let between: Promise<void> = Promise.resolve();
    const restore = observePublication(
      { server: db },
      g.roomId,
      async (conn) => {
        if (
          !queued &&
          (await conn.query('SELECT 1 FROM feed WHERE event=?', [
            events[0].eventId,
          ])).length
        ) {
          queued = true;
          between = withProjectionLock(store, async () => {
            assertEquals(
              (await db.query(
                'SELECT event FROM feed WHERE room=? ORDER BY seq',
                [g.roomId],
              ))
                .filter((row) =>
                  events.some((event) => event.eventId === row.event)
                ).map((row) => row.event),
              events.map((event) => event.eventId),
              'new demand truncated the already prepared input prefix',
            );
            await tenant.tx((tx) => tx.users.markDeactivated('bob'));
          });
          void between.catch(() => {});
        }
      },
    );
    try {
      await project(store, g.roomId);
      await between;
      assertEquals(
        queued,
        true,
        'the competing demand must actually be injected',
      );
    } finally {
      await Promise.allSettled([between]);
      restore();
    }
    const later = await write('new turn, fresh policy');
    await project(store, g.roomId);
    assertEquals(
      (await db.query(
        'SELECT event FROM push_evaluations WHERE user=? AND event IN (?,?,?,?) ORDER BY source_pos',
        ['@bob:test', ...events.map((event) => event.eventId), later.eventId],
      )).map((row) => row.event),
      events.map((event) => event.eventId),
      'policy must be recaptured for the next writer turn',
    );
  });
});

Deno.test('projection work: a later change failure rolls back the admitted page and resumes without duplicates', async () => {
  await withStore(async (store) => {
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('dev', 'Dev');
      await tx.users.insert('bob', 'Bob');
    });
    const g = await genesis(store, { roomId: '!writer-partial-replay:test' });
    await bobJoins(g);
    await project(store, g.roomId);
    const baseline = await g.room.tx((tx) => tx.changes.head());
    const events: Awaited<ReturnType<typeof sendLocal>>[] = [];
    for (const body of ['committed', 'retry']) {
      events.push(
        await sendLocal(g.room, {
          type: 'm.room.message',
          sender: g.creator,
          content: { body, msgtype: 'm.text' },
        }, g.signer),
      );
    }
    const db = await store.server();
    const originalTenant = store.tenant.bind(store);
    let between: Promise<void> = Promise.resolve();
    let queued = false;
    store.tenant = async (...args) => {
      const file = await originalTenant(...args);
      return {
        ...file,
        tx: (fn, options) => {
          if (!queued) {
            queued = true;
            between = withProjectionLock(store, () => Promise.resolve());
          }
          return file.tx(fn, options);
        },
      };
    };
    const restore = observePublication(
      { server: db },
      g.roomId,
      async (conn) => {
        if (
          (await conn.query('SELECT 1 FROM feed WHERE event=?', [
            events[1].eventId,
          ])).length
        ) {
          throw new Error('later durable change failure');
        }
      },
    );
    try {
      await assertRejects(
        () => project(store, g.roomId),
        Error,
        'later durable change failure',
      );
      assertEquals(
        (await db.query(
          'SELECT event FROM feed WHERE event IN (?,?) ORDER BY seq',
          events.map((e) => e.eventId),
        )).map((r) => r.event),
        [],
      );
      assertEquals(
        (await db.query('SELECT position FROM watermarks WHERE source=?', [
          'room:' + g.roomId,
        ]))[0].position,
        baseline,
        'a rolled-back group must acknowledge none of its ready prefix',
      );
    } finally {
      await between;
      restore();
      store.tenant = originalTenant;
    }
    await Promise.all([project(store, g.roomId), project(store, g.roomId)]);
    assertEquals(
      (await db.query(
        'SELECT event FROM feed WHERE event IN (?,?) ORDER BY seq',
        events.map((e) => e.eventId),
      )).map((r) => r.event),
      events.map((e) => e.eventId),
    );
    const head = await g.room.tx((tx) => tx.changes.head());
    for (const source of ['room:', 'push-context:']) {
      assertEquals(
        (await db.query('SELECT position FROM watermarks WHERE source=?', [
          source + g.roomId,
        ]))[0].position,
        head,
      );
    }
  });
});

Deno.test('projection work: uncontended publication and historical context batch their durable changes', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!writer-uncontended:test' });
    await project(store, g.roomId);
    const events: string[] = [];
    for (const body of ['one', 'two', 'three']) {
      events.push(
        (await sendLocal(g.room, {
          type: 'm.room.message',
          sender: g.creator,
          content: { body, msgtype: 'm.text' },
        }, g.signer)).eventId,
      );
    }
    const db = await store.server();
    const original = db.tx.bind(db);
    let publications = 0;
    let historical = 0;
    db.tx = async (fn, options) => {
      let feed = false;
      let context = false;
      const result = await original((conn) => {
        const execute = conn.execute.bind(conn);
        conn.execute = (sql, values = []) => {
          if (sql.startsWith('INSERT INTO feed(')) feed = true;
          if (sql.startsWith('INSERT INTO notification_own_events(')) {
            context = true;
          }
          return execute(sql, values);
        };
        return fn(conn);
      }, options);
      if (feed) publications++;
      if (context) historical++;
      return result;
    };
    try {
      await project(store, g.roomId);
      assertEquals(
        (await db.query(
          'SELECT event FROM feed WHERE event IN (?,?,?) ORDER BY seq',
          events,
        )).map((r) => r.event),
        events,
      );
      historical = 0;
      await db.execute('DELETE FROM watermarks WHERE source=?', [
        'push-context:' + g.roomId,
      ]);
      await db.execute('DELETE FROM notification_own_events WHERE room=?', [
        g.roomId,
      ]);
      await project(store, g.roomId);
      assertEquals({ publications, historical }, {
        publications: 1,
        historical: 1,
      }, 'uncontended pages split their durable commits');
      assertEquals(
        (await db.query(
          'SELECT event FROM notification_own_events WHERE room=?',
          [g.roomId],
        )).length,
        8,
      );
    } finally {
      db.tx = original;
    }
  });
});

Deno.test('projection work: historical context rolls back its admitted page without completing its room early', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!writer-context:test' });
    await project(store, g.roomId);
    const db = await store.server();
    const head = await g.room.tx((tx) => tx.changes.head());
    const rows = await db.query(
      "SELECT event,pos FROM event_index WHERE room=? AND standing='accepted' AND grounding='grounded' ORDER BY pos",
      [g.roomId],
    );
    await db.execute('DELETE FROM watermarks WHERE source=?', [
      'push-context:' + g.roomId,
    ]);
    await db.execute('DELETE FROM notification_own_events WHERE room=?', [
      g.roomId,
    ]);
    const original = db.tx.bind(db);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    let failLater = true;
    db.tx = (fn, options) =>
      original((conn) => {
        const execute = conn.execute.bind(conn);
        conn.execute = async (sql, values = []) => {
          if (
            failLater &&
            sql.startsWith('INSERT INTO notification_own_events(') &&
            values.includes(rows[1].event)
          ) throw new Error('later context edge failure');
          const result = await execute(sql, values);
          if (
            !held && sql.startsWith('INSERT INTO notification_own_events(') &&
            values.includes(rows[0].event)
          ) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          return result;
        };
        return fn(conn);
      }, options);
    const projecting = project(store, g.roomId);
    const rejected = assertRejects(
      () => projecting,
      Error,
      'later context edge failure',
    );
    let between: Promise<void> = Promise.resolve();
    try {
      await entered.promise;
      between = withProjectionLock(store, async () => {
        assertEquals(
          (await db.query(
            'SELECT event FROM notification_own_events WHERE room=?',
            [g.roomId],
          )).map((r) => r.event),
          [],
        );
        assertEquals(
          (await db.query('SELECT position FROM watermarks WHERE source=?', [
            'push-context:' + g.roomId,
          ]))[0]?.position,
          undefined,
        );
        assertEquals(
          (await db.query('SELECT position FROM watermarks WHERE source=?', [
            'room:' + g.roomId,
          ]))[0].position,
          head,
        );
      });
      release.resolve();
      await Promise.all([rejected, between]);
    } finally {
      release.resolve();
      await Promise.allSettled([projecting, rejected, between]);
      db.tx = original;
      failLater = false;
    }
    await project(store, g.roomId);
    assertEquals(
      (await db.query(
        'SELECT event FROM notification_own_events WHERE room=? ORDER BY event',
        [g.roomId],
      )).map((r) => r.event),
      rows.map((r) => r.event).sort(),
    );
    assertEquals(
      (await db.query('SELECT position FROM watermarks WHERE source=?', [
        'push-context:' + g.roomId,
      ]))[0].position,
      head,
    );
  });
});
