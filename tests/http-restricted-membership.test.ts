import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { requireRoom } from '#engine/client/room.ts';
import {
  fedCaller,
  remoteServer,
  signTemplate,
} from '#tests/http-federation.ts';
import { toWire } from '#engine/federation/pdu.ts';
import { theApp } from '#engine/app.ts';
import {
  joinByIdOrAlias,
  remoteJoinCandidates,
} from '#engine/client/membership.ts';
import {
  restrictedResidents,
  withRestrictedAdmission,
} from '#engine/room/restricted.ts';

const { matrix, registerTestUser, test } = httpSuite(
  'HTTP restricted membership',
);
// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
async function call(
  path: string,
  token: string,
  body: unknown = {},
  method = 'POST',
) {
  const response = await matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}

test('versioned restricted authorization: eligibility, invite bypass, malformed allow and no extra stay', async () => {
  const owner = await registerTestUser('restricted-owner', 'pw');
  const guest = await registerTestUser('restricted-guest', 'pw');
  const allowed =
    (await call('createRoom', owner.access_token!, { preset: 'public_chat' }))
      .body.room_id;
  for (const version of ['8', '9', '10', '11', '12']) {
    const rule = version === '10' ? 'knock_restricted' : 'restricted';
    const made = await call('createRoom', owner.access_token!, {
      room_version: version,
      initial_state: [{
        type: 'm.room.join_rules',
        state_key: '',
        content: {
          join_rule: rule,
          allow: [{ type: 'm.room_membership', room_id: allowed }],
        },
      }],
    });
    assertEquals(made.status, 200);
    const id = made.body.room_id as string;
    const encoded = encodeURIComponent(id);
    assertEquals(
      (await call('join/' + encoded, guest.access_token!)).status,
      403,
    );
    assertEquals(
      (await call('join/' + encodeURIComponent(allowed), guest.access_token!))
        .status,
      200,
    );
    const room = await requireRoom(id);
    const before = await room.tx((tx) => tx.segments.list());
    const joined = await call('join/' + encoded, guest.access_token!, {
      reason: 'eligible',
    });
    assertEquals(joined.status, 200, JSON.stringify(joined.body));
    const member = await call(
      'rooms/' + encoded + '/state/m.room.member/' +
        encodeURIComponent(guest.user_id!),
      owner.access_token!,
      {},
      'GET',
    );
    assertEquals(member.body.join_authorised_via_users_server, owner.user_id);
    assertEquals(member.body.reason, 'eligible');
    assertEquals(
      (await room.tx((tx) => tx.segments.list())).map((s) => s.id),
      before.map((s) => s.id),
    );
    const sync = await call('sync', guest.access_token!, {}, 'GET');
    assert(sync.body.rooms.join[id]);
    await call('rooms/' + encoded + '/leave', guest.access_token!);
    await call(
      'rooms/' + encodeURIComponent(allowed) + '/leave',
      guest.access_token!,
    );
    assertEquals(
      (await call('join/' + encoded, guest.access_token!)).status,
      403,
    );
    await call('rooms/' + encoded + '/invite', owner.access_token!, {
      user_id: guest.user_id,
    });
    assertEquals(
      (await call('join/' + encoded, guest.access_token!)).status,
      200,
    );
    await call('rooms/' + encoded + '/leave', guest.access_token!);
    await call(
      'rooms/' + encoded + '/state/m.room.join_rules',
      owner.access_token!,
      { join_rule: rule, allow: ['invalid'] },
      'PUT',
    );
    assertEquals(
      (await call('join/' + encoded, guest.access_token!)).status,
      403,
    );
  }
});

test('ordinary admission avoids auth closure; archived resident discovery checks its own snapshot', async () => {
  const owner = await registerTestUser('restricted-lazy-owner', 'pw');
  const guest = await registerTestUser('restricted-lazy-guest', 'pw');
  const made = await call('createRoom', owner.access_token!, {
    preset: 'public_chat',
  });
  assertEquals(made.status, 200);
  const room = await requireRoom(made.body.room_id);
  const original = room.tx;
  let fullStateReads = 0;
  room.tx = (fn) =>
    original(async (tx) => {
      const groupMap = tx.state.groupMap;
      tx.state.groupMap = (...args) => {
        fullStateReads++;
        return groupMap(...args);
      };
      return await fn(tx);
    });
  try {
    await withRestrictedAdmission(
      room,
      guest.user_id!,
      theApp().tenant.serverName,
      () => null,
    );
  } finally {
    room.tx = original;
  }
  console.log(JSON.stringify({ ordinaryJoinFullStateReads: fullStateReads }));
  assertEquals(fullStateReads, 0);
  fullStateReads = 0;
  let nominatedCalls = 0;
  room.tx = (fn) =>
    original(async (tx) => {
      const groupMap = tx.state.groupMap;
      tx.state.groupMap = (...args) => {
        fullStateReads++;
        return groupMap(...args);
      };
      return await fn(tx);
    });
  try {
    const admitted = await withRestrictedAdmission(
      room,
      guest.user_id!,
      theApp().tenant.serverName,
      (_tx, authorizer) => {
        nominatedCalls++;
        assertEquals(
          authorizer,
          null,
          'public admission needs no restricted vouch',
        );
        return 'public-nominee-admitted';
      },
      owner.user_id,
    );
    assertEquals(admitted, 'public-nominee-admitted');
    assertEquals(nominatedCalls, 1);
    assertEquals(
      fullStateReads,
      2,
      'capture and locked revalidation both read the nominee authorizer snapshot',
    );
  } finally {
    room.tx = original;
  }
  assertEquals(
    (await call(
      'rooms/' + encodeURIComponent(room.id) + '/leave',
      owner.access_token!,
    )).status,
    200,
  );
  assertEquals(await restrictedResidents(room, guest.user_id!), []);
});

test('federation restricted make/send: fresh eligibility, countersignature, foreign authorizer and missing knowledge', async () => {
  const owner = await registerTestUser('restricted-fed-owner', 'pw');
  const remote = await remoteServer();
  const fed = fedCaller(matrix, remote);
  const user = '@eligible:' + remote.name;
  const path = (op: string, room: string, key: string) =>
    '/_matrix/federation/' +
    (op === 'send_join' ? 'v2' : 'v1') + '/' + op + '/' +
    encodeURIComponent(room) + '/' + encodeURIComponent(key);
  const allowed =
    (await call('createRoom', owner.access_token!, { preset: 'public_chat' }))
      .body.room_id as string;
  const mkAllowed = await fed(
    'GET',
    path('make_join', allowed, user) + '?ver=11',
  );
  const joinedAllowed = await signTemplate(
    mkAllowed.body.event as Json,
    remote,
  );
  assertEquals(
    (await fed(
      'PUT',
      path('send_join', allowed, String(joinedAllowed.event_id)),
      toWire(joinedAllowed, '11'),
    )).status,
    200,
  );
  const target = (await call('createRoom', owner.access_token!, {
    room_version: '11',
    initial_state: [{
      type: 'm.room.join_rules',
      state_key: '',
      content: {
        join_rule: 'restricted',
        allow: [{ type: 'm.room_membership', room_id: allowed }],
      },
    }],
  })).body.room_id as string;
  const made = await fed('GET', path('make_join', target, user) + '?ver=11');
  assertEquals(made.status, 200, JSON.stringify(made.body));
  assertEquals(
    (made.body.event as Json).content.join_authorised_via_users_server,
    owner.user_id,
  );
  const stale = await signTemplate(made.body.event as Json, remote);
  const leaving = await fed('GET', path('make_leave', allowed, user));
  const leave = await signTemplate(leaving.body.event as Json, remote);
  assertEquals(
    (await fed(
      'PUT',
      path('send_leave', allowed, String(leave.event_id)),
      toWire(leave, '11'),
    )).status,
    200,
  );
  assertEquals(
    (await fed(
      'PUT',
      path('send_join', target, String(stale.event_id)),
      toWire(stale, '11'),
    )).status,
    403,
  );
  const again = await fed('GET', path('make_join', allowed, user) + '?ver=11');
  const rejoin = await signTemplate(again.body.event as Json, remote);
  assertEquals(
    (await fed(
      'PUT',
      path('send_join', allowed, String(rejoin.event_id)),
      toWire(rejoin, '11'),
    )).status,
    200,
  );
  const fresh = await fed('GET', path('make_join', target, user) + '?ver=11');
  const wrong = structuredClone(fresh.body.event) as Json;
  wrong.content.join_authorised_via_users_server = '@foreign:foreign.test';
  const forged = await signTemplate(wrong, remote);
  assertEquals(
    (await fed(
      'PUT',
      path('send_join', target, String(forged.event_id)),
      toWire(forged, '11'),
    )).status,
    403,
  );
  const event = await signTemplate(fresh.body.event as Json, remote);
  const sent = await fed(
    'PUT',
    path('send_join', target, String(event.event_id)),
    toWire(event, '11'),
  );
  assertEquals(sent.status, 200, JSON.stringify(sent.body));
  assert((sent.body.event as Json).signatures[theApp().tenant.serverName]);
  const state = await call(
    'rooms/' + encodeURIComponent(target) + '/state/m.room.member/' +
      encodeURIComponent(user),
    owner.access_token!,
    {},
    'GET',
  );
  assertEquals(state.body.membership, 'join');
  const unknown = (await call('createRoom', owner.access_token!, {
    initial_state: [{
      type: 'm.room.join_rules',
      state_key: '',
      content: {
        join_rule: 'restricted',
        allow: [{
          type: 'm.room_membership',
          room_id: '!unknown:elsewhere.test',
        }],
      },
    }],
  })).body.room_id as string;
  const cannot = await fed(
    'GET',
    path('make_join', unknown, '@other:' + remote.name) + '?ver=11',
  );
  assertEquals(cannot.status, 400);
  assertEquals(cannot.body.errcode, 'M_UNABLE_TO_AUTHORISE_JOIN');
});

test('explicit join candidates are authoritative; a room-ID domain is only an absent-candidate fallback', async () => {
  const observed: string[][] = [];
  const operation: typeof import('#engine/client/membership.ts').join = (
    roomId,
    _user,
    _content,
    opts,
  ) => {
    observed.push(opts?.via ?? []);
    return Promise.resolve({ roomId, eventId: '$unused', created: false });
  };
  await joinByIdOrAlias('!target:creator.test', '@guest:localhost', {}, [
    'explicit.test',
  ], operation);
  await joinByIdOrAlias(
    '!target:creator.test',
    '@guest:localhost',
    {},
    [],
    operation,
  );
  assertEquals(observed, [['explicit.test'], ['creator.test']]);
  assertEquals(
    remoteJoinCandidates(
      'self.test',
      ['explicit.test'],
      [],
      ['qualified.test'],
      ['held.test'],
    ),
    ['explicit.test'],
  );
  assertEquals(
    remoteJoinCandidates('self.test', ['self.test'], ['inviter.test'], [
      'qualified.test',
      'self.test',
    ], ['held.test', 'qualified.test']),
    ['inviter.test', 'qualified.test', 'held.test'],
  );
});
