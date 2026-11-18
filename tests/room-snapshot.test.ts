import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from '@std/assert';
import { MatrixError } from '#engine/matrix-error.ts';
import { verifySnapshot } from '#engine/room/snapshot.ts';
import { prepareReceiptPack } from '#engine/room/verify.ts';
import { fakeKeyResolver } from './fixtures/remote.ts';
import { makeFakeRoom } from './fixtures/remote-room.ts';

async function fixture() {
  const room = await makeFakeRoom({ roomId: '!snapshot:remote.test' });
  const boundary = room.afterOf.get(room.tipId)!;
  return {
    room,
    boundary,
    input: {
      roomId: room.roomId,
      roomVersion: room.version,
      resident: room.server.name,
      self: 'test',
      keys: fakeKeyResolver(room.server),
      state: [...boundary.values()].map((id) => room.events.get(id)!),
      authChain: [...room.events.values()].reverse(),
    },
  };
}

Deno.test('snapshot admission verifies auth-order evidence independently of a join or store', async () => {
  const { room, boundary, input } = await fixture();
  const admitted = await verifySnapshot(input);
  assertEquals(admitted.snapshot, boundary);
  assertEquals(admitted.createId, room.createId);
  assertEquals(admitted.rejected.size, 0);
  assertEquals(new Set(admitted.pack.keys()), new Set(room.events.keys()));
  const seen = new Set<string>();
  for (const [id, pdu] of admitted.ordered) {
    assert((pdu.auth_events ?? []).every((auth) => seen.has(auth)));
    seen.add(id);
  }
});

Deno.test('snapshot admission requires a single accepted create for the declared room version', async () => {
  const { input } = await fixture();
  await assertRejects(
    () =>
      verifySnapshot({
        ...input,
        state: input.state.filter((pdu) => pdu.type !== 'm.room.create'),
      }),
    MatrixError,
    'no single create',
  );
  await assertRejects(
    () =>
      verifySnapshot({
        ...input,
        roomVersion: '10',
      }),
    MatrixError,
  );
});

Deno.test('snapshot admission retains rejected auth evidence but never imports it as state', async () => {
  const { room, input } = await fixture();
  const unauthorized = await room.addEvent({
    type: 'm.room.name',
    state_key: '',
    sender: '@unjoined:remote.test',
    content: { name: 'must not become state' },
  });
  const id = String(unauthorized.event_id);
  const admitted = await verifySnapshot({
    ...input,
    state: [...input.state, unauthorized],
  });
  assert(admitted.pack.has(id));
  assert(admitted.rejected.has(id));
  assert(!admitted.snapshot.has('m.room.name\0'));
});

Deno.test('snapshot admission drops unverifiable evidence without swallowing a local key fault', async () => {
  const { room, input } = await fixture();
  const invalid = await room.addEvent({
    type: 'm.room.name',
    state_key: '',
    content: { name: 'bad signature' },
  });
  invalid.signatures = {};
  const admitted = await verifySnapshot({
    ...input,
    state: [...input.state, invalid],
  });
  assert(!admitted.pack.has(String(invalid.event_id)));
  const fault = new Error('local key database failed');
  assertStrictEquals(
    await assertRejects(() =>
      verifySnapshot({
        ...input,
        keys: {
          verifyEventSignature: () => {
            throw fault;
          },
        },
      })
    ),
    fault,
  );
});

Deno.test('snapshot admission verifies independent receipts without awaiting a held sibling', async () => {
  const { boundary, input } = await fixture();
  const release = Promise.withResolvers<void>();
  const ordinary = input.keys;
  let overlapping = false;
  let held = false;
  const admitted = await verifySnapshot({
    ...input,
    keys: {
      async verifyEventSignature(args) {
        if (!held) {
          held = true;
          await release.promise;
        } else {
          overlapping = true;
          release.resolve();
        }
        return await ordinary.verifyEventSignature(args);
      },
    },
  });
  assert(overlapping);
  assertEquals(admitted.snapshot, boundary);
});

Deno.test('snapshot receipt preparation isolates shared caller material before concurrent normalization', async () => {
  const { input } = await fixture();
  for (const pdu of input.state) pdu.unsigned = { age: 123 };
  const before = structuredClone({
    state: input.state,
    authChain: input.authChain,
  });
  const admitted = await verifySnapshot(input);
  assertEquals(input.state, before.state);
  assertEquals(input.authChain, before.authChain);
  for (const pdu of admitted.pack.values()) assert(!('unsigned' in pdu));
});

Deno.test('receipt packs drain independent work before propagating the first input-order fault', async () => {
  const { input } = await fixture();
  const first = input.state[0].event_id;
  const fault = new Error('first receipt fault');
  let completed = false;
  const caught = await assertRejects(() =>
    prepareReceiptPack(input.state.slice(0, 2), async (pdu) => {
      if (pdu.event_id === first) throw fault;
      await crypto.subtle.digest('SHA-256', new Uint8Array([1]));
      completed = true;
      throw new Error('second receipt fault');
    })
  );
  assertStrictEquals(caught, fault);
  assert(completed);
});
