import { assert, assertEquals } from '@std/assert';
import {
  runDeactivationWork,
  startDeactivationWork,
} from '#engine/deactivation.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { deactivateUser, registerUser } from '#engine/tenant/users.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { createRoom } from '#engine/room/create.ts';
import { invite, join, membershipOf } from '#engine/room/membership.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { setConfigForTests } from '#engine/config.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { inviteFor, receiveInvite } from '#engine/federation/invites.ts';
import { knockRemote } from '#engine/federation/knocks.ts';
import { startFakeServer } from './federation/fake-server.ts';
import { createFakeRoom } from './federation/fake-room.ts';
import { fakeKeyResolver } from './fixtures/remote.ts';

installServerHooks();

Deno.test('deactivation workers isolate discovery admission failure and retain the blocked account', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'deactivation-discovery-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, {
    schemas: { room: roomSchema, tenant: tenantSchema, server: serverSchema },
  });
  try {
    const tenant = await openTenant(store, 'test', { create: true });
    const rooms = [];
    for (const lp of ['alice', 'bob']) {
      await registerUser(tenant, { localpart: lp, password: 'pw' });
      rooms.push(
        await createRoom(
          store,
          { creator: '@' + lp + ':test' },
          tenant.signer(),
        ),
      );
      await deactivateUser(tenant, lp);
    }
    const server = await store.server(), query = server.query;
    const blocked = new MatrixError(
      503,
      'M_UNAVAILABLE',
      'fixture discovery admission',
    );
    server.query = function (...args) {
      if (args[1]?.includes('@alice:test')) return Promise.reject(blocked);
      return query.apply(this, args);
    };
    const failures: unknown[] = [];
    const options = {
      store,
      tenant,
      prepareSigner: () => Promise.resolve(tenant.signer()),
      wake: (_destination: string) => {},
      failed: (error: unknown) => failures.push(error),
    };
    try {
      await runDeactivationWork(options);
    } finally {
      server.query = query;
    }
    assertEquals(failures, [blocked]);
    assertEquals(
      (await membershipOf(
        await openRoom(store, rooms[0].roomId),
        '@alice:test',
      ))?.membership,
      'join',
    );
    assertEquals(
      (await membershipOf(await openRoom(store, rooms[1].roomId), '@bob:test'))
        ?.membership,
      'leave',
    );
    await runDeactivationWork(options);
    assertEquals(
      (await membershipOf(
        await openRoom(store, rooms[0].roomId),
        '@alice:test',
      ))?.membership,
      'leave',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

for (const kind of ['invite', 'knock']) {
  Deno.test(`deactivation retains one durable OOB ${kind} departure without requiring a room file or remote availability`, async () => {
    const dir = await Deno.makeTempDir({ prefix: 'deactivation-oob-' });
    const settings = {
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    };
    const schemas = {
      room: roomSchema,
      tenant: tenantSchema,
      server: serverSchema,
    };
    let store = await openStore(settings, { schemas });
    setConfigForTests({
      federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
    });
    resetCaCertsForTests();
    const tenant = await openTenant(store, 'logical.test', { create: true });
    const signer = tenant.signer(), user = '@alice:logical.test';
    let remoteRoom: Awaited<ReturnType<typeof createFakeRoom>>;
    const fake = await startFakeServer({
      ourKeyDoc: () =>
        Promise.resolve({
          server_name: 'logical.test',
          verify_keys: { [tenant.keyId]: { key: tenant.publicB64 } },
        }),
      handlers: (request) => {
        if (request.url.pathname.includes('/make_knock/')) {
          const template = remoteRoom.makeLeaveTemplate(user);
          return Promise.resolve(
            Response.json({
              ...template,
              event: {
                ...template.event as Record<string, unknown>,
                content: { membership: 'knock' },
              },
            }),
          );
        }
        if (request.url.pathname.includes('/send_knock/')) {
          return Promise.resolve(Response.json({ knock_room_state: [] }));
        }
        return Promise.resolve(new Response('', { status: 503 }));
      },
    });
    try {
      await registerUser(tenant, { localpart: 'alice', password: 'pw' });
      remoteRoom = await createFakeRoom({
        version: '11',
        creator: '@owner:' + fake.name,
        server: { name: fake.name, keyId: fake.keyId, kp: fake.kp },
      });
      const wakes: string[] = [];
      const deps = {
        store,
        server: await store.server(),
        self: tenant.serverName,
        signer,
        keys: fakeKeyResolver(fake),
        wake: (destination: string) => wakes.push(destination),
      };
      if (kind === 'invite') {
        const event = await remoteRoom.addEvent({
          type: 'm.room.member',
          sender: '@owner:' + fake.name,
          state_key: user,
          content: { membership: 'invite' },
        });
        await receiveInvite(
          remoteRoom.roomId,
          String(event.event_id),
          {
            room_version: '11',
            event: remoteRoom.wire(event),
            invite_room_state: [],
          },
          fake.name,
          deps,
        );
      } else await knockRemote(remoteRoom.roomId, user, {}, [fake.name], deps);
      await deactivateUser(tenant, 'alice');
      await runDeactivationWork({
        store,
        tenant,
        prepareSigner: () => Promise.resolve(signer),
        wake: deps.wake,
        failed: (error) => {
          throw error;
        },
      });
      const before = await inviteFor(remoteRoom.roomId, user, deps);
      assertEquals(before?.status, 'rejecting');
      assertEquals(
        JSON.parse(before!.localLeaveJson!).content.membership,
        'leave',
      );
      assert(wakes.includes(fake.name));
      assertEquals(await store.rooms(), []);
      await store.close();
      store = await openStore(settings, { schemas });
      const reopened = await openTenant(store, 'logical.test');
      await runDeactivationWork({
        store,
        tenant: reopened,
        prepareSigner: () =>
          Promise.reject(
            new Error('prepared OOB departure must not sign again'),
          ),
        wake: deps.wake,
        failed: (error) => {
          throw error;
        },
      });
      assertEquals(
        await inviteFor(remoteRoom.roomId, user, {
          ...deps,
          server: await store.server(),
        }),
        before,
      );
    } finally {
      await fake.close();
      await store.close();
      await Deno.remove(dir, { recursive: true });
      setConfigForTests({});
      resetCaCertsForTests();
    }
  });
}

Deno.test('deactivation close drains a wake accepted during an admitted pass', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'deactivation-close-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, {
    schemas: { room: roomSchema, tenant: tenantSchema, server: serverSchema },
  });
  let worker: ReturnType<typeof startDeactivationWork> | undefined;
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  try {
    const tenant = await openTenant(store, 'logical.test', { create: true });
    for (const localpart of ['alice', 'bob']) {
      await registerUser(tenant, { localpart, password: 'pw' });
    }
    const signer = tenant.signer();
    await createRoom(store, { creator: '@alice:logical.test' }, signer);
    const bob = await createRoom(
      store,
      { creator: '@bob:logical.test' },
      signer,
    );
    await deactivateUser(tenant, 'alice');
    const failures: unknown[] = [];
    worker = startDeactivationWork({
      store,
      tenant,
      pollseconds: 60,
      wake() {},
      failed(error) {
        failures.push(error);
      },
      async prepareSigner() {
        entered.resolve();
        await release.promise;
        return signer;
      },
    });
    await entered.promise;
    await deactivateUser(tenant, 'bob');
    worker.wake();
    const closing = worker.close();
    release.resolve();
    await closing;
    assertEquals(failures, []);
    assertEquals(
      (await membershipOf(
        await openRoom(store, bob.roomId),
        '@bob:logical.test',
      ))?.membership,
      'leave',
    );
    assertEquals(
      await (await store.tenant('logical.test')).query(
        'SELECT localpart FROM deactivation_work ORDER BY localpart',
      ),
      [{ localpart: 'alice' }, { localpart: 'bob' }],
    );
  } finally {
    release.resolve();
    await worker?.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('deactivation work leaves all local memberships fairly, retries after restart and retains roots for late rooms', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'deactivation-worker-' });
  const settings = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const schemas = {
    room: roomSchema,
    tenant: tenantSchema,
    server: serverSchema,
  };
  let store = await openStore(settings, { schemas });
  try {
    let tenant = await openTenant(store, 'logical.test', { create: true });
    for (const localpart of ['alice', 'bob', 'active']) {
      await registerUser(tenant, { localpart, password: 'pw' });
    }
    const signer = tenant.signer();
    const first = await createRoom(
      store,
      { creator: '@alice:logical.test' },
      signer,
    );
    const second = await createRoom(
      store,
      { creator: '@bob:logical.test' },
      signer,
    );
    const room = await openRoom(store, second.roomId);
    await invite(room, '@bob:logical.test', '@active:logical.test', signer);
    await join(room, '@active:logical.test', signer);
    await deactivateUser(tenant, 'alice');
    await deactivateUser(tenant, 'bob');
    const failures: unknown[] = [];
    const options = () => ({
      store,
      tenant,
      prepareSigner: () => Promise.resolve(signer),
      wake: (_destination: string) => {},
      failed: (error: unknown) => failures.push(error),
    });
    let signatures = 0;
    await runDeactivationWork({
      ...options(),
      prepareSigner: () =>
        Promise.resolve({
          ...signer,
          sign(bytes: string) {
            signatures++;
            if (bytes.includes(first.roomId)) {
              throw new MatrixError(
                503,
                'M_UNAVAILABLE',
                'injected signing fence',
              );
            }
            return signer.sign(bytes);
          },
        }),
    });
    assert(failures.length > 0);
    assert(signatures > 0);
    assertEquals(
      (await membershipOf(
        await openRoom(store, first.roomId),
        '@alice:logical.test',
      ))?.membership,
      'join',
    );
    assertEquals(
      (await membershipOf(room, '@bob:logical.test'))?.membership,
      'leave',
    );
    assertEquals(
      (await membershipOf(room, '@active:logical.test'))?.membership,
      'join',
    );
    const departed = (await membershipOf(room, '@bob:logical.test'))!.eventId;
    await store.close();
    store = await openStore(settings, { schemas });
    tenant = await openTenant(store, 'logical.test');
    await runDeactivationWork(options());
    assertEquals(
      (await membershipOf(
        await openRoom(store, first.roomId),
        '@alice:logical.test',
      ))?.membership,
      'leave',
    );
    assertEquals(
      (await membershipOf(
        await openRoom(store, second.roomId),
        '@bob:logical.test',
      ))?.eventId,
      departed,
    );
    // Simulate a later authentic room import: its old membership still needs parting.
    const late = await createRoom(
      store,
      { creator: '@alice:logical.test' },
      signer,
    );
    await runDeactivationWork(options());
    assertEquals(
      (await membershipOf(
        await openRoom(store, late.roomId),
        '@alice:logical.test',
      ))?.membership,
      'leave',
    );
    assertEquals(
      await (await store.tenant('logical.test')).query(
        'SELECT localpart FROM deactivation_work ORDER BY localpart',
      ),
      [{ localpart: 'alice' }, { localpart: 'bob' }],
    );
    await runDeactivationWork({
      ...options(),
      prepareSigner: () =>
        Promise.reject(new Error('completed work must not sign')),
      failed: (error: unknown) => {
        throw error;
      },
    });
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
