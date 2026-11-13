import { assert, assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { serverName } from '#engine/config.ts';
import { inviteFor, receiveInvite } from '#engine/federation/invites.ts';
import {
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
  wireOf,
} from '#tests/fixtures/remote.ts';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('HTTP prejoin departure reason');
suite.test('the leave adapter forwards a reason to durable departure and the sync consumer', async () => {
  const user = await suite.registerTestUser('oob-reason', 'pw');
  const initial = await suite.matrix(
    new Request('http://x/_matrix/client/v3/sync', {
      headers: { Authorization: 'Bearer ' + user.access_token },
    }),
  );
  const since = (await initial.json()).next_batch;
  const app = theApp();
  const remote = await makeRemoteServer('reason.test');
  const roomId = '!reason:reason.test';
  const event = await remoteEvent(roomId, remote, '11', {
    type: 'm.room.member',
    sender: '@owner:reason.test',
    state_key: user.user_id,
    content: { membership: 'invite' },
    prev_events: [],
    auth_events: [],
  });
  const deps = {
    store: app.store,
    server: app.server,
    signer: app.tenant.signer(),
    keys: fakeKeyResolver(remote),
    self: serverName(),
    wake: () => {},
  };
  await receiveInvite(
    roomId,
    event.event_id!,
    { room_version: '11', event: wireOf(event), invite_room_state: [] },
    remote.name,
    deps,
  );
  const headers = {
    Authorization: 'Bearer ' + user.access_token,
    'content-type': 'application/json',
  };
  const left = await suite.matrix(
    new Request(
      'http://x/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) +
        '/leave',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ reason: 'decline over HTTP' }),
      },
    ),
  );
  assertEquals(left.status, 200);
  await left.arrayBuffer();
  const saved = await inviteFor(roomId, user.user_id, deps);
  assert(saved?.localLeaveJson);
  assertEquals(
    JSON.parse(saved.localLeaveJson).content.reason,
    'decline over HTTP',
  );
  const sync = await suite.matrix(
    new Request(
      'http://x/_matrix/client/v3/sync?since=' + encodeURIComponent(since),
      { headers },
    ),
  );
  assertEquals(sync.status, 200);
  const body = await sync.json();
  const events = body.rooms.leave[roomId].state.events;
  assertEquals(events.length, 1);
  assertEquals(events[0].content.reason, 'decline over HTTP');
});
