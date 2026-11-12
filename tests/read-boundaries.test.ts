import { assertEquals } from '@std/assert';
import { parseCursor } from '#engine/room/segments.ts';
import { canSeeEventAt } from '#engine/client/visibility.ts';
import type { RoomTx } from '#engine/room/index.ts';

Deno.test('room cursors reject unsafe components without losing negative history offsets', () => {
  for (
    const token of [
      'c9007199254740992_0',
      'c1_9007199254740992',
      'c1_-9007199254740992',
      'c' + '9'.repeat(400) + '_0',
    ]
  ) {
    assertEquals(parseCursor(token), null, token);
  }
  assertEquals(parseCursor('c1_-42i'), {
    segment: 1,
    offset: -42,
    inclusive: true,
  });
  assertEquals(parseCursor('c9007199254740991_-9007199254740991'), {
    segment: Number.MAX_SAFE_INTEGER,
    offset: -Number.MAX_SAFE_INTEGER,
  });
});

Deno.test('visibility qualifies malformed held state content before caching and applies ordinary defaults', async () => {
  for (const content of [undefined, null, false, 3, 'invalid', []]) {
    const tx = {
      events: {
        getStatus: () =>
          Promise.resolve({ standing: 'accepted', grounding: 'grounded' }),
        get: (id: string) =>
          Promise.resolve(
            id === '$message'
              ? {
                type: 'm.room.message',
                state_key: null,
                sender: '@sender:test',
              }
              : { pdu: JSON.stringify({ content }) },
          ),
      },
      state: {
        eventReadState: () =>
          Promise.resolve({ before: { group: 1 }, after: { group: 1 } }),
        groupKey: (_group: number, type: string) => Promise.resolve(type),
        publishedGroupsAfter: () => Promise.resolve([1]),
      },
    } as unknown as RoomTx;
    assertEquals(await canSeeEventAt('@viewer:test', tx, '$message'), false);
  }
});
