import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { exportReplicaRoom } from '#engine/room/replica-export.ts';
import { importReplicaRoom } from '#engine/room/replica-import.ts';
import { genesis } from './fixtures/genesis.ts';
import { fakeKeyResolver } from './fixtures/remote.ts';
import { testRemoteServer } from './fixtures/signer.ts';

Deno.test('replica boundaries: 16/32 members retain reopen evidence with linear state and auth IDs', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  try {
    const g = await genesis(store, {
      roomId: '!growth:test',
      joinRule: 'public',
    });
    let previous = 0;
    for (let n = 1; n <= 32; n++) {
      const user = '@join' + n + ':' + g.signer.serverName;
      const joined = await sendLocal(g.room, {
        type: 'm.room.member',
        sender: user,
        state_key: user,
        content: { membership: 'join' },
      }, g.signer);
      assertEquals(joined.standing, 'accepted');
      if (n !== 16 && n !== 32) continue;
      const manifest = await exportReplicaRoom(g.room, g.signer.serverName);
      const stateIds = manifest.boundaries.reduce(
        (sum, b) => sum + b.state.length,
        0,
      );
      const authIds = manifest.boundaries.reduce(
        (sum, b) => sum + b.authChain.length,
        0,
      );
      console.log(
        JSON.stringify({
          addedMembers: n,
          boundaries: manifest.boundaries.length,
          stateIds,
          authIds,
        }),
      );
      assertEquals(manifest.boundaries.length, n + 1);
      assertEquals(manifest.stays.length, 1);
      assertEquals(manifest.stays[0].closed, false);
      if (previous) {
        assert(
          stateIds + authIds <= 2 * previous,
          'boundary ID growth must be linear',
        );
      }
      previous = stateIds + authIds;
      if (n === 32) {
        const full = await exportReplicaRoom(
          g.room,
          g.signer.serverName,
          0,
          false,
        );
        assert(
          full.boundaries.every((boundary) => boundary.base === undefined),
        );
        const replica = await openStore({
          dir: dir + '/replica',
          library: './.native/libturso_ffi.so',
          checkpointlogbytes: 65536,
          maxopenfiles: 8,
          idleseconds: 300,
        }, { schemas: { room: roomSchema } });
        const options = {
          self: g.signer.serverName,
          keys: fakeKeyResolver(await testRemoteServer()),
          signatureUnion: true,
        };
        try {
          await importReplicaRoom(replica, structuredClone(manifest), options);
          const target = await openRoom(replica, g.roomId);
          const state = async (room: typeof target) =>
            await room.tx(async (tx) => {
              const stay = await tx.segments.openStay();
              assert(stay);
              const group = await tx.state.current(stay.id);
              assert(group !== null);
              return [...await tx.state.groupMap(group)].sort(([a], [b]) =>
                a.localeCompare(b)
              );
            });
          assertEquals(await state(target), await state(g.room));
          const head = await target.tx((tx) => tx.changes.head());
          await importReplicaRoom(replica, full, options);
          assertEquals(await target.tx((tx) => tx.changes.head()), head);
          for (const mode of ['missing base', 'unknown removal']) {
            const invalid = structuredClone(manifest);
            if (mode === 'missing base') invalid.boundaries[1].base = '$absent';
            else invalid.boundaries[1].removedState = ['$absent'];
            await assertRejects(() =>
              importReplicaRoom(replica, invalid, options)
            );
            assertEquals(await target.tx((tx) => tx.changes.head()), head);
          }
        } finally {
          await replica.close();
        }
      }
    }
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
