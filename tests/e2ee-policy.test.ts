import { assertEquals, assertRejects } from '@std/assert';
import { config, setConfigForTests } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { createRoom } from '#engine/room/create.ts';
import { buildInTx } from '#engine/room/build.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { ingestInTx, ingestLocal, sendLocal } from '#engine/room/ingest.ts';
import { join, leave, reopen } from '#engine/room/membership.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { openStore } from '#engine/store/index.ts';
import { testSigner } from './fixtures/signer.ts';

Deno.test('E6 failed encryption initialization publishes no room or invitation', async () => {
  const old = config();
  setConfigForTests({ encryption: { allowunencryptedcreation: false } });
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
    const failing = {
      ...signer,
      sign: (json: string) => {
        if (JSON.parse(json).type === 'm.room.encryption') {
          throw new Error('injected encryption signing failure');
        }
        return signer.sign(json);
      },
    };
    await assertRejects(
      () =>
        createRoom(store, {
          creator: '@a:test',
          invite: ['@b:test', '@remote:peer.test'],
        }, failing),
      Error,
      'injected encryption signing failure',
    );
    assertEquals(await store.rooms(), []);
    const created = await createRoom(store, { creator: '@a:test' }, signer);
    assertEquals(await store.rooms(), [created.roomId]);
  } finally {
    await store.close();
    setConfigForTests(old);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('E6 internal authoring uses current locked state, preserves receipts and keeps remote rules unchanged', async () => {
  const old = config();
  setConfigForTests({
    encryption: {
      allowunencryptedcreation: true,
      allowunencryptedjoining: true,
      allowunencryptedmessages: true,
    },
  });
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  const signer = await testSigner();
  try {
    const made = await createRoom(store, {
      creator: '@a:test',
      preset: 'public_chat',
    }, signer);
    const room = await openRoom(store, made.roomId);
    const before = await room.tx((tx) =>
      buildInTx(tx, room.id, {
        type: 'm.room.message',
        sender: '@a:test',
        content: { body: 'authored before encryption' },
      }, signer)
    );
    const previous = await sendLocal(room, {
      type: 'm.room.message',
      sender: '@a:test',
      content: { body: 'already accepted' },
    }, signer);
    await sendLocal(room, {
      type: 'm.room.encryption',
      state_key: '',
      sender: '@a:test',
      content: { algorithm: 'm.megolm.v1.aes-sha2' },
    }, signer);
    setConfigForTests({
      encryption: {
        allowunencryptedcreation: false,
        allowunencryptedjoining: false,
        allowunencryptedmessages: false,
      },
    });
    await assertRejects(
      () => ingestLocal(room, before, signer.serverName),
      MatrixError,
    );
    await assertRejects(
      () =>
        sendLocal(room, {
          type: 'm.room.message',
          sender: '@a:test',
          content: { body: 'internal bypass' },
        }, signer),
      MatrixError,
    );
    assertEquals(
      (await ingestLocal(
        room,
        JSON.parse(previous.event.pdu),
        signer.serverName,
      )).eventId,
      previous.eventId,
    );
    // A remote echo keeps Matrix authorization, even if the local policy
    // would now refuse authoring these bytes. This is not room-auth policy.
    const remote = await withRoomLock(room.id, () =>
      room.tx(async (tx) => {
        const pdu = await buildInTx(tx, room.id, {
          type: 'm.room.message',
          sender: '@a:test',
          content: { body: 'remote forwarded event' },
        }, signer);
        return await ingestInTx(tx, room.id, pdu, {
          remote: {
            origin: 'peer',
            self: 'test',
            oversized: false,
            ungroundedMs: 0,
          },
        });
      }));
    assertEquals(remote.standing, 'accepted');
    const row = await room.tx((tx) => tx.events.get(remote.eventId));
    assertEquals(JSON.parse(row!.pdu).content.body, 'remote forwarded event');
    const initialized = await createRoom(store, { creator: '@a:test' }, signer);
    const encrypted = await openRoom(store, initialized.roomId);
    assertEquals(
      (await encrypted.tx(async (tx) => {
        const stay = (await tx.segments.openStay())!;
        return tx.state.groupKey(
          (await tx.state.current(stay.id))!,
          'm.room.encryption',
          '',
        );
      })) !== null,
      true,
    );
  } finally {
    setConfigForTests(old);
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('E6 internal joins and archived reopen cannot bypass plaintext admission', async () => {
  const old = config();
  setConfigForTests({
    encryption: {
      allowunencryptedcreation: true,
      allowunencryptedjoining: true,
      allowunencryptedmessages: true,
    },
  });
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  const signer = await testSigner();
  try {
    const made = await createRoom(store, {
      creator: '@a:test',
      preset: 'public_chat',
    }, signer);
    const room = await openRoom(store, made.roomId);
    setConfigForTests({
      encryption: {
        allowunencryptedcreation: true,
        allowunencryptedjoining: false,
        allowunencryptedmessages: true,
      },
    });
    await assertRejects(() => join(room, '@b:test', signer), MatrixError);
    assertEquals((await join(room, '@a:test', signer)).created, false);
    await leave(room, '@a:test', signer);
    await assertRejects(() => reopen(room, '@a:test', signer, {}), MatrixError);
    assertEquals(await room.tx((tx) => tx.segments.openStay()), null);
  } finally {
    setConfigForTests(old);
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
