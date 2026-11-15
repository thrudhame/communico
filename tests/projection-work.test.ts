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
    const observed: unknown[][] = [];
    let removeListener = () => {};
    try {
      await hold.entered;
      const second = await write('later cut');
      const db = await store.server();
      removeListener = onProjected(async (owner, id) => {
        if (owner === store && id === g.roomId) {
          observed.push((await db.query(
            'SELECT event FROM feed WHERE event IN (?,?) ORDER BY seq',
            [first.eventId, second.eventId],
          )).map((r) => r.event));
        }
      });
      jobs.push(project(store, g.roomId));
      hold.release();
      await Promise.all(jobs);
      assertEquals(observed, [[first.eventId], [
        first.eventId,
        second.eventId,
      ]]);
    } finally {
      hold.release();
      await Promise.all(jobs);
      removeListener();
      hold.restore();
    }
  });
});

Deno.test('projection work: a live backlog releases the writer between its existing pages', async () => {
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
    const secondPage = changes.slice(500).find((c) => c.kind === 'event')!;
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
        changes[499].pos,
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
    const original = db.tx.bind(db);
    let failed = false;
    db.tx = (fn, options) =>
      original((conn) => {
        const execute = conn.execute.bind(conn);
        conn.execute = (sql, values = []) => {
          if (
            !failed && sql.startsWith('INSERT INTO feed(') &&
            values.includes(event.eventId)
          ) {
            failed = true;
            throw new Error('injected projection failure');
          }
          return execute(sql, values);
        };
        return fn(conn);
      }, options);
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
      db.tx = original;
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
      await withProjectionLock(() =>
        finishRoomRemoval(
          store,
          g.roomId,
          { why: 'test removal', intents: [] },
          null,
        )
      );
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
