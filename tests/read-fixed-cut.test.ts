import { assert, assertEquals } from '@std/assert';
import { startHttp } from '#tests/http-app.ts';
import { createRoom } from '#engine/room/create.ts';
import { join } from '#engine/client/membership.ts';
import { completionService } from '#engine/server/completion.ts';
import { deliveredBySync } from '#tests/support/sync-delivery.ts';

function guard<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('fixed read cut did not settle')),
        15000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

for (const reader of ['sender', 'foreign'] as const) {
  Deno.test(`fixed read cut: ${reader} sync does not inherit eight later same-room sends`, async () => {
    const http = await startHttp(), { app } = http;
    const firstEntered = Promise.withResolvers<void>();
    const firstRelease = Promise.withResolvers<void>();
    const laterEntered = Promise.withResolvers<void>();
    const laterRelease = Promise.withResolvers<void>();
    const captured = Promise.withResolvers<number>();
    const originalRoom = app.store.room.bind(app.store);
    const owner = completionService(app.store),
      originalWait = owner.wait.bind(owner);
    let sync: Promise<Response> | undefined;
    try {
      const alice = await http.registerTestUser('fixed-alice', 'pw');
      const bob = await http.registerTestUser('fixed-bob', 'pw');
      const created = await createRoom(app.store, {
        creator: alice.user_id,
        preset: 'public_chat',
      }, app.tenant.signer());
      await join(created.roomId, bob.user_id);
      let heldFirst = false, heldLater = false;
      const laterIds: string[] = [];
      app.store.room = async (...args) => {
        const db = await originalRoom(...args);
        if (args[0] !== created.roomId) return db;
        return {
          ...db,
          tx: async (fn, options) => {
            let selected = '';
            const result = await db.tx(async (conn) => {
              const query = conn.query.bind(conn);
              conn.query = async (sql, values) => {
                const rows = await query(sql, values);
                if (
                  sql.startsWith(
                    'SELECT pos, kind, event, data FROM changes WHERE pos >',
                  )
                ) {
                  if (!heldFirst && rows.some((r) => r.kind === 'event')) {
                    heldFirst = true;
                    selected = 'first';
                  } else if (
                    !heldLater &&
                    rows.some((r) => laterIds.includes(String(r.event)))
                  ) {
                    heldLater = true;
                    selected = 'later';
                  }
                }
                return rows;
              };
              return await fn(conn);
            }, options);
            // Only immutable capture is held; no transaction, writer or request lock.
            if (selected === 'first') {
              firstEntered.resolve();
              await firstRelease.promise;
            }
            if (selected === 'later') {
              laterEntered.resolve();
              await laterRelease.promise;
            }
            return result;
          },
        };
      };
      const send = async (txn: string) => {
        const response = await http.matrix(
          new Request(
            'http://x/_matrix/client/v3/rooms/' +
              encodeURIComponent(created.roomId) + '/send/m.room.message/' +
              txn,
            {
              method: 'PUT',
              headers: { Authorization: 'Bearer ' + alice.access_token },
              body: JSON.stringify({ msgtype: 'm.text', body: txn }),
            },
          ),
        );
        assertEquals(response.status, 200);
        return String((await response.json()).event_id);
      };
      const firstId = await send('before-read');
      await guard(firstEntered.promise);
      if (reader === 'foreign') {
        // No pending send belongs to this device. Its fixed view is the applied
        // cut before the held first send, not that sender's accepted target.
        sync = http.matrix(
          new Request('http://x/_matrix/client/v3/sync?timeout=0', {
            headers: { Authorization: 'Bearer ' + bob.access_token },
          }),
        );
        for (let n = 0; n < 8; n++) {
          laterIds.push(await send('after-read-' + n));
        }
        const response = await guard(sync);
        assertEquals(response.status, 200);
        const body = await response.json();
        assert(!JSON.stringify(body).includes(firstId));
        for (const id of laterIds) assert(!JSON.stringify(body).includes(id));
        assertEquals(
          await app.server.query('SELECT event FROM feed WHERE event=?', [
            firstId,
          ]),
          [],
          'foreign sync returned while the first accepted send remained held',
        );
        await deliveredBySync(http.matrix, bob.access_token!, () => {
          firstRelease.resolve();
          return Promise.resolve({ [created.roomId]: [firstId, ...laterIds] });
        }, {
          since: String(body.next_batch),
          observed: (events) => {
            if (events[created.roomId].includes(firstId)) {
              laterRelease.resolve();
            }
          },
        });
        await guard(laterEntered.promise);
        return;
      }
      owner.wait = (...args) => {
        if (args[0].roomId === created.roomId && args[1] === 'publication') {
          captured.resolve(args[0].through);
        }
        return originalWait(...args);
      };
      let settled = false;
      sync = http.matrix(
        new Request('http://x/_matrix/client/v3/sync?timeout=0', {
          headers: {
            Authorization: 'Bearer ' +
              (reader === 'sender' ? alice : bob).access_token,
          },
        }),
      ).then((response) => {
        settled = true;
        return response;
      });
      const cut = await guard(captured.promise);
      for (let n = 0; n < 8; n++) laterIds.push(await send('after-read-' + n));
      assertEquals(
        settled,
        false,
        'read must wait for its own accepted publication',
      );
      firstRelease.resolve();
      await guard(laterEntered.promise);
      const response = await guard(sync);
      assertEquals(response.status, 200);
      const body = await response.json();
      assert(
        body.rooms.join[created.roomId].timeline.events.some((
          event: { event_id: string },
        ) => event.event_id === firstId),
      );
      const rows = await app.server.query(
        'SELECT event FROM feed WHERE room=? AND pos>?',
        [created.roomId, cut],
      );
      assertEquals(
        rows,
        [],
        'later sends remain unprojected while the earlier sync completes',
      );
      console.log(
        JSON.stringify({
          reader,
          cut,
          later_sends: laterIds.length,
          sync_status: response.status,
          later_projected: rows.length,
        }),
      );
    } finally {
      firstRelease.resolve();
      laterRelease.resolve();
      owner.wait = originalWait;
      app.store.room = originalRoom;
      if (sync) await Promise.allSettled([sync]);
      await http.close();
    }
  });
}
