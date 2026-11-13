import { assertEquals, assertThrows } from '@std/assert';
import { searchPage } from '#engine/client/search-page.ts';
import { searchRequest } from '#engine/client/search-request.ts';

Deno.test('grouped search constructs group order without rescanning existing groups', () => {
  const hits = Array.from({ length: 200 }, (_, i) => ({
    eventId: '$' + i,
    roomId: '!room' + i + ':test',
    sender: '@user' + i + ':test',
    rank: 1,
    seq: 200 - i,
  }));
  const request = searchRequest({
    search_term: 'word',
    filter: { limit: 200 },
    groupings: { group_by: [{ key: 'room_id' }, { key: 'sender' }] },
  });
  const keys = Object.keys;
  let scans = 0;
  Object.keys = ((value: object) => {
    scans++;
    return keys(value);
  }) as typeof Object.keys;
  let result;
  try {
    result = searchPage(hits, request, null);
  } finally {
    Object.keys = keys;
  }
  assertEquals(scans, 0);
  assertEquals(result.page.length, 200);
  for (const [i, hit] of hits.entries()) {
    assertEquals(result.groups.room_id[hit.roomId].order, i);
    assertEquals(result.groups.sender[hit.sender].order, i);
  }
});

Deno.test('search rejects zero result limits without changing the generic timeline filter', () => {
  assertThrows(() =>
    searchRequest({ search_term: 'word', filter: { limit: 0 } })
  );
});
