import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from '@std/assert';
import { MatrixError } from '#engine/matrix-error.ts';
import { verifySnapshot } from '#engine/room/snapshot.ts';
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
