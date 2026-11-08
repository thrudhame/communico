import { assert, assertEquals } from '@std/assert';
import { startHttp } from '#tests/http-app.ts';

Deno.test('push sync snapshot: later event and private receipt cannot leak into an earlier event/count cut', async () => {
  const http = await startHttp();
  try {
    const a = await http.registerTestUser('push-cut-a', 'pw');
    const b = await http.registerTestUser('push-cut-b', 'pw');
    const call = async (
      path: string,
      token: string,
      body?: unknown,
      method?: string,
    ) => {
      const response = await http.matrix(
        new Request('http://x/_matrix/client/v3/' + path, {
          method: method ?? (body === undefined ? 'GET' : 'POST'),
          headers: { Authorization: 'Bearer ' + token },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      assertEquals(response.status, 200, await response.clone().text());
      return await response.json();
    };
    const room =
      (await call('createRoom', a.access_token!, { invite: [b.user_id] }))
        .room_id;
    const base = 'rooms/' + encodeURIComponent(room);
    await call(base + '/join', b.access_token!, {});
    const send = (txn: string) =>
      call(base + '/send/m.room.message/' + txn, a.access_token!, {
        msgtype: 'm.text',
        body: txn,
      }, 'PUT');
    const first = await send('one');
    const server = http.app.server;
    const original = server.tx.bind(server);
    let captured = false;
    let second: { event_id: string } | undefined;
    // Interleave real writes immediately after sync's server transaction commits,
    // before it renders room events. No result is mocked or altered.
    server.tx = async (fn, options) => {
      const result = await original(fn, options);
      if (!captured) {
        captured = true;
        server.tx = original;
        second = await send('two');
        await call(
          base + '/receipt/m.read.private/' +
            encodeURIComponent(first.event_id),
          b.access_token!,
          {},
        );
      }
      return result;
    };
    const before = await call('sync', b.access_token!);
    assert(captured);
    assert(second);
    const initial = before.rooms.join[room];
    assertEquals(initial.unread_notifications, {
      notification_count: 1,
      highlight_count: 0,
    });
    assert(
      initial.timeline.events.some((e: { event_id: string }) =>
        e.event_id === first.event_id
      ),
    );
    assert(
      !initial.timeline.events.some((e: { event_id: string }) =>
        e.event_id === second!.event_id
      ),
    );
    assert(
      !initial.ephemeral.events.some((e: { type: string }) =>
        e.type === 'm.receipt'
      ),
    );
    const after = await call(
      'sync?since=' + before.next_batch,
      b.access_token!,
    );
    const delta = after.rooms.join[room];
    assertEquals(delta.unread_notifications, {
      notification_count: 1,
      highlight_count: 0,
    });
    assert(
      delta.timeline.events.some((e: { event_id: string }) =>
        e.event_id === second!.event_id
      ),
    );
    assert(
      delta.ephemeral.events.some((
        e: { type: string; content: Record<string, unknown> },
      ) => e.type === 'm.receipt' && Object.hasOwn(e.content, first.event_id)),
    );
  } finally {
    await http.close();
  }
});
