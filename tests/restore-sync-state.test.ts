import { assert, assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { leave } from '#engine/room/membership.ts';
import { beginRecovery } from '#engine/server/recovery.ts';
import { httpSuite } from '#tests/http-app.ts';

type Json = Record<string, unknown>;
const object = (value: unknown) => value as Json;
const events = (value: unknown) => value as Json[];
const suite = httpSuite('restore sync state delivery');

suite.test('an old epoch has a nonoverlapping recovery boundary, full admitted end state and paginatable history in every ordinary state dialect', async () => {
  const app = theApp();
  const alice = await suite.registerTestUser('restore-state', 'pw');
  const signer = app.tenant.signer();
  const kept = await createRoom(app.store, {
    creator: alice.user_id,
    preset: 'public_chat',
    name: 'Archived known name',
  }, signer);
  const departed = await createRoom(app.store, {
    creator: alice.user_id,
    preset: 'public_chat',
    name: 'Archived departure',
  }, signer);
  const room = await openRoom(app.store, kept.roomId);
  const custom = await sendLocal(room, {
    sender: alice.user_id,
    type: 'org.example.archived',
    state_key: 'retained',
    content: { value: 'archive' },
  }, signer);
  await leave(
    await openRoom(app.store, departed.roomId),
    alice.user_id,
    signer,
  );
  const call = async (path: string) => {
    const response = await suite.matrix(
      new Request(
        'http://x/_matrix/client/v3/' + path,
        { headers: { Authorization: 'Bearer ' + alice.access_token } },
      ),
    );
    assertEquals(response.status, 200, await response.clone().text());
    return await response.json() as Json;
  };
  const initial = await call('sync?timeout=0');
  await app.server.tx(beginRecovery);
  for (
    const stateKey of ['state', 'state_after', 'org.matrix.msc4222.state_after']
  ) {
    for (const limit of [10, 0]) {
      const query = new URLSearchParams({
        timeout: '0',
        since: String(initial.next_batch),
        filter: JSON.stringify({
          room: { timeline: { limit }, state: { lazy_load_members: true } },
        }),
      });
      if (stateKey !== 'state') {
        query.set(stateKey.replace('state_after', 'use_state_after'), 'true');
      }
      const reset = await call('sync?' + query);
      const sections = object(reset.rooms);
      const joined = object(object(sections.join)[kept.roomId]);
      const timeline = object(joined.timeline);
      assertEquals(
        timeline.events,
        [],
        'held event IDs cannot suppress the SDK gap reset',
      );
      assertEquals(
        timeline.limited,
        true,
        'another epoch is a real continuity break',
      );
      const state = events(object(joined[stateKey]).events);
      assertEquals(
        state.find((event) => event.type === 'm.room.name')?.content,
        {
          name: 'Archived known name',
        },
      );
      assert(state.some((event) => event.event_id === custom.eventId));
      assert(
        state.some((event) =>
          event.type === 'm.room.member' && event.state_key === alice.user_id &&
          object(event.content).membership === 'join'
        ),
      );
      assertEquals('state' in joined, stateKey === 'state');
      const left = object(object(sections.leave)[departed.roomId]);
      assert(left, 'an archived departure is part of the recovery baseline');
      assert(
        events(object(left[stateKey]).events).some((event) =>
          event.type === 'm.room.member' && event.state_key === alice.user_id &&
          object(event.content).membership === 'leave'
        ),
        'known archived departures must reach a retained newer client without include_leave',
      );
      const page = await call(
        'rooms/' + encodeURIComponent(kept.roomId) +
          '/messages?dir=b&limit=100&from=' +
          encodeURIComponent(String(timeline.prev_batch)),
      );
      assert(
        events(page.chunk).some((event) => event.event_id === custom.eventId),
      );
      const filteredQuery = new URLSearchParams(query);
      filteredQuery.set(
        'filter',
        JSON.stringify({
          room: { state: { not_types: ['org.example.archived'] } },
        }),
      );
      const filtered = await call('sync?' + filteredQuery);
      const filteredRoom = object(
        object(object(filtered.rooms).join)[kept.roomId],
      );
      assert(
        !events(object(filteredRoom[stateKey]).events).some((event) =>
          event.type === 'org.example.archived'
        ),
      );
      const sent = await sendLocal(room, {
        sender: alice.user_id,
        type: 'm.room.message',
        content: { msgtype: 'm.text', body: 'new era ' + stateKey + limit },
      }, signer);
      const next = await call(
        'sync?timeout=0&since=' + encodeURIComponent(String(reset.next_batch)),
      );
      const nextRoom = object(object(object(next.rooms).join)[kept.roomId]);
      assertEquals(object(nextRoom.timeline).limited, false);
      assert(
        events(object(nextRoom.timeline).events).some((event) =>
          event.event_id === sent.eventId
        ),
      );
    }
  }
});
