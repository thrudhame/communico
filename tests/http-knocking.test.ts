import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { theApp } from '#engine/app.ts';
import { requireRoom } from '#engine/client/room.ts';
import { setConfigForTests } from '#engine/config.ts';

const { matrix, registerTestUser, test } = httpSuite('HTTP knocking');
// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
async function call(
  path: string,
  token: string,
  body?: unknown,
  method = 'POST',
) {
  const response = await matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
test('resident knock is prejoin only, repeats update reasons, invite accepts without autojoin', async () => {
  const owner = await registerTestUser('knock-owner', 'pw');
  const guest = await registerTestUser('knock-guest', 'pw');
  const made = await call('createRoom', owner.access_token!, {
    room_version: '10',
    initial_state: [{
      type: 'm.room.join_rules',
      state_key: '',
      content: { join_rule: 'knock' },
    }],
  });
  assertEquals(made.status, 200);
  const roomId = made.body.room_id;
  const encoded = encodeURIComponent(roomId);
  const room = await requireRoom(roomId);
  const stays = await room.tx((tx) => tx.segments.list());
  for (const reason of ['hello', 'again']) {
    const knocked = await call('knock/' + encoded, guest.access_token!, {
      reason,
    });
    assertEquals(knocked.status, 200, JSON.stringify(knocked.body));
    assertEquals(knocked.body, { room_id: roomId });
    const sync = await call('sync', guest.access_token!, undefined, 'GET');
    assert(sync.body.rooms.knock[roomId]);
    assertEquals(sync.body.rooms.join[roomId], undefined);
    assertEquals(sync.body.rooms.invite[roomId], undefined);
    const own = sync.body.rooms.knock[roomId].knock_state.events.find((
      e: Json,
    ) => e.state_key === guest.user_id);
    assertEquals(own.content, {
      membership: 'knock',
      reason,
      displayname: 'knock-guest',
    });
    const unchanged = await call(
      'sync?since=' + sync.body.next_batch,
      guest.access_token!,
      undefined,
      'GET',
    );
    assertEquals(unchanged.body.rooms.knock[roomId], undefined);
  }
  assertEquals(
    (await room.tx((tx) => tx.segments.list())).map((
      s,
    ) => [s.id, s.kind, s.status, s.prev, s.opening_group]),
    stays.map((s) => [s.id, s.kind, s.status, s.prev, s.opening_group]),
  );
  assertEquals(
    (await call(
      'rooms/' + encoded + '/messages?dir=b',
      guest.access_token!,
      undefined,
      'GET',
    )).status,
    403,
  );
  assertEquals(
    (await call('rooms/' + encoded + '/invite', owner.access_token!, {
      user_id: guest.user_id,
    })).status,
    200,
  );
  const accepted = await call('sync', guest.access_token!, undefined, 'GET');
  assert(accepted.body.rooms.invite[roomId]);
  assertEquals(accepted.body.rooms.knock[roomId], undefined);
  assertEquals(accepted.body.rooms.join[roomId], undefined);
  assertEquals(
    (await call('knock/' + encoded, guest.access_token!)).status,
    403,
  );
  assertEquals(
    (await theApp().server.query('SELECT * FROM prejoin_memberships')).length,
    0,
  );
});

test('knock authentication, room version, strict encryption, rejection and sync cuts', async () => {
  const owner = await registerTestUser('knock-policy-owner', 'pw');
  const guest = await registerTestUser('knock-policy-guest', 'pw');
  const make = async (version: string) => {
    const response = await call('createRoom', owner.access_token!, {
      room_version: version,
      initial_state: [{
        type: 'm.room.join_rules',
        state_key: '',
        content: { join_rule: 'knock' },
      }],
    });
    assertEquals(response.status, 200);
    return response.body.room_id as string;
  };
  const old = await make('6');
  assertEquals(
    (await call('knock/' + encodeURIComponent(old), guest.access_token!))
      .status,
    403,
  );
  const id = await make('7');
  const encoded = encodeURIComponent(id);
  assertEquals((await call('knock/' + encoded, '')).status, 401);
  assertEquals(
    (await call('knock/' + encoded, guest.access_token!, { reason: 1 })).status,
    400,
  );
  setConfigForTests({ encryption: { allowunencryptedjoining: false } });
  try {
    assertEquals(
      (await call('knock/' + encoded, guest.access_token!)).status,
      400,
    );
    const refused = await call('sync', guest.access_token!, undefined, 'GET');
    assertEquals(refused.body.rooms.knock[id], undefined);
  } finally {
    setConfigForTests({ encryption: { allowunencryptedjoining: true } });
  }
  const before = await call('sync', guest.access_token!, undefined, 'GET');
  const waiting = call(
    'sync?since=' + before.body.next_batch + '&timeout=2000',
    guest.access_token!,
    undefined,
    'GET',
  );
  assertEquals(
    (await call('knock/' + encoded, guest.access_token!, { reason: 'please' }))
      .status,
    200,
  );
  const arrived = await waiting;
  assert(arrived.body.rooms.knock[id]);
  const filtered = await call(
    'sync?filter=' +
      encodeURIComponent(JSON.stringify({ room: { not_rooms: [id] } })),
    guest.access_token!,
    undefined,
    'GET',
  );
  assertEquals(filtered.body.rooms.knock[id], undefined);
  const full = await call(
    'sync?since=' + arrived.body.next_batch + '&full_state=true',
    guest.access_token!,
    undefined,
    'GET',
  );
  assert(full.body.rooms.knock[id]);
  assertEquals(
    (await call('rooms/' + encoded + '/leave', guest.access_token!)).status,
    200,
  );
  const left = await call(
    'sync?since=' + arrived.body.next_batch,
    guest.access_token!,
    undefined,
    'GET',
  );
  assert(left.body.rooms.leave[id]);
  assertEquals(left.body.rooms.knock[id], undefined);
  await call('knock/' + encoded, guest.access_token!);
  assertEquals(
    (await call('rooms/' + encoded + '/kick', owner.access_token!, {
      user_id: guest.user_id,
    })).status,
    200,
  );
  assertEquals(
    (await call('knock/' + encoded, guest.access_token!)).status,
    200,
  );
  assertEquals(
    (await call('rooms/' + encoded + '/ban', owner.access_token!, {
      user_id: guest.user_id,
    })).status,
    200,
  );
  assertEquals(
    (await call('knock/' + encoded, guest.access_token!)).status,
    403,
  );
});
