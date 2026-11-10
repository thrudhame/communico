import { assertEquals, assertThrows } from '@std/assert';
import {
  eventMatchesRoomEventFilter as matches,
  roomFilterOf,
  validateFilterDocument,
} from '#engine/tenant/filters.ts';

Deno.test('shared filter wildcard grammar, denials, absent and empty lists', () => {
  const event = {
    type: 'a.b.c',
    sender: '@a:test',
    room_id: '!r:test',
    content: { url: '' },
  };
  assertEquals(matches(null, event, { types: ['a.*.c'] }), true);
  assertEquals(matches(null, event, { types: ['a.?*'] }), false);
  assertEquals(
    matches(null, event, { types: ['a.*'], not_types: ['*.c'] }),
    false,
  );
  assertEquals(matches(null, event, { senders: [] }), false);
  assertEquals(
    matches(null, event, { senders: ['@a:test'], not_senders: ['@a:test'] }),
    false,
  );
  assertEquals(matches(null, event, { rooms: [] }), false);
  assertEquals(
    matches(null, event, { rooms: ['!r:test'], not_rooms: ['!r:test'] }),
    false,
  );
  assertEquals(matches(null, event, { contains_url: true }), true);
  assertEquals(
    matches(null, { ...event, content: { url: null } }, { contains_url: true }),
    false,
  );
});

Deno.test('all inline and stored filter sections use the same shape validation', () => {
  for (
    const document of [
      { presence: { senders: [12] } },
      { account_data: { limit: -1 } },
      { room: { include_leave: 'yes' } },
      { room: { timeline: { contains_url: 1 } } },
      { room: { state: { lazy_load_members: 'yes' } } },
      { room: { ephemeral: { not_types: 1 } } },
      { room: { rooms: [false] } },
      { event_fields: [null] },
      { event_format: 'other' },
    ]
  ) {
    assertThrows(() => validateFilterDocument(document));
    assertThrows(() => roomFilterOf(document));
  }
});
