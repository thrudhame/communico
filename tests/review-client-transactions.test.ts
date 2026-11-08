import { assert, assertEquals } from '@std/assert';
import { dirname } from '@std/path';
import { closeApp, openApp, theApp } from '#engine/app.ts';
import { requireRoom } from '#engine/client/room.ts';
import { renderEvent } from '#engine/client/render.ts';
import type { Pdu } from '#engine/pdu.ts';
import { startHttp } from '#tests/http-app.ts';

type Http = Awaited<ReturnType<typeof startHttp>>;
type Json = Record<string, unknown>;
async function call(
  http: Http,
  path: string,
  token: string,
  body: Json,
  method = 'PUT',
) {
  const response = await http.matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}

async function fixture(http: Http) {
  const user = await http.registerTestUser('txn-owner', 'pw');
  const token = user.access_token!;
  const created = await call(http, 'createRoom', token, {}, 'POST');
  assertEquals(created.status, 200);
  const roomId = created.body.room_id as string;
  const root = 'rooms/' + encodeURIComponent(roomId);
  const target = await call(http, root + '/send/m.room.message/target', token, {
    body: 'target',
  });
  assertEquals(target.status, 200);
  return { user, token, roomId, root, target: target.body.event_id as string };
}

for (const kind of ['send', 'redact'] as const) {
  Deno.test(
    'review transactions: concurrent ' + kind + ' has one event and effect',
    async () => {
      const http = await startHttp();
      try {
        const f = await fixture(http);
        const path = f.root +
          (kind === 'send'
            ? '/send/m.room.message/same'
            : '/redact/' + encodeURIComponent(f.target) + '/same');
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, n) =>
            call(http, path, f.token, {
              body: 'attempt-' + n,
              reason: 'attempt-' + n,
            })),
        );
        assertEquals(results.map((r) => r.status), Array(8).fill(200));
        assertEquals(new Set(results.map((r) => r.body.event_id)).size, 1);
        const eventId = results[0].body.event_id as string;
        const db = await theApp().store.room(f.roomId);
        const rows = await db.query('SELECT id FROM events WHERE type = ?', [
          kind === 'send' ? 'm.room.message' : 'm.room.redaction',
        ]);
        assertEquals(rows.length, kind === 'send' ? 2 : 1);
        assertEquals(
          (await theApp().server.query(
            'SELECT event FROM feed WHERE room = ? AND event = ?',
            [f.roomId, eventId],
          )).length,
          1,
        );
        if (kind === 'redact') {
          assertEquals(
            (await db.query("SELECT pos FROM changes WHERE kind = 'redaction'"))
              .length,
            1,
          );
        }
        // Completed receipts precede current permission checks, including on archive.
        assertEquals(
          (await call(http, f.root + '/leave', f.token, {}, 'POST')).status,
          200,
        );
        const replay = await call(http, path, f.token, {
          body: 'different',
          reason: 'different',
        });
        assertEquals([replay.status, replay.body.event_id], [200, eventId]);
      } finally {
        await http.close();
      }
    },
  );

  for (const cut of ['before', 'after'] as const) {
    Deno.test(
      'review transactions: ' + kind + ' reconciles ' + cut +
        ' room commit after reopen',
      async () => {
        const http = await startHttp();
        try {
          const f = await fixture(http);
          const app = theApp();
          const originalRoom = app.store.room.bind(app.store);
          let prepared: Pdu | null = null;
          let injected = false;
          app.store.room = async (id, options) => {
            const db = await originalRoom(id, options);
            if (id !== f.roomId) return db;
            return {
              ...db,
              tx: async (fn, options) => {
                let wrote = false;
                const result = await db.tx(async (conn) => {
                  const execute = conn.execute.bind(conn);
                  conn.execute = async (sql, values = []) => {
                    if (!injected && sql.startsWith('INSERT INTO events(')) {
                      wrote = true;
                      prepared = JSON.parse(String(values[1])) as Pdu;
                    }
                    return await execute(sql, values);
                  };
                  const result = await fn(conn);
                  if (wrote && cut === 'before') {
                    injected = true;
                    throw new Error('injected before room commit');
                  }
                  return result;
                }, options);
                if (wrote && cut === 'after') {
                  injected = true;
                  throw new Error('injected after room commit');
                }
                return result;
              },
            };
          };
          const path = f.root +
            (kind === 'send'
              ? '/send/m.room.message/crash'
              : '/redact/' + encodeURIComponent(f.target) + '/crash');
          const failed = await call(http, path, f.token, {
            body: 'original',
            reason: 'original',
          });
          app.store.room = originalRoom;
          assertEquals(failed.status, 500);
          assert(injected && prepared !== null);
          const expected = prepared as Pdu;
          const before = await originalRoom(f.roomId);
          assertEquals(
            (await before.query('SELECT id FROM events WHERE id = ?', [
              expected.event_id!,
            ])).length,
            cut === 'before' ? 0 : 1,
          );
          const config = {
            dir: dirname(dirname(app.server.path)),
            library: './.native/libturso_ffi.so',
            checkpointlogbytes: 65536,
            maxopenfiles: 8,
            idleseconds: 300,
          };
          await closeApp();
          await openApp(config);
          const replay = await call(http, path, f.token, {
            body: 'changed retry',
            reason: 'changed retry',
          });
          assertEquals([replay.status, replay.body.event_id], [
            200,
            expected.event_id,
          ]);
          const room = await requireRoom(f.roomId);
          const stored = await room.tx((tx) =>
            tx.events.get(expected.event_id!)
          );
          assertEquals(JSON.parse(stored!.pdu), expected);
          const rendered = await renderEvent(room, expected.event_id!, {
            userId: f.user.user_id,
            deviceId: f.user.device_id,
            tenant: theApp().tenant,
          });
          assertEquals((rendered!.unsigned as Json).transaction_id, 'crash');
          const db = await theApp().store.room(f.roomId);
          assertEquals(
            (await db.query('SELECT id FROM events WHERE type = ?', [
              kind === 'send' ? 'm.room.message' : 'm.room.redaction',
            ])).length,
            kind === 'send' ? 2 : 1,
          );
          if (kind === 'redact') {
            assertEquals(
              (await db.query(
                "SELECT pos FROM changes WHERE kind = 'redaction'",
              )).length,
              1,
            );
          }
          const last = await call(http, path, f.token, {});
          assertEquals(last.body.event_id, expected.event_id);
        } finally {
          await http.close();
        }
      },
    );
  }
}
