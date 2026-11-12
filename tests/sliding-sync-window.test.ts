import { assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { syncWindow } from '#engine/client/sync-window.ts';
import { localpartOf } from '#engine/ids.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { eventStreamMax } from '#engine/server/stream.ts';
import { putAccountData } from '#engine/tenant/accountdata.ts';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('sliding shared window');
suite.test('visibility and ignores precede the limit; captured cuts, row positions and real trimming survive', async () => {
  const app = theApp();
  const alice = await suite.registerTestUser('window-a', 'pw');
  const bob = await suite.registerTestUser('window-b', 'pw');
  const signer = app.tenant.signer();
  const { roomId } = await createRoom(app.store, {
    creator: alice.user_id,
    preset: 'public_chat',
  }, signer);
  const room = await openRoom(app.store, roomId);
  await sendLocal(room, {
    type: 'm.room.member',
    sender: bob.user_id,
    state_key: bob.user_id,
    content: { membership: 'join' },
  }, signer);
  const send = async (sender: string, body: string) =>
    (await sendLocal(room, {
      type: 'm.room.message',
      sender,
      content: { body },
    }, signer)).eventId;
  const first = await send(alice.user_id, 'first');
  const since = await eventStreamMax(app.server);
  const second = await send(alice.user_id, 'second');
  await send(bob.user_id, 'ignored');
  const cut = await eventStreamMax(app.server);
  await send(alice.user_id, 'after captured cut');
  await putAccountData(
    app.tenant,
    localpartOf(alice.user_id),
    '',
    'm.ignored_user_list',
    { ignored_users: { [bob.user_id]: {} } },
  );
  const viewer = { userId: alice.user_id, deviceId: null, tenant: app.tenant };
  const window = await syncWindow(room, viewer, {
    since: 0,
    end: cut,
    limit: 1,
    filter: { types: ['m.room.message'] },
  });
  assertEquals(window.events.map((e) => e.event_id), [second]);
  assertEquals(window.rows.map((r) => r.event), [second]);
  assertEquals(window.trimmed, true);
  const delta = await syncWindow(room, viewer, {
    since,
    end: cut,
    limit: 1,
    filter: { types: ['m.room.message'] },
  });
  assertEquals(delta.events.map((e) => e.event_id), [second]);
  assertEquals(delta.trimmed, false);
  assertEquals(delta.gap, false);
  const all = await syncWindow(room, viewer, {
    since: 0,
    end: cut,
    limit: 2,
    filter: { types: ['m.room.message'] },
  });
  assertEquals(all.events.map((e) => e.event_id), [first, second]);
  assertEquals(all.trimmed, false);
  const empty = await syncWindow(room, viewer, {
    since: 0,
    end: cut,
    limit: 0,
    filter: { types: ['m.room.message'] },
  });
  assertEquals(empty.events, []);
  assertEquals(empty.trimmed, true);
});
