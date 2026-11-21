import { assert, assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { visiblePrejoin } from '#engine/server/prejoin.ts';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('HTTP sync relevance equivalence');
suite.test('indexed relevance preserves the complete incremental response', async () => {
  const app = theApp();
  const user = await suite.registerTestUser('relevance', 'pw');
  const signer = app.tenant.signer();
  const { roomId } = await createRoom(app.store, {
    creator: user.user_id,
    preset: 'public_chat',
  }, signer);
  const room = await openRoom(app.store, roomId);
  const sync = async (since?: string) => {
    const response = await suite.matrix(
      new Request(
        'http://x/_matrix/client/v3/sync?set_presence=offline&timeout=1' +
          (since ? '&since=' + encodeURIComponent(since) : ''),
        { headers: { Authorization: 'Bearer ' + user.access_token } },
      ),
    );
    assertEquals(response.status, 200);
    return await response.json();
  };
  const baseline = await sync();
  const sent = await sendLocal(room, {
    type: 'm.room.message',
    sender: user.user_id,
    content: { body: 'the same published event', msgtype: 'm.text' },
  }, signer);
  const query = app.server.query.bind(app.server);
  let legacy = false;
  let probes = 0;
  app.server.query = async (sql, values) => {
    if (sql.includes('AS changed') && sql.includes('FROM feed f')) {
      probes++;
      if (legacy) {
        const rows = await query(
          `SELECT MAX(seq) AS m FROM (
           SELECT f.seq FROM feed f JOIN memberships m ON m.room=f.room WHERE m.user=?
           UNION ALL SELECT seq FROM prejoin_memberships p WHERE user_id=?
           AND status NOT IN ('attempting','failed-attempt') AND ${
            visiblePrejoin('p')
          })`,
          [values![0], values![0]],
        );
        return [{
          changed: Number(rows[0].m ?? 0) > Number(values![1]) ? 1 : 0,
        }];
      }
    }
    return await query(sql, values);
  };
  // Age is elapsed wall time at rendering, not a stream or disclosure change.
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).filter(([key]) =>
          key !== 'age' && key !== 'last_active_ago'
        ).map(([key, child]) => [key, stable(child)]),
      );
    }
    return value;
  };
  try {
    const indexed = await sync(baseline.next_batch);
    legacy = true;
    const previous = await sync(baseline.next_batch);
    assertEquals(stable(indexed), stable(previous));
    assert(indexed.rooms.join[roomId].timeline.events.some(
      (event: { event_id: string }) => event.event_id === sent.eventId,
    ));
    legacy = false;
    const empty = await sync(indexed.next_batch);
    legacy = true;
    assertEquals(stable(empty), stable(await sync(indexed.next_batch)));
    assert(probes >= 2, 'ordinary sync must invoke the actual relevance owner');
  } finally {
    app.server.query = query;
  }
});
