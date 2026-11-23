import { assert, assertEquals } from '@std/assert';
import { eventIdFor } from '#engine/eventid.ts';
import { joinResponse } from '#engine/federation/join-response.ts';
import type { Pdu } from '#engine/pdu.ts';
import { createFakeRoom } from './federation/fake-room.ts';

Deno.test('review join: partial response includes the submitted restricted join authorizer auth chain', async () => {
  const creator = '@alice:logical.test';
  const authorizer = '@bob:logical.test';
  const room = await createFakeRoom({ version: '11', creator });
  await room.addEvent({
    type: 'm.room.name',
    sender: creator,
    state_key: '',
    content: { name: 'Named restricted room' },
  });
  await room.addEvent({
    type: 'm.room.power_levels',
    sender: creator,
    state_key: '',
    content: { users: { [creator]: 100, [authorizer]: 100 } },
  });
  const member = await room.addEvent({
    type: 'm.room.member',
    sender: authorizer,
    state_key: authorizer,
    content: { membership: 'join' },
  });
  await room.addEvent({
    type: 'm.room.join_rules',
    sender: creator,
    state_key: '',
    content: {
      join_rule: 'restricted',
      allow: [{ type: 'm.room_membership', room_id: '!allowed:logical.test' }],
    },
  });
  const state = room.currentState();
  const auth = state.filter((p) =>
    ['m.room.create', 'm.room.power_levels', 'm.room.join_rules'].includes(
      p.type,
    )
  );
  const joining = await room.addEvent({
    type: 'm.room.member',
    sender: '@guest:remote.test',
    state_key: '@guest:remote.test',
    content: {
      membership: 'join',
      join_authorised_via_users_server: authorizer,
    },
    auth_events: [...auth, member].map((p) => String(p.event_id)),
  });
  const result = {
    state: state.map(room.wire),
    auth_chain: [
      ...room.authChainOf([...state, joining].map((p) => String(p.event_id))),
    ].map((id) => room.wire(room.events.get(id)!)),
    event: room.wire(joining),
    servers_in_room: ['logical.test'],
  };
  const ids = async (pdus: Pdu[]) =>
    await Promise.all(
      pdus.map((p) =>
        eventIdFor(p as unknown as Record<string, unknown>, '11')
      ),
    );
  const partial = await joinResponse(result, '11', 'v2', true);
  assert(!Array.isArray(partial));
  assertEquals(partial.members_omitted, true);
  assertEquals(
    await ids(partial.state as Pdu[]),
    await ids(state.filter((p) => p.type !== 'm.room.member')),
  );
  assert(
    (await ids(partial.auth_chain as Pdu[])).includes(String(member.event_id)),
    'omitted authorizer is required by the submitted join even when no returned state event cites it',
  );
  const full = await joinResponse(result, '11', 'v2', false);
  assert(!Array.isArray(full));
  assertEquals(full.state, result.state);
  assertEquals(full.auth_chain, result.auth_chain);
});
