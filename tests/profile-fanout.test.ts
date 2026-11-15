import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { setProfileField } from '#engine/tenant/profiles.ts';
import { historicalTenantSchema } from '#tests/fixtures/tenant-schema-history.ts';
import { prepareAppRecovery } from '#engine/app.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { createRoom } from '#engine/room/create.ts';
import { ProfileFanoutWork } from '#engine/profile-fanout.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { buildInTx } from '#engine/room/build.ts';
import { leave } from '#engine/room/membership.ts';

Deno.test('profile fanout: winning membership fields retain durable work in the profile transaction', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'profile-fanout-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, { schemas: { tenant: tenantSchema } });
  try {
    const tenant = await openTenant(store, 'test', { create: true });
    await registerUser(tenant, { localpart: 'alice', password: 'pw' });
    await setProfileField(tenant, 'alice', 'displayname', 'durable');
    const db = await store.tenant('test');
    const tables = await db.query(
      "SELECT name FROM sqlite_master WHERE name='profile_fanout'",
    );
    assertEquals(tables.length, 1, 'ACKed profile has no durable fanout owner');
    const [root] = await db.query(
      "SELECT * FROM profile_fanout WHERE localpart='alice'",
    );
    assertEquals(JSON.parse(String(root.profile)), { displayname: 'durable' });
    const revision = root.revision;
    await setProfileField(tenant, 'alice', 'org.example.custom', {
      private: true,
    });
    assertEquals(
      (await db.query(
        "SELECT revision FROM profile_fanout WHERE localpart='alice'",
      ))[0].revision,
      revision,
    );
    await assertRejects(() =>
      tenant.tx(async (tx) => {
        await tx.profiles.set('alice', 'avatar_url', 'rolled-back');
        throw new Error('rollback');
      })
    );
    assertEquals(
      (await db.query(
        "SELECT revision FROM profile_fanout WHERE localpart='alice'",
      ))[0].revision,
      revision,
    );
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    assertEquals(
      await (await store.tenant('test')).query(
        "SELECT revision,profile FROM profile_fanout WHERE localpart='alice'",
      ),
      [{ revision, profile: root.profile }],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('profile fanout: actual tenant26 upgrade adds work storage without inventing a profile mutation', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'profile-fanout-upgrade-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: { tenant: historicalTenantSchema(26) },
  });
  try {
    const tenant = await openTenant(store, 'test', { create: true });
    await registerUser(tenant, { localpart: 'alice', password: 'pw' });
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    const db = await store.tenant('test');
    assertEquals(await db.query('SELECT * FROM profile_fanout'), []);
    assertEquals(await db.query('SELECT * FROM profile_fanout_rooms'), []);
    assert((await openTenant(store, 'test')) !== null);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

async function workerFixture() {
  prepareAppRecovery();
  const dir = await Deno.makeTempDir({ prefix: 'profile-fanout-worker-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const schemas = {
    tenant: tenantSchema,
    room: roomSchema,
    server: serverSchema,
  };
  const store = await openStore(options, { schemas });
  const tenant = await openTenant(store, 'test', { create: true });
  const user =
    (await registerUser(tenant, { localpart: 'alice', password: 'pw' }))
      .user_id;
  const rooms: string[] = [];
  for (let i = 0; i < 2; i++) {
    rooms.push(
      (await createRoom(
        store,
        { creator: user, version: '11' },
        tenant.signer(),
      )).roomId,
    );
  }
  const worker = new ProfileFanoutWork({
    store,
    tenant,
    prepareSigner: () => Promise.resolve(tenant.signer()),
  });
  return {
    dir,
    options,
    schemas,
    store,
    tenant,
    user,
    rooms,
    worker,
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function member(
  store: Awaited<ReturnType<typeof openStore>>,
  roomId: string,
  user: string,
) {
  return await (await openRoom(store, roomId)).tx(async (tx) => {
    const stay = (await tx.segments.latestStay())!;
    const group = (await tx.state.current(stay.id))!;
    const id = (await tx.state.groupKey(group, 'm.room.member', user))!;
    const row = (await tx.events.get(id))!;
    return { id, content: JSON.parse(row.pdu).content };
  });
}

Deno.test('profile fanout: partial failures survive cold reopen and successful rooms are not reauthored', async () => {
  const f = await workerFixture();
  try {
    await setProfileField(f.tenant, 'alice', 'displayname', 'recovered');
    const worker = new ProfileFanoutWork({
      store: f.store,
      tenant: f.tenant,
      room: (id) =>
        id === f.rooms[0]
          ? Promise.reject(new Error('storage-fault'))
          : openRoom(f.store, id),
      prepareSigner: () => Promise.resolve(f.tenant.signer()),
    });
    assertEquals((await worker.drain()).map((failure) => failure.room), [
      f.rooms[0],
    ]);
    const done = await member(f.store, f.rooms[1], f.user);
    assertEquals(done.content.displayname, 'recovered');
    assertEquals(
      (await f.tenant.tx((tx) => tx.profiles.get('alice')))!.displayname,
      'recovered',
    );
    await f.store.close();
    const cold = await openStore(f.options, { schemas: f.schemas });
    try {
      const tenant = await openTenant(cold, 'test');
      const recovery = new ProfileFanoutWork({
        store: cold,
        tenant,
        prepareSigner: () => Promise.resolve(tenant.signer()),
      });
      assertEquals(await recovery.drain(), []);
      assertEquals(
        (await member(cold, f.rooms[0], f.user)).content.displayname,
        'recovered',
      );
      assertEquals(await member(cold, f.rooms[1], f.user), done);
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('profile fanout: exact prepared PDU is reconciled after room commit but before completion', async () => {
  const f = await workerFixture();
  try {
    await setProfileField(f.tenant, 'alice', 'avatar_url', 'mxc://test/avatar');
    let failed = false;
    const tenant: Tenant = {
      ...f.tenant,
      tx: (fn) =>
        f.tenant.tx((tx) => {
          const finish = tx.profiles.fanout.finish;
          tx.profiles.fanout.finish = (...args) => {
            if (!failed) {
              failed = true;
              throw new Error('after-room-commit');
            }
            return finish(...args);
          };
          return fn(tx);
        }),
    };
    const crash = new ProfileFanoutWork({
      store: f.store,
      tenant,
      prepareSigner: () => Promise.resolve(tenant.signer()),
    });
    assertEquals((await crash.drain()).length, 1);
    const work = (await f.tenant.tx((tx) =>
      tx.profiles.fanout.list('alice')
    ))[0];
    const rows = await f.tenant.tx((tx) => tx.profiles.fanout.rooms(work));
    const unfinished = rows.find((row) => !row.completed)!;
    const prepared = (await f.tenant.tx((tx) =>
      tx.profiles.fanout.submission(work, unfinished.room)
    ))!;
    const observed = await member(f.store, unfinished.room, f.user);
    assertEquals(observed.id, prepared.eventId);
    await f.store.close();
    const cold = await openStore(f.options, { schemas: f.schemas });
    try {
      const tenant = await openTenant(cold, 'test');
      const recover = new ProfileFanoutWork({
        store: cold,
        tenant,
        prepareSigner: () =>
          Promise.reject(new Error('fresh signing unavailable after restart')),
      });
      assertEquals(await recover.drain(), []);
      assertEquals(await member(cold, unfinished.room, f.user), observed);
      assertEquals(
        await tenant.tx((tx) =>
          tx.profiles.fanout.submission(work, unfinished.room)
        ),
        prepared,
      );
      assert(
        (await tenant.tx((tx) => tx.profiles.fanout.rooms(work))).every((row) =>
          row.completed && row.accepted
        ),
      );
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('profile fanout: a superseded winner cannot prepare old room work after a new winner commits', async () => {
  const f = await workerFixture();
  try {
    await setProfileField(f.tenant, 'alice', 'displayname', 'obsolete');
    const old = (await f.tenant.tx((tx) =>
      tx.profiles.fanout.list('alice')
    ))[0];
    let changed = false;
    const worker = new ProfileFanoutWork({
      store: f.store,
      tenant: f.tenant,
      prepareSigner: async () => {
        if (!changed) {
          changed = true;
          await setProfileField(f.tenant, 'alice', 'displayname', 'winner');
        }
        return f.tenant.signer();
      },
    });
    assertEquals(await worker.drain(), []);
    for (const room of f.rooms) {
      assertEquals(
        (await member(f.store, room, f.user)).content.displayname,
        'winner',
      );
    }
    await assertRejects(() =>
      f.tenant.tx((tx) => tx.profiles.fanout.submission(old, f.rooms[0]))
    );
    const db = await f.store.tenant('test');
    assert(
      (await db.query(
        'SELECT event_id FROM profile_fanout_rooms WHERE revision=?',
        [old.revision],
      )).every((row) => row.event_id === null),
    );
    const before = await Promise.all(
      f.rooms.map((room) => member(f.store, room, f.user)),
    );
    await setProfileField(f.tenant, 'alice', 'org.example.custom', {
      hidden: 1,
    });
    assertEquals(await worker.drain(), []);
    assertEquals(
      await Promise.all(f.rooms.map((room) => member(f.store, room, f.user))),
      before,
    );
    await f.tenant.tx((tx) => tx.users.markDeactivated('alice'));
    assertEquals(await worker.drain(), []);
  } finally {
    await f.close();
  }
});

Deno.test('profile fanout: pending preparation is not a new join after departure', async () => {
  const f = await workerFixture();
  try {
    await setProfileField(f.tenant, 'alice', 'displayname', 'pending');
    const work = (await f.tenant.tx((tx) =>
      tx.profiles.fanout.list('alice')
    ))[0];
    await f.tenant.tx((tx) => tx.profiles.fanout.discover(work, f.rooms));
    const room = await openRoom(f.store, f.rooms[0]);
    const pdu = await room.tx((tx) =>
      buildInTx(tx, room.id, {
        type: 'm.room.member',
        state_key: f.user,
        sender: f.user,
        content: { membership: 'join', displayname: 'pending' },
      }, f.tenant.signer())
    );
    await f.tenant.tx((tx) => tx.profiles.fanout.prepare(work, room.id, pdu));
    await leave(room, f.user, f.tenant.signer());
    const departed = await member(f.store, room.id, f.user);
    assertEquals(await f.worker.drain(), []);
    assertEquals(await member(f.store, room.id, f.user), departed);
    assertEquals(await room.tx((tx) => tx.events.get(pdu.event_id!)), null);
    const result = (await f.tenant.tx((tx) => tx.profiles.fanout.rooms(work)))
      .find((row) => row.room === room.id)!;
    assertEquals(result.completed, true);
    assertEquals(
      result.accepted,
      null,
      'skipped preparation is not a claimed accepted room event',
    );
  } finally {
    await f.close();
  }
});
