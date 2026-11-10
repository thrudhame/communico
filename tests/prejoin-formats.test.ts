import { assert, assertEquals } from '@std/assert';
import { createRoom } from '#engine/room/create.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { openStore } from '#engine/store/index.ts';
import {
  prejoinState,
  stripPrejoin,
  validatePrejoin,
} from '#engine/federation/prejoin.ts';
import { verify } from '#engine/room/verify.ts';
import type { Pdu } from '#engine/pdu.ts';
import { fakeKeyResolver } from '#tests/fixtures/remote.ts';
import { testRemoteServer, testSigner } from '#tests/fixtures/signer.ts';

Deno.test('prejoin formats: every supported version sends signed wire state and strips client display', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  try {
    const signer = await testSigner();
    const keys = fakeKeyResolver(await testRemoteServer('test'));
    for (
      const version of ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12']
    ) {
      const { roomId } = await createRoom(store, {
        creator: '@dev:test',
        version,
        name: 'prejoin-name',
        topic: 'prejoin-topic',
      }, signer);
      const room = await openRoom(store, roomId);
      const wire = await prejoinState(room, '@dev:test');
      assert(wire.some((e) => e.type === 'm.room.create'));
      assert(wire.some((e) => e.type === 'm.room.name'));
      for (const event of wire) {
        assert(event.signatures && event.hashes, version + ':' + event.type);
        assert(!('event_id' in event) && !('unsigned' in event));
        assertEquals(
          'room_id' in event,
          version !== '12' || event.type !== 'm.room.create',
        );
        await verify(event as unknown as Pdu, version, keys, { roomId });
      }
      const display = await validatePrejoin(wire, roomId, version, keys);
      assertEquals(display.length, wire.length);
      for (const event of display) {
        assertEquals(typeof event.source_event_id, 'string');
        assert(!('source_event_id' in stripPrejoin(event)));
        assert(
          !('signatures' in event) && !('hashes' in event) &&
            !('room_id' in event),
        );
        assert(
          !('event_id' in event) && !('prev_events' in event) &&
            !('auth_events' in event),
        );
      }
    }
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
