// tests/relations.test.ts — band C item 6 (D7): the TestRelations /
// TestRelationsPagination / TestRelationsPaginationSync /
// TestThreadsEndpoint contract rows (spec v1.16 relations.yaml +
// threads_list.yaml + threading.md). Live doltgres, HTTP-level via the
// real endpoint trees.
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

Deno.test('relations: filters, pagination, sync-token from, threads + bundle', async () => {
  const alice = await registerTestUser('rl-a', 'pw-rl-a');
  const aTok = alice.access_token!;
  const roomId = (await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: aTok,
    body: { preset: 'public_chat' },
  })).body.room_id as string;
  const enc = encodeURIComponent(roomId);
  const send = async (
    tok: string,
    txn: string,
    content: unknown,
    type = 'm.room.message',
  ): Promise<string> => {
    const res = await call(
      `/_matrix/client/v3/rooms/${enc}/send/${type}/${txn}`,
      { method: 'PUT', token: tok, body: content },
    );
    assertEquals(res.status, 200, `${type} ${txn}`);
    return res.body.event_id as string;
  };
  const thread = (root: string) => ({
    'm.relates_to': { event_id: root, rel_type: 'm.thread' },
  });

  // --- TestRelations: filters across rel_types and event types
  const root = await send(aTok, 'rl-root', { msgtype: 'm.text', body: 'root' });
  const threadMsg = await send(aTok, 'rl-t1', {
    msgtype: 'm.text',
    body: 'reply',
    ...thread(root),
  });
  const dummy = await send(aTok, 'rl-t2', thread(root), 'm.dummy');
  const edit = await send(aTok, 'rl-t3', {
    msgtype: 'm.text',
    body: '* edited root',
    'm.new_content': { msgtype: 'm.text', body: 'edited root' },
    'm.relates_to': { event_id: root, rel_type: 'm.replace' },
  });

  const rel = `/_matrix/client/v1/rooms/${enc}/relations/${
    encodeURIComponent(root)
  }`;
  const all = await call(rel, { token: aTok });
  assertEquals(all.status, 200);
  assertEquals(
    new Set((all.body.chunk as Json[]).map((e) => e.event_id)),
    new Set([threadMsg, dummy, edit]),
  );
  const byType = await call(`${rel}/m.thread`, { token: aTok });
  assertEquals(
    new Set((byType.body.chunk as Json[]).map((e) => e.event_id)),
    new Set([threadMsg, dummy]),
  );
  const byBoth = await call(`${rel}/m.thread/m.room.message`, { token: aTok });
  assertEquals(
    (byBoth.body.chunk as Json[]).map((e) => e.event_id),
    [threadMsg],
  );
  assertEquals(
    (await call(
      `/_matrix/client/v1/rooms/${enc}/relations/${
        encodeURIComponent('$nope:x')
      }`,
      { token: aTok },
    )).status,
    404,
  );

  // --- TestRelationsPagination: 10 children, paged both directions
  const root2 = await send(aTok, 'rl-root2', {
    msgtype: 'm.text',
    body: 'root2',
  });
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) {
    ids.push(
      await send(aTok, `rl-p${i}`, {
        msgtype: 'm.text',
        body: `reply ${i}`,
        ...thread(root2),
      }),
    );
  }
  const rel2 = `/_matrix/client/v1/rooms/${enc}/relations/${
    encodeURIComponent(root2)
  }`;
  const page1 = await call(`${rel2}?limit=3`, { token: aTok });
  assertEquals(
    (page1.body.chunk as Json[]).map((e) => e.event_id),
    [ids[9], ids[8], ids[7]],
  );
  const page2 = await call(
    `${rel2}?limit=3&from=${
      encodeURIComponent(page1.body.next_batch as string)
    }`,
    { token: aTok },
  );
  assertEquals(
    (page2.body.chunk as Json[]).map((e) => e.event_id),
    [ids[6], ids[5], ids[4]],
  );
  const fwd1 = await call(`${rel2}?limit=3&dir=f`, { token: aTok });
  assertEquals(
    (fwd1.body.chunk as Json[]).map((e) => e.event_id),
    [ids[0], ids[1], ids[2]],
  );
  const fwd2 = await call(
    `${rel2}?limit=3&dir=f&from=${
      encodeURIComponent(fwd1.body.next_batch as string)
    }`,
    { token: aTok },
  );
  assertEquals(
    (fwd2.body.chunk as Json[]).map((e) => e.event_id),
    [ids[3], ids[4], ids[5]],
  );

  // --- TestRelationsPaginationSync: a /sync next_batch token as from
  const root3 = await send(aTok, 'rl-root3', {
    msgtype: 'm.text',
    body: 'root3',
  });
  for (let i = 0; i < 5; i++) {
    await send(aTok, `rl-b${i}`, {
      msgtype: 'm.text',
      body: `before ${i}`,
      ...thread(root3),
    });
  }
  const syncToken = (await call('/_matrix/client/v3/sync?timeout=0', {
    token: aTok,
  })).body.next_batch as string;
  const after: string[] = [];
  for (let i = 0; i < 5; i++) {
    after.push(
      await send(aTok, `rl-a${i}`, {
        msgtype: 'm.text',
        body: `after ${i}`,
        ...thread(root3),
      }),
    );
  }
  const rel3 = `/_matrix/client/v1/rooms/${enc}/relations/${
    encodeURIComponent(root3)
  }`;
  const syncPage = await call(
    `${rel3}?limit=3&dir=f&from=${encodeURIComponent(syncToken)}`,
    { token: aTok },
  );
  assertEquals(
    (syncPage.body.chunk as Json[]).map((e) => e.event_id),
    [after[0], after[1], after[2]],
  );

  // --- TestThreadsEndpoint: ordering, bundle fields, re-ordering
  const t1 = await send(aTok, 'rl-tr1', {
    msgtype: 'm.text',
    body: 'Thread 1 Root',
  });
  const t2 = await send(aTok, 'rl-tr2', {
    msgtype: 'm.text',
    body: 'Thread 2 Root',
  });
  const r1 = await send(aTok, 'rl-tr3', {
    msgtype: 'm.text',
    body: 'Thread 1 Reply',
    ...thread(t1),
  });
  const r2 = await send(aTok, 'rl-tr4', {
    msgtype: 'm.text',
    body: 'Thread 2 Reply',
    ...thread(t2),
  });
  const threadsPath = `/_matrix/client/v1/rooms/${enc}/threads`;
  let res = await call(threadsPath, { token: aTok });
  assertEquals(res.status, 200);
  let chunk = res.body.chunk as Json[];
  assertEquals(
    chunk.map((e) => e.event_id).slice(0, 2),
    [t2, t1],
  );
  const bundle2 = ((chunk[0].unsigned as Json)['m.relations'] as Json)[
    'm.thread'
  ] as Json;
  assertEquals((bundle2.latest_event as Json).event_id, r2);
  assertEquals(bundle2.count, 1);
  assertEquals(bundle2.current_user_participated, true);
  const bundle1First = ((chunk[1].unsigned as Json)['m.relations'] as Json)[
    'm.thread'
  ] as Json;
  assertEquals((bundle1First.latest_event as Json).event_id, r1);

  // a new reply to thread 1 moves it to the top
  const r3 = await send(aTok, 'rl-tr5', {
    msgtype: 'm.text',
    body: 'Thread 1 Reply 2',
    ...thread(t1),
  });
  res = await call(threadsPath, { token: aTok });
  chunk = res.body.chunk as Json[];
  assertEquals(
    chunk.map((e) => e.event_id).slice(0, 2),
    [t1, t2],
  );
  const bundle1 = ((chunk[0].unsigned as Json)['m.relations'] as Json)[
    'm.thread'
  ] as Json;
  assertEquals((bundle1.latest_event as Json).event_id, r3);
  assertEquals(bundle1.count, 2);

  // the root bundles its aggregation in /messages too (D7 via
  // event-format), and include=participated filters
  const msgs = await call(
    `/_matrix/client/v3/rooms/${enc}/messages?dir=b&limit=20`,
    { token: aTok },
  );
  const rootEv = (msgs.body.chunk as Json[]).find((e) => e.event_id === t1);
  assert(rootEv !== undefined, 'root in /messages');
  assert(
    (((rootEv!.unsigned as Json)['m.relations'] as Json) ?? {})['m.thread'] !==
      undefined,
    'bundled in /messages',
  );
  const part = await call(`${threadsPath}?include=participated`, {
    token: (await registerTestUser('rl-b2', 'pw-rl-b2')).access_token!,
  });
  assertEquals((part.body.chunk as Json[]).length, 0);
  assertEquals(
    ((await call(threadsPath, { token: aTok })).body.chunk as Json[])
      .length >= 2,
    true,
  );
});
