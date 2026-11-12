import { assert, assertEquals } from '@std/assert';
import {
  accountDataExtension,
  extensionRooms,
  receiptCaptureSince,
  receiptsExtension,
  typingExtension,
} from '#engine/sliding-sync/extensions.ts';
import { slidingSyncRequest } from '#engine/sliding-sync/request.ts';
import { captureTyping, setTyping } from '#engine/typing.ts';
import type { ReceiptRow } from '#engine/server/ephemeral.ts';
import { openStore } from '#engine/store/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import type { AccountDataRow } from '#engine/tenant/accountdata.ts';

Deno.test('sliding extensions: scope is admitted list windows plus actual subscriptions, never requested arbitrary rooms', () => {
  const scope = {
    lists: new Map([
      ['all', new Set(['!a:test', '!b:test'])],
      ['dm', new Set(['!b:test'])],
      ['empty', new Set<string>()],
    ]),
    subscriptions: new Set(['!c:test']),
  };
  const request = (value: unknown) =>
    slidingSyncRequest(
      { extensions: { typing: value } },
      new URLSearchParams(),
      30000,
    ).extensions.typing;
  assertEquals([...extensionRooms(request({ enabled: true }), scope)], [
    '!a:test',
    '!b:test',
    '!c:test',
  ]);
  assertEquals([
    ...extensionRooms(request({ enabled: true, lists: [], rooms: [] }), scope),
  ], []);
  assertEquals([...extensionRooms(request({ enabled: false }), scope)], []);
  assertEquals([...extensionRooms(undefined, scope)], []);
  assertEquals([
    ...extensionRooms(
      request({
        enabled: true,
        lists: ['dm', 'missing'],
        rooms: ['!a:test', '!c:test', '!outside:test'],
      }),
      scope,
    ),
  ], ['!b:test', '!c:test']);
  assertEquals([
    ...extensionRooms(
      request({ enabled: true, lists: ['empty'], rooms: [] }),
      scope,
    ),
  ], []);
});

Deno.test('sliding extensions: account-data cuts advance selected rooms only and constant envelopes are not relevant', () => {
  const snapshot = {
    seq: 20,
    global: [{ type: 'u.global', content: { n: 1 } }],
    rooms: new Map<string, AccountDataRow[]>([
      ['!a:test', [{ type: 'm.tag', content: { tags: {} } }]],
      ['!b:test', [{ type: 'u.hidden', content: {} }]],
    ]),
  };
  const old = { '!a:test': 5, '!b:test': 4 };
  const result = accountDataExtension(snapshot, new Set(['!a:test']), old);
  assert(result.relevant);
  assertEquals(result.cuts, { '!a:test': 20, '!b:test': 4 });
  assertEquals(result.response.rooms, {
    '!a:test': snapshot.rooms.get('!a:test')!,
  });
  assertEquals(old, { '!a:test': 5, '!b:test': 4 });
  const quiet = accountDataExtension(
    { seq: 21, global: [], rooms: new Map([['!a:test', []]]) },
    new Set(['!a:test']),
    result.cuts,
  );
  assertEquals(quiet.relevant, false);
  assertEquals(quiet.response, { global: [], rooms: {} });
  assertEquals(quiet.cuts, { '!a:test': 21, '!b:test': 4 });
  const uncaptured = accountDataExtension(
    { seq: 22, global: [], rooms: new Map() },
    new Set(['!a:test', '!missing:test']),
    quiet.cuts,
  );
  assertEquals(uncaptured.cuts, quiet.cuts);
});

Deno.test('sliding extensions: initial/expanded receipts include timeline targets plus own marks; private rows never cross viewers', () => {
  assertEquals(receiptCaptureSince(undefined, undefined), 0);
  assertEquals(receiptCaptureSince(undefined, 10), 10);
  assertEquals(receiptCaptureSince({ initial: true }, 10), 0);
  assertEquals(
    receiptCaptureSince({ unstable_expanded_timeline: true }, 10),
    0,
  );
  const viewer = '@alice:test';
  const mark = (
    userId: string,
    eventId: string,
    seq: number,
    receiptType: ReceiptRow['receiptType'] = 'm.read',
    threadId: string | null = null,
  ): ReceiptRow => ({ userId, eventId, seq, receiptType, threadId, ts: seq });
  const snapshot = new Map([
    ['!a:test', [
      mark('@bob:test', '$timeline', 1),
      mark('@bob:test', '$old', 2),
      mark(viewer, '$own-old', 3, 'm.read.private', '$root'),
      mark('@bob:test', '$timeline', 4, 'm.read.private'),
      mark('@carol:test', '$future', 11),
    ]],
    ['!outside:test', [mark('@bob:test', '$outside', 5)]],
  ]);
  const selected = new Set(['!a:test']);
  const timelines = {
    '!a:test': { initial: true, timeline: [{ event_id: '$timeline' }] },
  };
  const initial = receiptsExtension(
    viewer,
    selected,
    snapshot,
    10,
    {},
    timelines,
  );
  assert(initial.relevant);
  assertEquals(Object.keys(initial.response.rooms['!a:test'].content).sort(), [
    '$own-old',
    '$timeline',
  ]);
  assertEquals(
    initial.response.rooms['!a:test'].content.$timeline['m.read.private'],
    undefined,
  );
  assertEquals(
    initial.response.rooms['!a:test']
      .content['$own-old']['m.read.private'][viewer],
    { ts: 3, thread_id: '$root' },
  );
  assertEquals(initial.cuts, { '!a:test': 10 });
  const quiet = receiptsExtension(
    viewer,
    selected,
    snapshot,
    10,
    initial.cuts,
    {},
  );
  assertEquals(quiet.response, { rooms: {} });
  assertEquals(quiet.relevant, false);
  const expanded = receiptsExtension(
    viewer,
    selected,
    snapshot,
    10,
    initial.cuts,
    {
      '!a:test': {
        unstable_expanded_timeline: true,
        timeline: [{ event_id: '$old' }],
      },
    },
  );
  assertEquals(Object.keys(expanded.response.rooms['!a:test'].content).sort(), [
    '$old',
    '$own-old',
  ]);
  const returned = receiptsExtension(viewer, selected, snapshot, 11, {
    '!a:test': 2,
    '!other:test': 1,
  }, {});
  assertEquals(Object.keys(returned.response.rooms['!a:test'].content).sort(), [
    '$future',
    '$own-old',
  ]);
  assertEquals(returned.cuts, { '!a:test': 11, '!other:test': 1 });
});

Deno.test('sliding extensions: typing captures immutable values, explicit/expired stops, window gaps and process-reset cuts', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'sliding-typing-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema } });
  const room = '!typing-ext:test', user = '@alice:test';
  try {
    const server = await store.server();
    await server.execute(
      'INSERT INTO memberships(user,room,membership,event,seq) VALUES(?,?,?,?,?)',
      [user, room, 'join', '$join', 1],
    );
    const selected = new Set([room]);
    await setTyping(server, room, user, true, 30000);
    const captured = captureTyping(selected);
    await setTyping(server, room, user, false);
    const first = typingExtension(selected, captured, undefined);
    assertEquals(first.response.rooms[room].content.user_ids, [user]);
    assertEquals(
      typingExtension(selected, captured, first.cuts).relevant,
      false,
    );
    const stop = typingExtension(selected, captureTyping(selected), first.cuts);
    assertEquals(stop.response.rooms[room].content.user_ids, []);
    // Moving a room out of the window cannot advance its last delivered cut.
    const outside = typingExtension(new Set(), captureTyping([]), first.cuts);
    assertEquals(outside.cuts.rooms, first.cuts.rooms);
    const reenter = typingExtension(
      selected,
      captureTyping(selected),
      outside.cuts,
    );
    assertEquals(reenter.response.rooms[room].content.user_ids, []);
    await setTyping(server, room, user, true, 0);
    const expired = typingExtension(
      selected,
      captureTyping(selected),
      stop.cuts,
    );
    assertEquals(expired.response.rooms[room].content.user_ids, []);
    const restarted = typingExtension(selected, captureTyping(selected), {
      epoch: 'prior-process',
      rooms: { [room]: Number.MAX_SAFE_INTEGER },
    });
    assertEquals(restarted.response.rooms[room].content.user_ids, []);
    assertEquals(
      typingExtension(selected, captureTyping(selected), restarted.cuts)
        .relevant,
      false,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
