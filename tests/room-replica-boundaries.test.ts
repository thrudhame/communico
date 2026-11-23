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
          // Observe the import owner's retained representation, not heap/GC
          // timing. Retaining complete lists for every delta is quadratic even
          // when the immutable manifest itself contains only linear IDs.
          const boundaryIds = new Set(
            manifest.boundaries.map((b) => b.eventId),
          );
          const set = Map.prototype.set;
          let retainedIds = 0;
          Reflect.set(Map.prototype, 'set', function (
            this: Map<unknown, unknown>,
            key: unknown,
            value: unknown,
          ) {
            if (
              typeof key === 'string' && boundaryIds.has(key) &&
              value !== null && typeof value === 'object' &&
              'eventId' in value && value.eventId === key &&
              'state' in value && Array.isArray(value.state) &&
              'authChain' in value && Array.isArray(value.authChain)
            ) {
              retainedIds += value.state.length + value.authChain.length;
            }
            return set.call(this, key, value);
          });
          try {
            await importReplicaRoom(
              replica,
              structuredClone(manifest),
              options,
            );
          } finally {
            Map.prototype.set = set;
          }
          console.log(JSON.stringify({
            importRetainedIds: retainedIds,
            compactWireIds: stateIds + authIds,
          }));
          assert(
            retainedIds <= stateIds + authIds,
            `import retained ${retainedIds} boundary IDs for ${
              stateIds + authIds
            } compact wire IDs`,
          );
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
          // Removing and adding the same held ID keeps membership in the set.
          const readded = structuredClone(manifest);
          const held = readded.boundaries[0].state[0];
          assert(held);
          readded.boundaries[1].removedState = [held];
          readded.boundaries[1].state.push(held);
          await importReplicaRoom(replica, readded, options);
          assertEquals(await target.tx((tx) => tx.changes.head()), head);
          for (
            const mode of [
              'missing base',
              'self base',
              'forward base',
              'unknown removal',
              'unknown auth removal',
              'duplicate removal',
              'unused invalid boundary',
            ]
          ) {
            const invalid = structuredClone(manifest);
            if (mode === 'missing base') invalid.boundaries[1].base = '$absent';
            else if (mode === 'self base') {
              invalid.boundaries[1].base = invalid.boundaries[1].eventId;
            } else if (mode === 'forward base') {
              invalid.boundaries[1].base = invalid.boundaries[2].eventId;
            } else if (mode === 'unknown auth removal') {
              invalid.boundaries[1].removedAuth = ['$absent'];
            } else if (mode === 'duplicate removal') {
              invalid.boundaries[1].removedState = [held, held];
            } else if (mode === 'unused invalid boundary') {
              invalid.boundaries.push({
                eventId: '$unused',
                resident: g.signer.serverName,
                base: invalid.boundaries.at(-1)!.eventId,
                state: [],
                authChain: [],
                removedState: ['$absent'],
              });
            } else invalid.boundaries[1].removedState = ['$absent'];
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
