import { assertEquals } from '@std/assert';
import { capabilities } from '#engine/facade/capabilities.ts';

Deno.test('F2 room read adapters and legacy aliases share local client admission', () => {
  const paths = [
    'v1/room_summary/room',
    'v1/rooms/room/hierarchy',
    'v1/rooms/room/relations/event',
    'v1/rooms/room/relations/event/m.annotation',
    'v1/rooms/room/relations/event/m.annotation/m.reaction',
    'v1/rooms/room/threads',
    'v1/rooms/room/timestamp_to_event',
    'unstable/im.nheko.summary/summary/room',
    'unstable/im.nheko.summary/rooms/room/summary',
    'r0/rooms/room/messages',
    'r0/rooms/room/joined_members',
  ];
  for (const path of paths) {
    const request = new Request('https://facade.test/_matrix/client/' + path);
    let required: string | undefined;
    const f2 = capabilities('facade', 'f2');
    assertEquals(
      f2.gate(request, (scope) => {
        required = scope;
        return true;
      }),
      null,
      path,
    );
    assertEquals(required, 'clientrooms', path);
    assertEquals(f2.gate(request, () => false)?.status, 503, path);
    assertEquals(
      capabilities('facade', 'f1').gate(request, () => true)?.status,
      404,
      path,
    );
    assertEquals(
      f2.gate(new Request(request.url, { method: 'POST' }), () => true)?.status,
      405,
      path,
    );
  }
});

Deno.test('F2 complete-list routes share the client room scope', () => {
  for (
    const [method, path] of [
      ['GET', 'joined_rooms'],
      ['POST', 'user_directory/search'],
    ]
  ) {
    const request = new Request(
      'https://facade.test/_matrix/client/v3/' + path,
      { method },
    );
    const f2 = capabilities('facade', 'f2');
    let required: string | undefined;
    assertEquals(
      f2.gate(request, (scope) => {
        required = scope;
        return true;
      }),
      null,
    );
    assertEquals(required, 'clientrooms');
    assertEquals(f2.gate(request, () => false)?.status, 503);
    assertEquals(
      capabilities('facade', 'f1').gate(request, () => true)?.status,
      404,
    );
    assertEquals(
      f2.gate(new Request(request.url, { method: 'PUT' }), () => true)?.status,
      405,
    );
  }
});
