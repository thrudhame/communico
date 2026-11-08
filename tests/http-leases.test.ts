// F2: a retained typed tenant/room survives LRU churn and idle eviction.
// Observe both through real authenticated HTTP, at the consumer boundary.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { closeApp, openApp } from '#engine/app.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { clear, remember } from '#tests/fixtures/http-leases/lease/get.ts';

Deno.test('HTTP leases: more rooms than maxopenfiles, idle close, concurrent tenant and room operations', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'http-leases-' });
  const app = await openApp({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 1,
    idleseconds: 1,
  });
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
    await new Promise((resolve) => setTimeout(resolve, 2600));
    assertEquals(
      app.store.stats().openFiles,
      0,
      'idle sweep actually evicted the files',
    );
    await read(rooms[0].id);
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
  } finally {
    clear();
    await server.shutdown();
    await closeApp();
    await Deno.remove(dir, { recursive: true });
  }
});
