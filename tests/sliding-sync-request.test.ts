import { assertEquals, assertThrows } from '@std/assert';
import { slidingSyncRequest } from '#engine/sliding-sync/request.ts';
import { MatrixError } from '#engine/matrix-error.ts';

const room = { required_state: [['m.room.member', '$ME']], timeline_limit: 1 };
const parse = (body: unknown, query = '') =>
  slidingSyncRequest(body, new URLSearchParams(query), 30000);

Deno.test('sliding request: deployed SDK dialect, defaults and nonsticky selections', () => {
  const first = parse({
    conn_id: 'room-list',
    lists: {
      all: {
        ...room,
        ranges: [[0, 19]],
        filters: { is_dm: false, room_types: [null, 'm.space'] },
      },
    },
    room_subscriptions: { '!x:test': { ...room, timeline_limit: 20 } },
    extensions: {
      account_data: { enabled: true },
      typing: { enabled: true, lists: [], rooms: [] },
      future: { arbitrary: true },
    },
  }, 'pos=opaque&timeout=60000');
  assertEquals(first.connId, 'room-list');
  assertEquals(first.pos, 'opaque');
  assertEquals(first.timeoutMs, 30000);
  assertEquals(first.lists.all.ranges, [[0, 19]]);
  assertEquals(first.lists.all.filters.is_dm, false);
  assertEquals(first.subscriptions['!x:test'].timelineLimit, 20);
  assertEquals(first.extensions.account_data, {
    enabled: true,
    lists: ['*'],
    rooms: ['*'],
  });
  assertEquals(first.extensions.typing, {
    enabled: true,
    lists: [],
    rooms: [],
  });
  assertEquals(Object.hasOwn(first.extensions, 'future'), false);
  assertEquals(parse({}).lists, {});
  assertEquals(parse({}).subscriptions, {});
  assertEquals(parse({}).connId, '');
  assertEquals(parse({}).pos, null);
  assertEquals(parse({ lists: { a: room } }).lists.a.ranges, null);
  assertEquals(
    parse({ lists: { a: { ...room, ranges: [] } } }).lists.a.ranges,
    [],
  );
  assertEquals(
    parse({ extensions: { to_device: { enabled: true } } }).extensions
      .to_device,
    { enabled: true, limit: 100, since: null },
  );
});

Deno.test('sliding request: strict safe shapes before connection mutation', () => {
  const invalid: unknown[] = [
    null,
    [],
    5,
    { conn_id: 4 },
    { conn_id: 'x'.repeat(65) },
    { lists: [] },
    { lists: { a: { timeline_limit: 1 } } },
    { lists: { a: { ...room, timeline_limit: -1 } } },
    { lists: { a: { ...room, timeline_limit: 1001 } } },
    { lists: { a: { ...room, required_state: [['m.x']] } } },
    { lists: { a: { ...room, ranges: [[2, 1]] } } },
    { lists: { a: { ...room, ranges: [[0, 1.1]] } } },
    { lists: { a: { ...room, ranges: [[0, Number.MAX_SAFE_INTEGER + 1]] } } },
    { lists: { a: { ...room, filters: { is_dm: 'false' } } } },
    { lists: { a: { ...room, filters: { room_types: [0] } } } },
    { lists: { a: { ...room, filters: { spaces: [null] } } } },
    { room_subscriptions: { '!x:test': { ...room, timeline_limit: '1' } } },
    { extensions: { e2ee: { enabled: 'true' } } },
    { extensions: { receipts: { enabled: true, rooms: [false] } } },
    { extensions: { to_device: { enabled: true, limit: -1 } } },
    { extensions: { to_device: { enabled: true, since: 1 } } },
    {
      lists: Object.fromEntries(
        Array.from({ length: 101 }, (_, n) => [String(n), room]),
      ),
    },
    {
      room_subscriptions: Object.fromEntries(
        Array.from({ length: 101 }, (_, n) => ['!' + n + ':t', room]),
      ),
    },
  ];
  for (const body of invalid) assertThrows(() => parse(body), MatrixError);
  for (
    const query of [
      'timeout=no',
      'timeout=-1',
      'timeout=1.1',
      'timeout=9007199254740992',
      'pos=',
      'set_presence=hidden',
    ]
  ) {
    assertThrows(() => parse({}, query), MatrixError);
  }
  assertEquals(
    parse({ extensions: { to_device: { limit: 500 } } }).extensions.to_device
      ?.limit,
    100,
  );
  assertEquals(parse({}, 'set_presence=offline').setPresence, 'offline');
});

Deno.test('sliding request: arbitrary map keys do not become prototype properties', () => {
  const parsed = parse(
    JSON.parse(
      '{"lists":{"__proto__":{"required_state":[],"timeline_limit":0},"constructor":{"required_state":[],"timeline_limit":0}}}',
    ),
  );
  assertEquals(Object.keys(parsed.lists).sort(), ['__proto__', 'constructor']);
  assertEquals(parsed.lists.__proto__.timelineLimit, 0);
});
