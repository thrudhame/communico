import { assert, assertEquals } from '@std/assert';
import { startHttp } from '#tests/http-app.ts';
import { createRoom } from '#engine/room/create.ts';
import { join } from '#engine/client/membership.ts';
import { openRoom } from '#engine/room/index.ts';
import { completionService } from '#engine/server/completion.ts';
import { holdPublication } from '#tests/support/hold-publication.ts';
import { setPresenceValue } from '#engine/server/ephemeral.ts';
import { parseStreamToken } from '#engine/client/tokens.ts';

function guard<T>(
  task: Promise<T>,
  label = 'applied read blocked',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(label)),
        10000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

Deno.test('applied reads: foreign publication does not block sync or scoped reads; own send remains causal', async () => {
  const http = await startHttp(), { app } = http;
  const jobs: Promise<unknown>[] = [];
  let hold: ReturnType<typeof holdPublication> | undefined;
  try {
    const alice = await http.registerTestUser('applied-alice', 'pw');
    const bob = await http.registerTestUser('applied-bob', 'pw');
    const created = await createRoom(app.store, {
      creator: alice.user_id,
      preset: 'public_chat',
    }, app.tenant.signer());
    await join(created.roomId, bob.user_id);
    const room = await openRoom(app.store, created.roomId);
    const roomPath = 'v3/rooms/' + encodeURIComponent(room.id);
    const request = (
      token: string,
      path: string,
      body?: unknown,
      method?: string,
    ) =>
      http.matrix(
        new Request('http://x/_matrix/client/' + path, {
          method: method ?? (body === undefined ? 'GET' : 'POST'),
          headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    const json = async (task: Promise<Response>) => {
      jobs.push(task);
      const response = await guard(task);
      assertEquals(response.status, 200, await response.clone().text());
      return await response.json();
    };
    const ordinary = await json(
      request(bob.access_token!, 'v3/sync?timeout=0'),
    );
    const slidingPath = 'unstable/org.matrix.simplified_msc3575/sync?timeout=0';
    const slidingBody = {
      conn_id: 'applied',
      lists: {
        all: { ranges: [[0, 9]], timeline_limit: 20, required_state: [] },
      },
    };
    const sliding = await json(
      request(bob.access_token!, slidingPath, slidingBody),
    );
    hold = holdPublication(app, room.id);
    const accepted = await json(request(
      alice.access_token!,
      roomPath + '/send/m.room.message/held',
      { msgtype: 'm.text', body: 'held publication message' },
      'PUT',
    ));
    await guard(hold.entered);
    const presence = setPresenceValue(app.server, bob.user_id, 'online');
    jobs.push(presence);
    await guard(presence, 'unchanged presence queued behind publication');
    const changedPresence = setPresenceValue(
      app.server,
      bob.user_id,
      'unavailable',
    );
    jobs.push(changedPresence);
    await guard(changedPresence, 'presence mutation queued behind publication');
    const presenceRead = await json(
      request(
        bob.access_token!,
        'v3/presence/' + encodeURIComponent(bob.user_id) + '/status',
      ),
    );
    assertEquals(presenceRead.presence, 'unavailable');
    assertEquals(
      await app.server.query('SELECT event FROM feed WHERE event=?', [
        accepted.event_id,
      ]),
      [],
    );
    // A real publication transaction and the global writer remain held.
    // Readers must select the prior applied cut, not enroll its successor.
    const read = await json(
      request(
        bob.access_token!,
        'v3/sync?timeout=0&since=' + ordinary.next_batch,
      ),
    );
    const slideRead = await json(
      request(
        bob.access_token!,
        slidingPath + '&pos=' + encodeURIComponent(sliding.pos),
        slidingBody,
      ),
    );
    assertEquals(
      parseStreamToken(read.next_batch)?.eSeq,
      parseStreamToken(ordinary.next_batch)?.eSeq,
    );
    assert(!JSON.stringify(slideRead).includes(accepted.event_id));
    for (
      const [path, body] of [
        [roomPath + '/messages?dir=b&limit=20', undefined],
        [
          roomPath + '/event/' + encodeURIComponent(accepted.event_id),
          undefined,
        ],
        [roomPath + '/initialSync', undefined],
        ['v3/notifications', undefined],
        ['v3/search', {
          search_categories: {
            room_events: { search_term: 'held publication message' },
          },
        }],
      ] as const
    ) {
      const result = await json(request(bob.access_token!, path, body));
      // Room-backed endpoints can already read this committed event. Server
      // projections still select the earlier applied cut while its writer holds.
      if (path.includes('/messages?')) {
        assertEquals(
          result.chunk.filter((event: { event_id: string }) =>
            event.event_id === accepted.event_id
          ).length,
          1,
        );
      } else if (path.includes('/event/')) {
        assertEquals(result.event_id, accepted.event_id);
      } else {
        assert(!JSON.stringify(result).includes(accepted.event_id), path);
      }
    }
    const owner = completionService(app.store), wait = owner.wait.bind(owner);
    const captured = Promise.withResolvers<void>();
    let returned = false;
    owner.wait = (...args) => {
      if (args[0].roomId === room.id && args[1] === 'publication') {
        captured.resolve();
      }
      return wait(...args);
    };
    const own = request(alice.access_token!, 'v3/sync?timeout=0').then(
      (response) => {
        returned = true;
        return response;
      },
    );
    jobs.push(own);
    await guard(captured.promise);
    assertEquals(returned, false);
    hold.release();
    const ownResult = await json(own);
    assert(JSON.stringify(ownResult).includes(accepted.event_id));
    const next = await json(
      request(bob.access_token!, 'v3/sync?timeout=0&since=' + read.next_batch),
    );
    const ids = next.rooms.join[room.id].timeline.events.map((
      event: { event_id: string },
    ) => event.event_id);
    assertEquals(
      ids.filter((id: string) => id === accepted.event_id).length,
      1,
    );
    const again = await json(
      request(bob.access_token!, 'v3/sync?timeout=0&since=' + next.next_batch),
    );
    assert(!JSON.stringify(again).includes(accepted.event_id));
    const slideNext = await json(
      request(
        bob.access_token!,
        slidingPath + '&pos=' + encodeURIComponent(slideRead.pos),
        slidingBody,
      ),
    );
    const slideIds = slideNext.rooms[room.id].timeline.map((
      event: { event_id: string },
    ) => event.event_id);
    assertEquals(
      slideIds.filter((id: string) => id === accepted.event_id).length,
      1,
    );
    const slideAgain = await json(
      request(
        bob.access_token!,
        slidingPath + '&pos=' + encodeURIComponent(slideNext.pos),
        slidingBody,
      ),
    );
    assert(!JSON.stringify(slideAgain).includes(accepted.event_id));
  } finally {
    hold?.release();
    hold?.restore();
    await Promise.allSettled(jobs);
    await http.close();
  }
});
