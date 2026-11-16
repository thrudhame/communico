// F2: a retained typed tenant/room survives LRU churn and idle eviction.
// Observe both through real authenticated HTTP, at the consumer boundary.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { type App, closeApp, openApp } from '#engine/app.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { clear, remember } from '#tests/fixtures/http-leases/lease/get.ts';
import type { Pool } from '#engine/store/pool.ts';
import { idleTurns } from '#tests/support/pool-turn.ts';
import { keyFor } from '#engine/store/layout.ts';
import type { Db } from '#engine/store/db.ts';
import { latch, watchdog } from '#tests/support/ordering.ts';

async function withLeaseApp(
  maxopenfiles: number,
  run: (
    app: App,
    base: string,
    sweep: (ageMs: number) => Promise<void>,
    pool: Pool,
  ) => Promise<void>,
) {
  const dir = await Deno.makeTempDir({ prefix: 'http-leases-' });
  const { value: app, turn: sweep } = await idleTurns(() =>
    openApp({
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles,
      idleseconds: 1,
    }), (app) => (app.store as unknown as { pool: Pool }).pool);
  const handler = await pathfinder({
    roots: ['api/endpoints/matrix/', 'tests/fixtures/http-leases/'],
  });
  const server = Deno.serve({
    hostname: '127.0.0.1',
    port: 0,
    onListen: () => {},
  }, handler);
  const base = `http://127.0.0.1:${server.addr.port}`;
  try {
    await run(app, base, sweep, (app.store as unknown as { pool: Pool }).pool);
  } finally {
    clear();
    await server.shutdown();
    await closeApp();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('HTTP leases: more rooms than maxopenfiles and concurrent tenant and room operations', async () => {
  await withLeaseApp(1, async (app, base) => {
    const user = await registerUser(app.tenant, {
      localpart: 'lease-user',
      password: 'pw',
    });
    assert(typeof user.access_token === 'string');
    const headers = { Authorization: 'Bearer ' + user.access_token };
    const rooms = [];
    for (let i = 0; i < 12; i++) {
      const result = await createRoom(
        app.store,
        { creator: user.user_id },
        app.tenant.signer(),
      );
      const room = await openRoom(app.store, result.roomId);
      rooms.push(room);
      remember(room);
      const response = await fetch(base + '/_matrix/client/v3/account/whoami', {
        headers,
      });
      assertEquals(response.status, 200);
      assertEquals((await response.json()).user_id, user.user_id);
    }
    const read = async (id: string) => {
      const res = await fetch(base + '/lease?room=' + encodeURIComponent(id), {
        headers,
      });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), {
        room: id,
        membership: 'join',
        user: user.user_id,
      });
    };
    for (const room of rooms) await read(room.id);
    // Hold a tenant read while HTTP room reads churn the pool. max=1 may
    // temporarily overflow when both files are leased, then returns to 1.
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const tenantRead = app.tenant.tx(async (tx) => {
      assertEquals(await tx.users.exists('lease-user'), true);
      entered();
      await waiting;
      assertEquals(await tx.users.exists('lease-user'), true);
    });
    await ready;
    try {
      await Promise.all(rooms.map((room) => read(room.id)));
    } finally {
      release();
      await tenantRead;
    }
    assert(app.store.stats().openFiles <= 1);
    assertEquals(app.store.stats().poolErrors, []);
  });
});

Deno.test('HTTP leases: idle eviction closes a room while an unrelated tenant lease remains usable', async () => {
  // Two slots keep this room idle instead of evicting it through the max=1
  // churn above. A real held tenant transaction makes global zero incorrect.
  await withLeaseApp(2, async (app, base, sweep, pool) => {
    const user = await registerUser(app.tenant, {
      localpart: 'idle-lease-user',
      password: 'pw',
    });
    const result = await createRoom(
      app.store,
      { creator: user.user_id },
      app.tenant.signer(),
    );
    const room = await openRoom(app.store, result.roomId);
    remember(room);
    const read = async () => {
      const response = await fetch(
        base + '/lease?room=' + encodeURIComponent(room.id),
        {
          headers: { Authorization: 'Bearer ' + user.access_token },
        },
      );
      assertEquals(response.status, 200);
      assertEquals(await response.json(), {
        room: room.id,
        membership: 'join',
        user: user.user_id,
      });
    };
    const entered = latch(), release = latch();
    const tenantRead = app.tenant.tx(async (tx) => {
      assertEquals(await tx.users.exists('idle-lease-user'), true);
      entered.release();
      await release.wait;
      assertEquals(await tx.users.exists('idle-lease-user'), true);
    });
    // Own an early failure even if it happens before the entered observation.
    void tenantRead.catch(() => {});
    let idleDb: Db | undefined;
    try {
      await watchdog(entered.wait, 'tenant lease enters before idle sweep');
      await read();
      const key = 'rooms:' + await keyFor(room.id);
      const state = pool as unknown as {
        entries: Map<string, { db: Db; leases: number }>;
      };
      const idle = state.entries.get(key);
      assert(idle, 'known room must be cached before idle sweep');
      idleDb = idle.db;
      assertEquals(idle.leases, 0, 'known room must be unleased');
      await sweep(1001);
      assertEquals(
        state.entries.has(key),
        false,
        'idle sweep actually evicted the room',
      );
      await assertRejects(
        () => idle.db.query('SELECT value FROM id'),
        Error,
        'database is closing or closed',
      );
      assertEquals(
        release.released,
        false,
        'tenant lease remains held through eviction',
      );
      await read();
      assertEquals(app.store.stats().poolErrors, []);
    } finally {
      release.release();
      await tenantRead;
      await idleDb?.close();
    }
  });
});
