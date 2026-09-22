// tests/search.test.ts — POST /search (search.yaml at v1.16). The six
// Complement rows verbatim (apidoc_search_test.go), plus AND-token
// semantics, keys, visibility, default limit, include_state/groupings/
// include_profile. Live doltgres, HTTP-level via the real endpoint trees.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { registerTestUser } from './util.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });

type Json = Record<string, unknown>;

async function call(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (init.token !== undefined) headers.Authorization = `Bearer ${init.token}`;
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const res = await matrix(
    new Request(`http://x${path}`, {
      method: init.method ?? 'GET',
      headers,
      body,
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : JSON.parse(text) };
}

function roomEvents(body: Json): Json {
  return ((body.search_categories as Json).room_events as Json);
}

async function sendText(
  token: string,
  roomId: string,
  text: string,
  txn: string,
): Promise<string> {
  const res = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/send/m.room.message/${txn}`,
    { method: 'PUT', token, body: { msgtype: 'm.text', body: text } },
  );
  assertEquals(res.status, 200);
  return res.body.event_id as string;
}

Deno.test('search: Complement rows, tokens, keys, visibility, shapes', async (t) => {
  const alice = await registerTestUser('se-a', 'pw-se-a');
  const bob = await registerTestUser('se-b', 'pw-se-b');
  const A = alice.access_token!;
  const B = bob.access_token!;

  const mk = async (body: unknown = { preset: 'private_chat' }) => {
    const res = await call('/_matrix/client/v3/createRoom', {
      method: 'POST',
      token: A,
      body,
    });
    assertEquals(res.status, 200);
    return res.body.room_id as string;
  };
  const search = (
    tok: string,
    roomEventsBody: Json,
    nextBatch?: string,
  ) => {
    const q = nextBatch !== undefined
      ? `?next_batch=${encodeURIComponent(nextBatch)}`
      : '';
    return call(`/_matrix/client/v3/search${q}`, {
      method: 'POST',
      token: tok,
      body: { search_categories: { room_events: roomEventsBody } },
    });
  };

  await t.step('Can search for an event by body', async () => {
    const roomId = await mk();
    const eventId = await sendText(A, roomId, 'hello, world', 'se-body');
    const res = await search(A, {
      keys: ['content.body'],
      search_term: 'hello',
      filter: { rooms: [roomId] },
    });
    assertEquals(res.status, 200);
    const re = roomEvents(res.body);
    assertEquals(re.count, 1);
    const hit = (re.results as Json[])[0].result as Json;
    assertEquals(hit.event_id, eventId);
    assertEquals(hit.room_id, roomId);
    assertEquals((hit.content as Json).body, 'hello, world');
    assertEquals(hit.type, 'm.room.message');
  });

  await t.step('Can get context around search results', async () => {
    const roomId = await mk();
    for (let i = 1; i <= 7; i++) {
      await sendText(A, roomId, `Message number ${i}`, `se-ctx-${i}`);
    }
    const res = await search(A, {
      keys: ['content.body'],
      search_term: 'Message 4',
      order_by: 'recent',
      filter: { limit: 1, rooms: [roomId] },
      event_context: { before_limit: 2, after_limit: 2 },
    });
    assertEquals(res.status, 200);
    const re = roomEvents(res.body);
    assertEquals(re.count, 1);
    assert(typeof re.next_batch === 'string');
    const row = (re.results as Json[])[0];
    const hit = row.result as Json;
    assertEquals((hit.content as Json).body, 'Message number 4');
    const before = (row.context as Json).events_before as Json[];
    const after = (row.context as Json).events_after as Json[];
    assertEquals((before[0].content as Json).body, 'Message number 3');
    assertEquals((before[1].content as Json).body, 'Message number 2');
    assertEquals((after[0].content as Json).body, 'Message number 5');
    assertEquals((after[1].content as Json).body, 'Message number 6');
  });

  await t.step('Can back-paginate search results', async () => {
    const roomId = await mk();
    const eventIds: string[] = [];
    for (let i = 0; i <= 19; i++) {
      eventIds.push(
        await sendText(A, roomId, `Message number ${i}`, `se-page-${i}`),
      );
    }
    const body: Json = {
      keys: ['content.body'],
      search_term: 'Message',
      order_by: 'recent',
      filter: { limit: 10, rooms: [roomId] },
    };
    const p1 = await search(A, body);
    assertEquals(p1.status, 200);
    const r1 = roomEvents(p1.body);
    assertEquals(r1.count, 20);
    assert(typeof r1.next_batch === 'string');
    const hits1 = r1.results as Json[];
    assertEquals((hits1[0].result as Json).event_id, eventIds[19]);
    assertEquals((hits1[9].result as Json).event_id, eventIds[10]);

    const p2 = await search(A, body, r1.next_batch as string);
    assertEquals(p2.status, 200);
    const r2 = roomEvents(p2.body);
    assertEquals(r2.count, 20);
    assert(typeof r2.next_batch === 'string');
    const hits2 = r2.results as Json[];
    assertEquals((hits2[0].result as Json).event_id, eventIds[9]);
    assertEquals((hits2[9].result as Json).event_id, eventIds[0]);

    const p3 = await search(A, body, r2.next_batch as string);
    assertEquals(p3.status, 200);
    const r3 = roomEvents(p3.body);
    assertEquals(r3.count, 20);
    assertEquals((r3.results as Json[]).length, 0);
    assertEquals(r3.next_batch, undefined);
  });

  await t.step(
    'Search works across an upgraded room and its predecessor',
    async () => {
      const roomId = await mk({ preset: 'private_chat', room_version: '8' });
      const beforeId = await sendText(
        A,
        roomId,
        'Message before upgrade',
        'se-up-b',
      );
      const up = await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/upgrade`,
        { method: 'POST', token: A, body: { new_version: '9' } },
      );
      assertEquals(up.status, 200);
      const newRoomId = up.body.replacement_room as string;
      const afterId = await sendText(
        A,
        newRoomId,
        'Message after upgrade',
        'se-up-a',
      );

      const both = await search(A, {
        keys: ['content.body'],
        search_term: 'upgrade',
        filter: { rooms: [roomId, newRoomId] },
      });
      assertEquals(both.status, 200);
      const reBoth = roomEvents(both.body);
      assertEquals(reBoth.count, 2);
      const idsBoth = new Set(
        (reBoth.results as Json[]).map((r) =>
          (r.result as Json).event_id as string
        ),
      );
      assert(idsBoth.has(beforeId) && idsBoth.has(afterId));

      const onlyNew = await search(A, {
        keys: ['content.body'],
        search_term: 'upgrade',
        filter: { rooms: [newRoomId] },
      });
      assertEquals(onlyNew.status, 200);
      const reNew = roomEvents(onlyNew.body);
      assertEquals(reNew.count, 2);
      const idsNew = new Set(
        (reNew.results as Json[]).map((r) =>
          (r.result as Json).event_id as string
        ),
      );
      assert(idsNew.has(beforeId) && idsNew.has(afterId));
    },
  );

  await t.step(
    'Search results with rank/recent ordering do not include redacted events',
    async () => {
      for (const ordering of ['rank', 'recent']) {
        const roomId = await mk();
        const redactedId = await sendText(
          A,
          roomId,
          'This message is going to be redacted',
          `se-red-${ordering}-r`,
        );
        const visibleId = await sendText(
          A,
          roomId,
          'This message is not going to be redacted',
          `se-red-${ordering}-v`,
        );
        const red = await call(
          `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${
            encodeURIComponent(redactedId)
          }/se-red-${ordering}`,
          { method: 'PUT', token: A, body: { reason: 'testing' } },
        );
        assertEquals(red.status, 200);
        const res = await search(A, {
          keys: ['content.body'],
          order_by: ordering,
          search_term: 'redacted',
          filter: { rooms: [roomId] },
        });
        assertEquals(res.status, 200, ordering);
        const re = roomEvents(res.body);
        const hits = re.results as Json[];
        assertEquals(hits.length, 1, ordering);
        const hit = hits[0].result as Json;
        assertEquals(hit.event_id, visibleId, ordering);
        assertEquals(
          (hit.content as Json).body,
          'This message is not going to be redacted',
          ordering,
        );
      }
    },
  );

  await t.step('AND-token semantics', async () => {
    const roomId = await mk();
    const ids: string[] = [];
    for (let i = 1; i <= 7; i++) {
      ids.push(await sendText(A, roomId, `Message number ${i}`, `se-and-${i}`));
    }
    const only4 = await search(A, {
      keys: ['content.body'],
      search_term: 'Message 4',
      filter: { rooms: [roomId] },
    });
    assertEquals(roomEvents(only4.body).count, 1);
    assertEquals(
      ((roomEvents(only4.body).results as Json[])[0].result as Json)
        .event_id,
      ids[3],
    );
    const all = await search(A, {
      keys: ['content.body'],
      search_term: 'number message',
      filter: { rooms: [roomId] },
    });
    assertEquals(roomEvents(all.body).count, 7);
  });

  await t.step('keys restriction: content.name hit vs miss', async () => {
    const roomId = await mk({ name: 'UniqueSearchName' });
    await sendText(A, roomId, 'hello', 'se-keys');
    const hit = await search(A, {
      keys: ['content.name'],
      search_term: 'UniqueSearchName',
      filter: { rooms: [roomId] },
    });
    assertEquals(roomEvents(hit.body).count, 1);
    const miss = await search(A, {
      keys: ['content.body'],
      search_term: 'UniqueSearchName',
      filter: { rooms: [roomId] },
    });
    assertEquals(roomEvents(miss.body).count, 0);
  });

  await t.step(
    'visibility: joined history hides pre-join messages from later joiner',
    async () => {
      const roomId = await mk({
        preset: 'public_chat',
        initial_state: [
          {
            type: 'm.room.history_visibility',
            state_key: '',
            content: { history_visibility: 'joined' },
          },
        ],
      });
      await sendText(A, roomId, 'secret prejoin', 'se-vis');
      assertEquals(
        (await call(
          `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
          { method: 'POST', token: B, body: {} },
        )).status,
        200,
      );
      const res = await search(B, {
        keys: ['content.body'],
        search_term: 'secret prejoin',
        filter: { rooms: [roomId] },
      });
      assertEquals(res.status, 200);
      assertEquals(roomEvents(res.body).count, 0);
    },
  );

  await t.step('filter.limit default 10', async () => {
    const roomId = await mk();
    for (let i = 0; i < 15; i++) {
      await sendText(A, roomId, 'DefaultLimitNeedle', `se-lim-${i}`);
    }
    const res = await search(A, {
      keys: ['content.body'],
      search_term: 'DefaultLimitNeedle',
      filter: { rooms: [roomId] },
    });
    const re = roomEvents(res.body);
    assertEquals(re.count, 15);
    assertEquals((re.results as Json[]).length, 10);
    assertEquals(re.next_batch, undefined);
  });

  await t.step('include_state, groupings, include_profile', async () => {
    const roomId = await mk();
    assertEquals(
      (await call(
        `/_matrix/client/v3/profile/${
          encodeURIComponent(alice.user_id as string)
        }/displayname`,
        { method: 'PUT', token: A, body: { displayname: 'Search Alice' } },
      )).status,
      200,
    );
    const eventId = await sendText(A, roomId, 'shape needle', 'se-shape');
    const res = await search(A, {
      keys: ['content.body'],
      search_term: 'shape needle',
      filter: { rooms: [roomId] },
      include_state: true,
      groupings: { group_by: [{ key: 'room_id' }, { key: 'sender' }] },
      event_context: { include_profile: true, before_limit: 0, after_limit: 0 },
    });
    assertEquals(res.status, 200);
    const re = roomEvents(res.body);
    const state = re.state as Record<string, Json[]>;
    assert(Array.isArray(state[roomId]));
    assert(state[roomId].some((e) => e.type === 'm.room.create'));
    const groups = re.groups as Record<string, Record<string, Json>>;
    assertEquals(groups.room_id[roomId].results, [eventId]);
    assertEquals(typeof groups.room_id[roomId].order, 'number');
    const sender = alice.user_id as string;
    assertEquals(groups.sender[sender].results, [eventId]);
    const ctx = (re.results as Json[])[0].context as Json;
    const profiles = ctx.profile_info as Record<string, Json>;
    assertEquals(profiles[sender].displayname, 'Search Alice');
  });
});
