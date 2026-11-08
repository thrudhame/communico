// tests/room-build.test.ts — local PDU building: prevs from the stay's
// extremities (deterministic), depth chaining, auth selection over the
// state before the event, hashes, signatures and reference-hash ids.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { canonicalJson } from '#engine/canonical.ts';
import { eventIdFor, redact } from '#engine/eventid.ts';
import { buildCreate, buildInTx, resolutionProbe } from '#engine/room/build.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { verifyJson } from '#engine/signing-primitives.js';
import { randomSigner, testSigner } from './fixtures/signer.ts';

const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

async function withStore(
  dir: string,
  fn: (store: Store) => Promise<void>,
): Promise<void> {
  const store = await openStore(config(dir), { schemas: { room: roomSchema } });
  try {
    await fn(store);
  } finally {
    await store.close();
  }
}

// A room whose stay holds one accepted create event (the genesis root).
async function fixtureRoom(
  store: Store,
  roomId: string,
): Promise<{ createId: string; stayId: number }> {
  const signer = await testSigner();
  const room = await openRoom(store, roomId, { create: true });
  return await room.tx(async (tx) => {
    const empty = await tx.materialize.newGroup(null, []);
    const stayId = await tx.segments.create({
      kind: 'stay',
      opening_group: empty,
    });
    const create = await buildCreate(
      {
        sender: '@dev:test',
        content: { room_version: '11' },
        origin_server_ts: 1,
        roomId,
      },
      signer,
      '11',
    );
    const createId = create.event_id!;
    await tx.events.insert(createId, canonicalJson(create));
    await tx.events.setStatus(createId, {
      standing: 'accepted',
      grounding: 'grounded',
      origin: null,
      received_ts: 1,
    });
    const after = await tx.materialize.newGroup(empty, [
      { type: 'm.room.create', state_key: '', event: createId },
    ]);
    await tx.materialize.setEventState(createId, empty, after, 'dag');
    await tx.extremities.add(stayId, createId);
    const pos = await tx.changes.append('event', createId, {});
    if (await tx.materialize.publish(pos, stayId, after)) {
      await tx.materialize.setCurrent(stayId, after);
    }
    return { createId, stayId };
  });
}

Deno.test('build: a member event chains the extremity, selects auth over the state before', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withStore(dir, async (store) => {
      const { createId } = await fixtureRoom(store, '!r:test');
      const room = await openRoom(store, '!r:test');
      const signer = await testSigner();
      const pdu = await room.tx((tx) =>
        buildInTx(tx, '!r:test', {
          type: 'm.room.member',
          sender: '@dev:test',
          state_key: '@dev:test',
          content: { membership: 'join' },
          origin_server_ts: 1000,
        }, signer)
      );
      assertEquals(pdu.prev_events, [createId]);
      assertEquals(pdu.depth, 2);
      // v11 selects the create into auth_events (v11.md:131 note).
      assertEquals(pdu.auth_events, [createId]);
      assertEquals(pdu.room_id, '!r:test');
      assertEquals(pdu.state_key, '@dev:test');
      assertEquals(pdu.origin_server_ts, 1000);
      // id and content hash recompute (self-certifying).
      const recomputed = await eventIdFor(
        pdu as unknown as Record<string, unknown>,
        '11',
      );
      assertEquals(pdu.event_id, recomputed);
      assert(typeof pdu.hashes.sha256 === 'string');
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('build: fork extremities come sorted; auth selection resolves', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withStore(dir, async (store) => {
      const { createId, stayId } = await fixtureRoom(store, '!r:test');
      const room = await openRoom(store, '!r:test');
      const signer = await testSigner();
      // A second, hand-built extremity (a fork tip): an event whose id
      // sorts after the create's id. Its bytes need no validity — the
      // build only reads extremity ids and depths.
      const forkId = '$zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
      await room.tx(async (tx) => {
        await tx.events.insert(
          forkId,
          JSON.stringify({
            type: 'm.room.message',
            sender: '@dev:test',
            depth: 5,
            origin_server_ts: 2,
            content: {},
            prev_events: [createId],
            auth_events: [createId],
          }),
        );
        await tx.events.setStatus(forkId, {
          standing: 'accepted',
          grounding: 'grounded',
          origin: null,
          received_ts: 2,
        });
        const parent = (await tx.state.eventStateAfter(createId))!.group;
        await tx.materialize.setEventState(forkId, parent, parent, 'dag');
        await tx.extremities.add(stayId, forkId);
      });
      const before = resolutionProbe.resolutions;
      const pdu = await room.tx((tx) =>
        buildInTx(tx, '!r:test', {
          type: 'm.room.message',
          sender: '@dev:test',
          content: { body: 'heal', msgtype: 'm.text' },
          origin_server_ts: 1000,
        }, signer)
      );
      assertEquals(pdu.prev_events, [createId, forkId].sort());
      assertEquals(pdu.depth, 6);
      // two prevs -> the auth selection resolved their after-states
      assertEquals(resolutionProbe.resolutions, before + 1);

      // explicit prevs are honored (fork/delayed operations)
      const single = await room.tx((tx) =>
        buildInTx(tx, '!r:test', {
          type: 'm.room.message',
          sender: '@dev:test',
          content: { body: 'one', msgtype: 'm.text' },
          prev_events: [createId],
          origin_server_ts: 1001,
        }, signer)
      );
      assertEquals(single.prev_events, [createId]);
      assertEquals(single.depth, 2);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('build: >20 prevs refused; an unknown explicit prev never grounds', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withStore(dir, async (store) => {
      const { createId } = await fixtureRoom(store, '!r:test');
      const room = await openRoom(store, '!r:test');
      const signer = await testSigner();
      const many = Array.from({ length: 21 }, (_, i) => `$p${i}`);
      const err = await assertRejects(() =>
        room.tx((tx) =>
          buildInTx(tx, '!r:test', {
            type: 'm.room.message',
            sender: '@dev:test',
            content: {},
            prev_events: many,
          }, signer)
        )
      );
      assert(String(err).includes('M_TOO_MANY_PREV_EVENTS'));
      const unknown = await assertRejects(() =>
        room.tx((tx) =>
          buildInTx(tx, '!r:test', {
            type: 'm.room.message',
            sender: '@dev:test',
            content: {},
            prev_events: ['$nope'],
          }, signer)
        )
      );
      assert(String(unknown).includes('M_UNKNOWN_PREV'));
      void createId;
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('buildCreate: v11 carries room_id; v12 omits it; signature verifies', async () => {
  const { signer, publicKey } = await randomSigner();
  const v11 = await buildCreate(
    {
      sender: '@dev:test',
      content: { room_version: '11' },
      origin_server_ts: 1,
      roomId: '!r:test',
    },
    signer,
    '11',
  );
  assertEquals(v11.room_id, '!r:test');
  assertEquals(v11.depth, 1);
  assertEquals(v11.prev_events, []);
  assertEquals(v11.auth_events, []);
  assertEquals(v11.state_key, '');
  assertEquals(
    v11.event_id,
    await eventIdFor(v11 as unknown as Record<string, unknown>, '11'),
  );
  // the signature covers the redacted form (spec § hash_and_sign_event);
  // the id rides out-of-band — it is never part of the payload
  const redacted = redact(
    v11 as unknown as Record<string, unknown>,
    '11',
  ) as Record<string, unknown>;
  delete redacted.event_id;
  assert(
    await verifyJson(redacted, 'test', 'ed25519:test', publicKey),
    'signature must verify over the redacted form',
  );

  const v12 = await buildCreate(
    {
      sender: '@dev:test',
      content: { room_version: '12' },
      origin_server_ts: 1,
    },
    signer,
    '12',
  );
  assertEquals('room_id' in v12, false);
  // the v12 room id derives from the create's event id (v12.md:98-101)
  assert(/^\$[A-Za-z0-9_-]{43}$/.test(String(v12.event_id)));
  assertEquals(
    v12.event_id,
    await eventIdFor(v12 as unknown as Record<string, unknown>, '12'),
  );
});

Deno.test('buildCreate: non-canonical content numbers are a client fault', async () => {
  const signer = await testSigner();
  const err = await assertRejects(() =>
    buildCreate(
      {
        sender: '@dev:test',
        content: { room_version: '11', bad: 2 ** 53 },
        origin_server_ts: 1,
        roomId: '!r:test',
      },
      signer,
      '11',
    )
  );
  assert(String(err).includes('M_BAD_JSON'), String(err));
});
