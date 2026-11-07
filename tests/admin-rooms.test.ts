import { assert, assertEquals, assertRejects } from '@std/assert';
import { dirname } from '@std/path';
import { X509Certificate } from 'node:crypto';
import { closeApp, openApp } from '#engine/app.ts';
import { setConfigForTests } from '#engine/config.ts';
import { startAdmin } from '#root/api/admin/index.ts';
import { startHttp } from '#tests/http-app.ts';
import { adminCall } from '#tests/admin-client.ts';
import { genesis } from '#tests/fixtures/genesis.ts';
import { registerRoom } from '#engine/server/registry.ts';
import { type Conn, operations } from '#engine/store/db.ts';
import {
  inviteIntentProvider,
  rejectInviteRemote,
} from '#engine/federation/invites.ts';
import { fakeKeyResolver } from '#tests/fixtures/remote.ts';

Deno.test('admin rooms offered list, age filter, drop cleanup and lease retirement', async () => {
  const dir = await Deno.makeTempDir();
  const http = await startHttp();
  const app = http.app;
  const admin = await startAdmin(app, `${dir}/a.sock`);
  const call = async (op: string, body: unknown = {}) => {
    const r = await adminCall(admin.path, op, body);
    assertEquals(r.status, 200, JSON.stringify(r));
    return r.body.result;
  };
  try {
    const old = await genesis(app.store, { roomId: '!old:test' });
    const young = await genesis(app.store, { roomId: '!young:test' });
    const occupied = await genesis(app.store, { roomId: '!occupied:test' });
    for (const g of [old, young, occupied]) {
      await registerRoom(app.store, g.roomId);
    }
    await app.server.execute(
      'INSERT INTO directory(room_id,purgeable_ms) VALUES(?,?)',
      [old.roomId, Date.now() - 120000],
    );
    await app.server.execute(
      'INSERT INTO directory(room_id,purgeable_ms) VALUES(?,?)',
      [young.roomId, Date.now()],
    );
    const list = await call('rooms/list');
    assertEquals(list.length, 3);
    assertEquals(list[0].room_version, '11');
    assert(typeof list[0].current_stay === 'number');
    assertEquals((await call('rooms/list', { purgeable: true })).length, 2);
    assertEquals(
      (await call('rooms/purge', { olderThan: 60000 })).map((
        r: { room_id: string },
      ) => r.room_id),
      [old.roomId],
    );
    await assertRejects(() => app.store.room(old.roomId), Deno.errors.NotFound);
    assertEquals((await call('rooms/list')).length, 2);
    await young.room.tx(async (tx) => {
      const stay = await tx.segments.openStay();
      await tx.segments.close(stay!.id);
    });
    const archived = (await call('rooms/list')).find((r: { room_id: string }) =>
      r.room_id === young.roomId
    );
    assertEquals(archived.current_stay, null);
    // Occupied drop is explicit; pending deliveries become operator refusal records.
    const db = await app.store.room(occupied.roomId);
    const file = db.path;
    await app.server.execute(
      "INSERT INTO outbox(room,pos,destination,event,state,added_ms) VALUES(?,900,'one.test',?,'pending',1),(?,901,'two.test',?,'pending',1)",
      [occupied.roomId, occupied.tipId, occupied.roomId, occupied.tipId],
    );
    await app.server.execute(
      "INSERT INTO aliases(alias,room_id) VALUES('#ours:test',?)",
      [occupied.roomId],
    );
    const lease = await app.store.leaseRoom(occupied.roomId);
    let response: Awaited<ReturnType<typeof adminCall>> | undefined;
    const dropping = adminCall(admin.path, 'rooms/drop', {
      roomId: occupied.roomId,
    }).then((r) => response = r);
    try {
      const end = Date.now() + 5000;
      while (
        (await app.server.query('SELECT 1 FROM rooms WHERE room_id=?', [
          occupied.roomId,
        ])).length
      ) {
        assert(Date.now() < end);
        await new Promise((r) => setTimeout(r, 10));
      }
      assertEquals(response, undefined, 'unlink waits for the lease');
      assert(
        (await lease.db.query('SELECT count(*) AS n FROM events')).length === 1,
      );
    } finally {
      await lease.release();
    }
    await dropping;
    assertEquals(response!.status, 200);
    assertEquals(response!.body.result.settled, 2);
    await assertRejects(() => Deno.stat(file), Deno.errors.NotFound);
    for (
      const table of [
        'event_index',
        'feed',
        'memberships',
        'redactions',
        'relations',
        'search',
        'outbox',
        'forgotten',
      ]
    ) {
      assertEquals(
        await app.server.query(`SELECT * FROM ${table} WHERE room=?`, [
          occupied.roomId,
        ]),
        [],
      );
    }
    for (
      const table of [
        'aliases',
        'directory',
        'visibility',
        'receipts',
        'rooms',
        'federation_invites',
      ]
    ) {
      assertEquals(
        await app.server.query(`SELECT * FROM ${table} WHERE room_id=?`, [
          occupied.roomId,
        ]),
        [],
      );
    }
    assertEquals(
      await app.server.query('SELECT * FROM watermarks WHERE source=?', [
        'room:' + occupied.roomId,
      ]),
      [],
    );
    const refusals = await app.server.query(
      "SELECT detail FROM federation_pending WHERE kind='refused' ORDER BY name",
    );
    assertEquals(refusals.length, 2);
    assertEquals(JSON.parse(String(refusals[0].detail)).expired_rows, 1);
    await app.store.room(occupied.roomId, { create: true });
    await assertRejects(
      () => db.query('SELECT * FROM events'),
      Deno.errors.NotFound,
    );
    assertEquals(
      (await call('rooms/purge')).map((r: { room_id: string }) => r.room_id),
      [young.roomId],
    );
    assertEquals(await call('rooms/purge'), []);
    assertEquals(
      (await adminCall(admin.path, 'rooms/purge', { olderThan: 'bad' })).status,
      400,
    );
    await registerRoom(app.store, '!absent:test');
    assertEquals(
      (await call('rooms/drop', { roomId: '!absent:test' })).settled,
      0,
    );
    assertEquals(
      await app.server.query(
        "SELECT * FROM rooms WHERE room_id='!absent:test'",
      ),
      [],
    );
  } finally {
    await admin.shutdown();
    await http.close();
    await Deno.remove(dir, { recursive: true });
  }
});

for (const boundary of ['unlink', 'server cleanup'] as const) {
  Deno.test(`admin room removal fences and recovers failed ${boundary} without duplicate refusals`, async () => {
    const dir = await Deno.makeTempDir();
    const cfg = {
      dir: `${dir}/store`,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    };
    let app = await openApp(cfg);
    let admin = await startAdmin(app, `${dir}/a.sock`);
    try {
      const g = await genesis(app.store, { roomId: '!recover-drop:test' });
      if (boundary === 'server cleanup') {
        await app.server.execute(
          `INSERT INTO federation_invites(room_id,user_id,event_id,room_version,event_json,invite_room_state,origin,received_ms,status,seq)
           VALUES(?,'@waiting:test','$waiting','11','{}','[]','waiting.test',1,'pending',1)`,
          [g.roomId],
        );
        await app.server.execute(
          `INSERT INTO federation_invites(room_id,user_id,event_id,room_version,event_json,invite_room_state,origin,received_ms,status,seq)
           VALUES(?,'@rejecting:test','$rejecting','11','{}','[]','waiting.test',1,'rejecting',1)`,
          [g.roomId],
        );
      }
      await app.server.execute(
        "INSERT INTO outbox(room,pos,destination,event,state,added_ms) VALUES(?,900,'remote.test',?,'pending',1)",
        [g.roomId, g.tipId],
      );
      const roomDirectory = dirname((await app.store.room(g.roomId)).path);
      const original = Deno.remove;
      const originalServer = app.store.server.bind(app.store);
      if (boundary === 'server cleanup') {
        app.store.server = async () => {
          const db = await originalServer();
          return operations(
            (fn, options) =>
              db.tx((conn) =>
                fn(
                  new Proxy(conn, {
                    get(target, key) {
                      if (key === 'execute') {
                        return (...args: Parameters<Conn['execute']>) => {
                          if (args[0].startsWith('DELETE FROM event_index ')) {
                            throw new Error('injected server cleanup failure');
                          }
                          return target.execute(...args);
                        };
                      }
                      const value = Reflect.get(target, key);
                      return typeof value === 'function'
                        ? value.bind(target)
                        : value;
                    },
                  }),
                ), options),
            db.path,
          );
        };
      }
      if (boundary === 'unlink') {
        Deno.remove = (path, options) =>
          String(path) === roomDirectory
            ? Promise.reject(
              new Deno.errors.PermissionDenied('injected unlink failure'),
            )
            : original(path, options);
      }
      try {
        assertEquals(
          (await adminCall(admin.path, 'rooms/drop', { roomId: g.roomId }))
            .status,
          500,
        );
      } finally {
        Deno.remove = original;
        app.store.server = originalServer;
      }
      // A durable deletion must fence NEW handles too, including create, while
      // unlink is pending. Recovery can retry it without accepting new writes.
      await assertRejects(() => app.store.room(g.roomId), Deno.errors.NotFound);
      await assertRejects(
        () => app.store.room(g.roomId, { create: true }),
        Deno.errors.NotFound,
      );
      if (boundary === 'server cleanup') {
        const deps = {
          store: app.store,
          server: app.server,
          signer: app.tenant.signer(),
          keys: fakeKeyResolver(),
          self: app.tenant.serverName,
          wake: () => {},
        };
        assertEquals(
          await inviteIntentProvider(deps)(app.server, 'waiting.test'),
          null,
        );
        await assertRejects(
          () => rejectInviteRemote(g.roomId, '@waiting:test', deps),
          Error,
          'room removal is pending',
        );
      }
      await admin.shutdown();
      await closeApp();
      app = await openApp(cfg);
      admin = await startAdmin(app, `${dir}/a.sock`);
      assertEquals(await app.store.rooms(), []);
      assertEquals((await adminCall(admin.path, 'rooms/list')).body.result, []);
      const refused = await app.server.query(
        "SELECT count,detail FROM federation_pending WHERE name='remote.test' AND kind='refused'",
      );
      assertEquals(refused.length, 1);
      assertEquals(Number(refused[0].count), 1);
      assertEquals(JSON.parse(String(refused[0].detail)).expired_rows, 1);
      assertEquals(
        await app.server.query(
          "SELECT * FROM watermarks WHERE source='room:!recover-drop:test'",
        ),
        [],
      );
    } finally {
      await admin.shutdown();
      await closeApp();
      await Deno.remove(dir, { recursive: true });
    }
  });
}

for (const race of ['new rejection', 'candidate failover'] as const) {
  Deno.test(`admin room removal owns the invite cut against ${race} and startup reopens`, async () => {
    const dir = await Deno.makeTempDir();
    const cfg = {
      dir: `${dir}/store`,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    };
    let app = await openApp(cfg);
    let admin = await startAdmin(app, `${dir}/a.sock`);
    const originalRetire = app.store.retireRoom.bind(app.store);
    let release!: () => void;
    const held = new Promise<void>((resolve) => release = resolve);
    let retiring!: () => void;
    const cut = new Promise<void>((resolve) => retiring = resolve);
    try {
      const g = await genesis(app.store, { roomId: '!invite-drop:test' });
      const user = '@invitee:' + app.tenant.serverName;
      await app.server.execute(
        `INSERT INTO federation_invites(room_id,user_id,event_id,room_version,event_json,invite_room_state,origin,received_ms,status,seq)
         VALUES(?,?,?,'11',?,?,?,1,?,1)`,
        [
          g.roomId,
          user,
          '$invite',
          JSON.stringify({ sender: '@inviter:origin.test' }),
          JSON.stringify([{ sender: '@other:alternate.test' }]),
          'origin.test',
          race === 'new rejection' ? 'pending' : 'rejecting',
        ],
      );
      const wakes: string[] = [];
      const deps = {
        store: app.store,
        server: app.server,
        signer: app.tenant.signer(),
        keys: fakeKeyResolver(),
        self: app.tenant.serverName,
        wake: (destination: string) => wakes.push(destination),
      };
      const provider = inviteIntentProvider(deps);
      if (race === 'candidate failover') {
        await (await provider(app.server, 'origin.test'))!.failed(
          new Error('first failure'),
        );
        assertEquals(
          (await provider.review())[0].destination,
          'alternate.test',
        );
      }
      app.sender = {
        wake: deps.wake,
        contactHook: () => () => {},
        setIntentProvider: () => {},
        stop: () => Promise.resolve(),
        snapshot: () => [],
        reviewIntents: () => provider.review(),
        pruneIntents: (d) => provider.prune(d),
      };
      app.store.retireRoom = async (id) => {
        retiring();
        await held;
        return await originalRetire(id);
      };
      const owner = race === 'new rejection' ? null : 'alternate.test';
      const job = owner === null ? null : await provider(app.server, owner);
      const dropping = adminCall(admin.path, 'rooms/drop', {
        roomId: g.roomId,
      });
      await cut;
      const racing = race === 'new rejection'
        ? rejectInviteRemote(g.roomId, user, deps)
        : job!.failed(new Error('failure after removal snapshot'));
      // Keep the removal cut open while the competing real operation runs.
      // A corrected owner queues that transition until cleanup finishes.
      const raced = racing.then(() => null, (error) => error);
      await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      const result = await dropping;
      await raced;
      assertEquals(result.status, 200, JSON.stringify(result.body));
      assertEquals(result.body.result.settled, owner === null ? 0 : 1);
      assertEquals(await provider.review(), []);
      assertEquals(wakes, owner === null ? [] : ['alternate.test']);
      const refused = await app.server.query(
        "SELECT name, count FROM federation_pending WHERE kind='refused'",
      );
      assertEquals(
        refused.map((row) => [row.name, Number(row.count)]),
        owner === null ? [] : [[owner, 1]],
      );
      app.store.retireRoom = originalRetire;
      await admin.shutdown();
      await closeApp();
      app = await openApp(cfg);
      admin = await startAdmin(app, `${dir}/a.sock`);
      assertEquals((await adminCall(admin.path, 'rooms/list')).body.result, []);
      assertEquals(
        await app.server.query(
          'SELECT * FROM federation_invites WHERE room_id=?',
          [g.roomId],
        ),
        [],
      );
    } finally {
      release();
      await admin.shutdown();
      await closeApp();
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test('admin federation certificate uses tenant identity, private mode and exclusive output creation', async () => {
  const dir = await Deno.makeTempDir();
  const http = await startHttp();
  const admin = await startAdmin(http.app, `${dir}/a.sock`);
  const cert = `${dir}/fed.crt`, key = `${dir}/fed.key`;
  setConfigForTests({ federation: { cert, key } });
  try {
    assertEquals(
      (await adminCall(admin.path, 'federation-cert/write')).status,
      200,
    );
    const pem = await Deno.readTextFile(cert);
    const certificate = new X509Certificate(pem);
    assertEquals(certificate.subject, `CN=${http.app.tenant.nativeName}`);
    assert(certificate.verify(certificate.publicKey));
    const jwk = certificate.publicKey.export({ format: 'jwk' });
    assertEquals(
      jwk.x,
      http.app.tenant.publicB64.replaceAll('+', '-').replaceAll('/', '_')
        .replaceAll('=', ''),
    );
    assertEquals((await Deno.lstat(key)).mode! & 0o7777, 0o600);
    const originalKey = await Deno.readTextFile(key);
    assertEquals(
      (await adminCall(admin.path, 'federation-cert/write')).status,
      409,
    );
    assertEquals(await Deno.readTextFile(cert), pem);
    assertEquals(await Deno.readTextFile(key), originalKey);
    await Deno.remove(cert);
    assertEquals(
      (await adminCall(admin.path, 'federation-cert/write')).status,
      409,
    );
    await assertRejects(() => Deno.stat(cert), Deno.errors.NotFound);
    assertEquals(await Deno.readTextFile(key), originalKey);
    await Deno.remove(key);
    const simultaneous = await Promise.all([
      adminCall(admin.path, 'federation-cert/write'),
      adminCall(admin.path, 'federation-cert/write'),
    ]);
    assertEquals(simultaneous.map((r) => r.status).sort(), [200, 409]);
    assertEquals((await Deno.lstat(key)).mode! & 0o7777, 0o600);
    assertEquals(dirname(cert), dir);
  } finally {
    setConfigForTests({});
    await admin.shutdown();
    await http.close();
    await Deno.remove(dir, { recursive: true });
  }
});
