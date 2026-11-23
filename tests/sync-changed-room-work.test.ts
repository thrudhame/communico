import { assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('ordinary incremental sync room work');
type Reply = {
  room_id: string;
  event_id: string;
  next_batch: string;
  rooms: {
    join: Record<string, { timeline: { events: { event_id: string }[] } }>;
  };
};

for (const size of [2, 8]) {
  suite.test(`opens only changed rooms (${size} quiet rooms)`, async () => {
    const user = await suite.registerTestUser(`sync-work-${size}`, 'pw');
    async function call(path: string, body?: object, method?: string) {
      const response = await suite.matrix(
        new Request('http://x/_matrix/client/v3' + path, {
          method: method ?? (body === undefined ? 'GET' : 'POST'),
          headers: { Authorization: `Bearer ${user.access_token}` },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      const value = await response.json();
      assertEquals(response.status, 200, JSON.stringify(value));
      return value as Reply;
    }
    for (let n = 0; n < size; n++) {
      await call('/createRoom', { name: `Quiet ${n}` });
    }
    const changed = (await call('/createRoom', { name: 'Changed' })).room_id;
    const sync = (since?: string) => {
      const query = new URLSearchParams({ timeout: '0' });
      if (since !== undefined) query.set('since', since);
      return call(`/sync?${query}`);
    };
    const initial = await sync();
    const event = await call(
      `/rooms/${encodeURIComponent(changed)}/send/m.room.message/probe`,
      { msgtype: 'm.text', body: 'incremental payload' },
      'PUT',
    );
    // Finish own-send publication outside the measured syncs, without
    // consuming the original event cursor.
    await sync();
    const store = theApp().store;
    const original = store.room;
    const opens: string[] = [];
    store.room = (...args) => {
      opens.push(args[0]);
      return original.apply(store, args);
    };
    try {
      const update = await sync(initial.next_batch);
      const updateOpens = opens.splice(0);
      const replay = await sync(update.next_batch);
      assertEquals(Object.keys(update.rooms.join), [changed]);
      assertEquals(
        update.rooms.join[changed].timeline.events.map((e) => e.event_id),
        [event.event_id],
      );
      assertEquals(replay.rooms.join, {});
      assertEquals(updateOpens, [changed]);
      assertEquals(opens, []);
    } finally {
      store.room = original;
    }
  });
}
