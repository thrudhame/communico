// Own membership stays visible without granting access to unrelated history.
import { assert, assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { openRoom } from '#engine/room/index.ts';
import { membershipOf } from '#engine/server/read.ts';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('HTTP own membership after archived invite rejection');
type Json = Record<string, unknown>;

suite.test('never-joined invitees see their own transitions through every timeline reader', async () => {
  const alice = await suite.registerTestUser('own-member-alice', 'pw');
  const bob = await suite.registerTestUser('own-member-bob', 'pw');
  const call = async (
    path: string,
    token = bob.access_token,
    method = 'GET',
    body?: unknown,
  ) => {
    const res = await suite.matrix(
      new Request('http://x/_matrix/client/v3/' + path, {
        method,
        headers: { Authorization: 'Bearer ' + token },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json() as Json };
  };
  const ok = async (
    path: string,
    token = bob.access_token,
    method = 'GET',
    body?: unknown,
  ) => {
    const res = await call(path, token, method, body);
    assertEquals(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };
  const observed: unknown[] = [], expected: unknown[] = [];
  for (const hv of ['shared', 'future-unknown', 'joined', 'invited']) {
    const roomId = String(
      (await ok('createRoom', alice.access_token, 'POST', {
        preset: 'private_chat',
        initial_state: [{
          type: 'm.room.history_visibility',
          content: { history_visibility: hv },
        }],
      })).room_id,
    );
    const base = 'rooms/' + encodeURIComponent(roomId);
    const hidden = String(
      (await ok(
        base + '/send/m.room.message/secret',
        alice.access_token,
        'PUT',
        { body: 'not shared with an invitee', msgtype: 'm.text' },
      )).event_id,
    );
    await ok(base + '/invite', alice.access_token, 'POST', {
      user_id: bob.user_id,
    });
    const invitation = await membershipOf(theApp().server, roomId, bob.user_id);
    assert(invitation?.membership === 'invite');
    const since = (await ok('sync?timeout=0')).next_batch;
    await ok(base + '/leave', alice.access_token, 'POST', {});
    const room = await openRoom(theApp().store, roomId);
    assertEquals(await room.tx((tx) => tx.segments.openStay()), null);
    await ok(base + '/leave', bob.access_token, 'POST', {});
    const leave = await membershipOf(theApp().server, roomId, bob.user_id);
    assert(leave?.membership === 'leave');
    assertEquals(await room.tx((tx) => tx.segments.openStay()), null);
    const sync = await ok('sync?timeout=0&since=' + since);
    const left = ((sync.rooms as Json).leave as Json)[roomId] as Json;
    const timeline = (left.timeline as Json).events as Json[];
    observed.push([
      hv,
      'sync-own-leave',
      timeline.some((e) => e.event_id === leave.eventId),
    ]);
    expected.push([hv, 'sync-own-leave', true]);
    // Under shared/unknown/joined, every other event is still private.
    if (hv !== 'invited') {
      observed.push([
        hv,
        'sync-only-own',
        timeline.every((e) =>
          e.type === 'm.room.member' && e.state_key === bob.user_id
        ),
      ]);
      expected.push([hv, 'sync-only-own', true]);
    }
    const page = await ok(base + '/messages?dir=b&limit=100');
    const chunk = page.chunk as Json[];
    for (const eventId of [invitation.eventId, leave.eventId]) {
      observed.push([
        hv,
        'messages',
        eventId,
        chunk.some((e) => e.event_id === eventId),
      ]);
      expected.push([hv, 'messages', eventId, true]);
      for (const endpoint of ['event', 'context']) {
        observed.push([
          hv,
          endpoint,
          eventId,
          (await call(
            base + '/' + endpoint + '/' + encodeURIComponent(eventId),
          )).status,
        ]);
        expected.push([hv, endpoint, eventId, 200]);
      }
    }
    observed.push([hv, 'no-secret', chunk.some((e) => e.event_id === hidden)]);
    expected.push([hv, 'no-secret', false]);
    observed.push([
      hv,
      'secret-event',
      (await call(base + '/event/' + encodeURIComponent(hidden))).status,
    ]);
    expected.push([hv, 'secret-event', 404]);
  }
  assertEquals(observed, expected);
});
