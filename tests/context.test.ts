// tests/context.test.ts — GET /rooms/{roomId}/context/{eventId}
// (event_context.yaml at v1.16). Limit split, filter not applied to
// event, state at last returned event, 404 for an invisible anchor,
// left-user clamp, v12 create carries room_id. Live doltgres, HTTP-level.
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

function contextUrl(
  roomId: string,
  eventId: string,
  query = '',
): string {
  return `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/context/${
    encodeURIComponent(eventId)
  }${query}`;
}

function bodies(events: Json[]): string[] {
  return events.map((e) => String((e.content as Json).body ?? ''));
}

Deno.test('GET /context: split, filter, state, visibility, clamp, v12 room_id', async (t) => {
  const alice = await registerTestUser('ctx-a', 'pw-ctx-a');
  const bob = await registerTestUser('ctx-b', 'pw-ctx-b');
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

  await t.step(
    'limit split: floor(n/2) before, n−before after; limit 0 keeps event',
    async () => {
      const roomId = await mk();
      const ids: string[] = [];
      for (let i = 1; i <= 7; i++) {
        ids.push(await sendText(A, roomId, `Message ${i}`, `ctx-split-${i}`));
      }
      const res = await call(contextUrl(roomId, ids[3], '?limit=4'), {
        token: A,
      });
      assertEquals(res.status, 200);
      assertEquals((res.body.event as Json).event_id, ids[3]);
      assertEquals(bodies(res.body.events_before as Json[]), [
        'Message 3',
        'Message 2',
      ]);
      assertEquals(bodies(res.body.events_after as Json[]), [
        'Message 5',
        'Message 6',
      ]);
      const zero = await call(contextUrl(roomId, ids[3], '?limit=0'), {
        token: A,
      });
      assertEquals(zero.status, 200);
      assertEquals((zero.body.event as Json).event_id, ids[3]);
      assertEquals(zero.body.events_before, []);
      assertEquals(zero.body.events_after, []);
      const def = await call(contextUrl(roomId, ids[3]), { token: A });
      assertEquals(def.status, 200);
      const nBefore = (def.body.events_before as Json[]).length;
      const nAfter = (def.body.events_after as Json[]).length;
      assert(nBefore + nAfter <= 10);
    },
  );

  await t.step(
    'filter applies to before/after/state, not to event',
    async () => {
      const roomId = await mk();
      const eventId = await sendText(A, roomId, 'keep me', 'ctx-filt-1');
      const filter = encodeURIComponent(
        JSON.stringify({ types: ['m.room.member'] }),
      );
      const res = await call(
        contextUrl(roomId, eventId, `?limit=10&filter=${filter}`),
        { token: A },
      );
      assertEquals(res.status, 200);
      const event = res.body.event as Json;
      assertEquals(event.event_id, eventId);
      assertEquals(event.type, 'm.room.message');
      for (const e of res.body.events_before as Json[]) {
        assertEquals(e.type, 'm.room.member');
      }
      for (const e of res.body.events_after as Json[]) {
        assertEquals(e.type, 'm.room.member');
      }
      for (const e of res.body.state as Json[]) {
        assertEquals(e.type, 'm.room.member');
      }
    },
  );

  await t.step(
    'state is the room state at the last event returned',
    async () => {
      const roomId = await mk();
      const putName = async (name: string, txn: string) => {
        const res = await call(
          `/_matrix/client/v3/rooms/${
            encodeURIComponent(roomId)
          }/state/m.room.name/`,
          { method: 'PUT', token: A, body: { name } },
        );
        assertEquals(res.status, 200, txn);
      };
      await putName('N1', 'ctx-n1');
      const msg1 = await sendText(A, roomId, 'm1', 'ctx-st-1');
      await sendText(A, roomId, 'm2', 'ctx-st-2');
      await putName('N2', 'ctx-n2');
      await sendText(A, roomId, 'm3', 'ctx-st-3');
      const atEvent = await call(contextUrl(roomId, msg1, '?limit=0'), {
        token: A,
      });
      assertEquals(atEvent.status, 200);
      const nameAtEvent = (atEvent.body.state as Json[]).find((e) =>
        e.type === 'm.room.name'
      );
      assertEquals((nameAtEvent?.content as Json).name, 'N1');
      const withAfter = await call(contextUrl(roomId, msg1, '?limit=4'), {
        token: A,
      });
      assertEquals(withAfter.status, 200);
      const nameAfter = (withAfter.body.state as Json[]).find((e) =>
        e.type === 'm.room.name'
      );
      assertEquals((nameAfter?.content as Json).name, 'N2');
    },
  );

  await t.step(
    'invisible anchor and unknown event → 404 M_NOT_FOUND',
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
      const eventId = await sendText(A, roomId, 'secret', 'ctx-vis-1');
      const denied = await call(contextUrl(roomId, eventId), { token: B });
      assertEquals(denied.status, 404);
      assertEquals(denied.body.errcode, 'M_NOT_FOUND');
      const missing = await call(contextUrl(roomId, '$no-such-event'), {
        token: A,
      });
      assertEquals(missing.status, 404);
      assertEquals(missing.body.errcode, 'M_NOT_FOUND');
    },
  );

  await t.step('left user is clamped to their read position', async () => {
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
    await call(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { method: 'POST', token: B, body: {} },
    );
    const beforeLeave = await sendText(A, roomId, 'before leave', 'ctx-lv-1');
    await call(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`,
      { method: 'POST', token: B, body: {} },
    );
    await sendText(A, roomId, 'after leave', 'ctx-lv-2');
    const res = await call(contextUrl(roomId, beforeLeave, '?limit=10'), {
      token: B,
    });
    assertEquals(res.status, 200);
    assertEquals((res.body.event as Json).event_id, beforeLeave);
    for (const e of res.body.events_after as Json[]) {
      assert(
        (e.content as Json).body !== 'after leave',
        'post-leave message leaked into events_after',
      );
    }
  });

  await t.step('v12 create event carries room_id', async () => {
    const roomId = await mk({ room_version: '12' });
    const createFull = (
      await call(
        `/_matrix/client/v3/rooms/${
          encodeURIComponent(roomId)
        }/state/m.room.create?format=event`,
        { token: A },
      )
    ).body;
    const createId = createFull.event_id as string;
    const res = await call(contextUrl(roomId, createId, '?limit=0'), {
      token: A,
    });
    assertEquals(res.status, 200);
    const event = res.body.event as Json;
    assertEquals(event.type, 'm.room.create');
    assertEquals(event.room_id, roomId);
    assertEquals(event.event_id, createId);
  });
});
