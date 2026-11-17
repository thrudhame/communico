import { assert, assertEquals, assertRejects } from '@std/assert';
import { startHttp } from '#tests/http-app.ts';
import { createRoom } from '#engine/room/create.ts';
import { join } from '#engine/client/membership.ts';
import { completionService } from '#engine/server/completion.ts';

function guard<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('room read causal observation missing')),
        10000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

Deno.test('room read completion: foreign accepted send precedes every scoped consumer, not unrelated rooms', async () => {
  const http = await startHttp(), { app } = http;
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const originalRoom = app.store.room.bind(app.store);
  const owner = completionService(app.store),
    originalWait = owner.wait.bind(owner);
  const jobs: Promise<Response>[] = [];
  try {
    const alice = await http.registerTestUser('room-cut-alice', 'pw');
    const bob = await http.registerTestUser('room-cut-bob', 'pw');
    const created = await createRoom(app.store, {
      creator: alice.user_id,
      preset: 'public_chat',
      initial_state: [{
        type: 'm.room.history_visibility',
        state_key: '',
        content: { history_visibility: 'world_readable' },
      }],
    }, app.tenant.signer());
    await join(created.roomId, bob.user_id);
    const independent = await createRoom(app.store, {
      creator: bob.user_id,
      preset: 'public_chat',
    }, app.tenant.signer());
    let held = false;
    app.store.room = async (...args) => {
      const db = await originalRoom(...args);
      if (args[0] !== created.roomId) return db;
      return {
        ...db,
        tx: async (fn, options) => {
          let selected = false;
          const result = await db.tx(async (conn) => {
            const query = conn.query.bind(conn);
            conn.query = async (sql, values) => {
              const rows = await query(sql, values);
              if (
                !held &&
                sql.startsWith(
                  'SELECT pos, kind, event, data FROM changes WHERE pos >',
                ) && rows.some((r) => r.kind === 'event')
              ) {
                held = true;
                selected = true;
              }
              return rows;
            };
            return await fn(conn);
          }, options);
          // Hold immutable room capture AFTER its transaction, before the shared
          // writer. Independent rooms and readers have no artificial DB blockage.
          if (selected) {
            entered.resolve();
            await release.promise;
          }
          return result;
        },
      };
    };
    const request = (
      token: string,
      path: string,
      body?: unknown,
      method?: string,
      signal?: AbortSignal,
    ) =>
      http.matrix(
        new Request('http://x/_matrix/client/' + path, {
          method: method ?? (body === undefined ? 'GET' : 'POST'),
          signal,
          headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    const path = encodeURIComponent(created.roomId);
    const accepted = await request(
      alice.access_token!,
      'v3/rooms/' + path + '/send/m.room.message/scoped',
      { msgtype: 'm.text', body: 'scoped accepted message' },
      'PUT',
    );
    assertEquals(accepted.status, 200, await accepted.clone().text());
    const eventId = (await accepted.json()).event_id;
    await guard(entered.promise);
    assertEquals(
      (await app.server.query('SELECT event FROM feed WHERE event=?', [
        eventId,
      ])).length,
      0,
    );
    const captured = Promise.withResolvers<void>();
    let waits = 0;
    owner.wait = (...args) => {
      if (
        args[0].roomId === created.roomId && args[1] === 'publication' &&
        ++waits === 9
      ) captured.resolve();
      return originalWait(...args);
    };
    const event = encodeURIComponent(eventId);
    for (
      const [route, body] of [
        ['v3/rooms/' + path + '/event/' + event, undefined],
        ['v3/rooms/' + path + '/messages?dir=b&limit=20', undefined],
        ['v1/rooms/' + path + '/relations/' + event, undefined],
        ['v3/search', {
          search_categories: {
            room_events: { search_term: 'scoped accepted message' },
          },
        }],
        ['v3/notifications', undefined],
        ['v3/sync?timeout=0', undefined],
        ['unstable/org.matrix.simplified_msc3575/sync?timeout=0', {
          conn_id: 'foreign-cut',
          lists: {
            all: { ranges: [[0, 9]], timeline_limit: 20, required_state: [] },
          },
        }],
        ['v3/rooms/' + path + '/initialSync', undefined],
        ['v3/rooms/' + path + '/receipt/m.read/' + event, {}],
      ] as const
    ) jobs.push(request(bob.access_token!, route, body));
    await guard(Promise.race([
      captured.promise,
      ...jobs.map((job) =>
        job.then(() => {
          throw new Error(
            'foreign room read returned before accepted publication',
          );
        })
      ),
    ]));
    // Each moved engine admission retains request cancellation while the actual
    // durable completion owner remains held and independently owned.
    for (
      const [route, body] of [
        ['v3/search', {
          search_categories: {
            room_events: { search_term: 'scoped accepted message' },
          },
        }],
        ['v3/notifications', undefined],
        ['v3/rooms/' + path + '/initialSync', undefined],
        ['v3/rooms/' + path + '/receipt/m.read/' + event, {}],
        ['v3/rooms/' + path + '/read_markers', { 'm.fully_read': eventId }],
      ] as const
    ) {
      const enteredWait = Promise.withResolvers<void>();
      let observed: AbortSignal | undefined;
      owner.wait = (...args) => {
        if (args[0].roomId === created.roomId && args[1] === 'publication') {
          observed = args[2];
          enteredWait.resolve();
        }
        return originalWait(...args);
      };
      const abort = new AbortController();
      const job = request(
        bob.access_token!,
        route,
        body,
        undefined,
        abort.signal,
      );
      jobs.push(job);
      await guard(enteredWait.promise);
      assert(
        observed instanceof AbortSignal,
        'room read cancellation signal missing: ' + route,
      );
      abort.abort();
      const failure = await assertRejects(() => guard(job));
      assert(failure instanceof DOMException);
      assertEquals(failure.name, 'AbortError');
      assertEquals(
        (await app.server.query('SELECT event FROM feed WHERE event=?', [
          eventId,
        ])).length,
        0,
      );
    }
    // Aborted request waits did not cancel the shared worker or earlier readers.
    jobs.splice(9);
    // A real response before release proves the shared helper did not introduce
    // a global drain behind another room's accepted completion.
    const unrelated = await guard(
      request(
        bob.access_token!,
        'v3/rooms/' + encodeURIComponent(independent.roomId) +
          '/messages?dir=b&limit=20',
      ),
    );
    assertEquals(unrelated.status, 200);
    await unrelated.json();
    release.resolve();
    const bodies = await Promise.all(jobs.map(async (job) => {
      const response = await guard(job);
      assertEquals(response.status, 200);
      return await response.json();
    }));
    assertEquals(bodies[0].event_id, eventId);
    assert(
      bodies[1].chunk.some((event: { event_id: string }) =>
        event.event_id === eventId
      ),
    );
    assert(
      bodies[3].search_categories.room_events.results.some((
        hit: { result: { event_id: string } },
      ) => hit.result.event_id === eventId),
    );
    assert(
      bodies[4].notifications.some((notice: { event: { event_id: string } }) =>
        notice.event.event_id === eventId
      ),
    );
    assert(
      bodies[5].rooms.join[created.roomId].timeline.events.some((
        event: { event_id: string },
      ) => event.event_id === eventId),
    );
    assert(
      bodies[6].rooms[created.roomId].timeline.some((
        event: { event_id: string },
      ) => event.event_id === eventId),
    );
    assert(
      bodies[7].messages.chunk.some((event: { event_id: string }) =>
        event.event_id === eventId
      ),
    );
  } finally {
    release.resolve();
    app.store.room = originalRoom;
    owner.wait = originalWait;
    await Promise.allSettled(jobs);
    await http.close();
  }
});
