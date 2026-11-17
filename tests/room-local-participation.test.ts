import { assertEquals, assertRejects } from '@std/assert';
import { createRoom } from '#engine/room/create.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { joinRemote } from '#engine/room/join.ts';
import { setRoomHooks } from '#engine/room/hooks.ts';
import { importReplicaGenesis } from '#engine/room/replica.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks, recoverServer } from '#engine/server/startup.ts';
import { openStore } from '#engine/store/index.ts';
import { fakeFetcher, fakeKeyResolver } from './fixtures/remote.ts';
import { makeFakeRoom } from './fixtures/remote-room.ts';
import { testRemoteServer, testSigner } from './fixtures/signer.ts';
import { historicalServerSchema } from './fixtures/server-schema-history.ts';

Deno.test('local participation records initiation, not a received same-server join', async (t) => {
  for (
    const mode of ['create', 'stock join', 'resident stock join', 'replica']
  ) {
    await t.step(mode, async () => {
      const dir = await Deno.makeTempDir({ prefix: 'local-participation-' });
      const store = await openStore({
        dir,
        library: './.native/libturso_ffi.so',
        checkpointlogbytes: 65536,
        maxopenfiles: 8,
        idleseconds: 300,
      }, { schemas: { room: roomSchema, server: serverSchema } });
      try {
        // Both best-effort callbacks are unavailable. Room-first truth must
        // survive the commit-before-registry/projection window.
        setRoomHooks({ project: async () => {}, register: async () => {} });
        const signer = await testSigner();
        let roomId: string, eventId: string;
        if (mode === 'create') {
          const result = await createRoom(store, {
            creator: '@anna:test',
            preset: 'public_chat',
          }, signer);
          roomId = result.roomId;
          eventId = result.memberEventId;
        } else {
          const source = await makeFakeRoom(
            mode === 'replica'
              ? { roomId: '!received:test', server: await testRemoteServer() }
              : { roomId: '!stock:remote.test' },
          );
          roomId = source.roomId;
          const keys = fakeKeyResolver(source.server, await testRemoteServer());
          if (mode === 'replica') {
            const events = [...source.events.values()];
            await importReplicaGenesis(store, {
              roomId,
              roomVersion: source.version,
              self: 'test',
              keys,
              create: events[0],
              join: events[1],
            });
            eventId = String(events[1].event_id);
          } else {
            const { fetcher } = fakeFetcher({
              makeJoin: (user) => source.makeJoinAnswer(user),
              sendJoin: (event) => source.acceptSendJoin(event),
            });
            const result = await joinRemote(store, {
              roomId,
              user: '@anna:test',
              via: [source.server.name],
              signer,
              deps: { fetcher, keys, self: 'test' },
            });
            eventId = result.eventId;
            if (mode === 'resident stock join') {
              const second = await joinRemote(store, {
                roomId,
                user: '@beth:test',
                via: [source.server.name],
                signer,
                deps: { fetcher, keys, self: 'test' },
              });
              eventId = second.eventId;
            }
          }
        }
        const room = await openRoom(store, roomId);
        const records = await room.tx(async (tx) =>
          (await tx.changes.after(0, 1000)).filter((change) =>
            change.kind === 'local-participation' && change.event === eventId
          )
        );
        assertEquals(records.length, mode === 'replica' ? 0 : 1);
        if (mode !== 'replica') {
          const user = mode === 'resident stock join'
            ? '@beth:test'
            : '@anna:test';
          const before = await room.tx((tx) => tx.changes.head());
          await room.tx((tx) => tx.changes.localParticipation(eventId, user));
          assertEquals(await room.tx((tx) => tx.changes.head()), before);
          await assertRejects(
            () =>
              room.tx((tx) =>
                tx.changes.localParticipation(eventId, '@other:test')
              ),
            Error,
            'E_LOCAL_PARTICIPATION_IDENTITY',
          );
          assertEquals(await room.tx((tx) => tx.changes.head()), before);
        }
        if (mode !== 'replica') {
          assertEquals(
            JSON.parse(records[0].data).user,
            mode === 'resident stock join' ? '@beth:test' : '@anna:test',
          );
        }
        await recoverServer(store);
        const server = await store.server();
        const readInitiator = async () => {
          const [row] = await server.query(
            'SELECT local_join_user FROM event_index WHERE room=? AND event=?',
            [roomId, eventId],
          );
          return row?.local_join_user;
        };
        const expected = mode === 'replica'
          ? null
          : mode === 'resident stock join'
          ? '@beth:test'
          : '@anna:test';
        assertEquals(await readInitiator(), expected);
        await recoverServer(store);
        assertEquals(await readInitiator(), expected);
      } finally {
        installServerHooks();
        await store.close();
        await Deno.remove(dir, { recursive: true });
      }
    });
  }
});

Deno.test('local participation upgrade preserves old event evidence without inventing initiation', async () => {
  const dir = await Deno.makeTempDir({
    prefix: 'local-participation-upgrade-',
  });
  const config = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(config, {
    schemas: { server: historicalServerSchema(45) },
  });
  try {
    let server = await store.server();
    assertEquals(
      (await server.query('PRAGMA table_info(event_index)')).some((row) =>
        row.name === 'local_join_user'
      ),
      false,
    );
    await server.execute(
      "INSERT INTO event_index(event,room,pos,standing,grounding,origin) VALUES('$old','!old:test',1,'accepted','grounded',NULL)",
    );
    await store.close();
    store = await openStore(config, { schemas: { server: serverSchema } });
    server = await store.server();
    assertEquals(
      await server.query(
        'SELECT event,room,pos,standing,grounding,origin,local_join_user FROM event_index',
      ),
      [{
        event: '$old',
        room: '!old:test',
        pos: 1,
        standing: 'accepted',
        grounding: 'grounded',
        origin: null,
        local_join_user: null,
      }],
    );
    assertEquals(
      await server.query("SELECT v FROM meta WHERE k='schema_version'"),
      [{ v: String(serverSchema.version) }],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
