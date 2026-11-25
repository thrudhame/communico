import { assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { renderStateEvents } from '#engine/client/render.ts';
import { admitState } from '#engine/client/state-admission.ts';
import { syncWindow } from '#engine/client/sync-window.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { eventStreamMax } from '#engine/server/stream.ts';
import { Turso } from '#engine/store/ffi.ts';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('sync room read work');

suite.test('one room uses bounded read statements for more timeline events and state keys', async () => {
  const user = await suite.registerTestUser('room-read-work', 'pw');
  const app = theApp();
  const signer = app.tenant.signer();
  const viewer = {
    userId: user.user_id,
    deviceId: user.device_id,
    tenant: app.tenant,
  };
  const open = Turso.prototype.open;
  const connect = Turso.prototype.connect;
  const query = Turso.prototype.query;
  const files = new Map<number, string>();
  const connections = new Map<number, string>();
  let observed: string[] | null = null;
  Turso.prototype.open = async function (path) {
    const file = await open.call(this, path);
    files.set(file, path);
    return file;
  };
  Turso.prototype.connect = async function (file) {
    const connection = await connect.call(this, file);
    const path = files.get(file);
    if (path !== undefined) connections.set(connection, path);
    else connections.delete(connection);
    return connection;
  };
  Turso.prototype.query = function (connection, sql, values) {
    if (connections.get(connection)?.includes('/rooms/')) observed?.push(sql);
    return query.call(this, connection, sql, values);
  };
  async function count<T>(run: () => Promise<T>) {
    const sql: string[] = [];
    observed = sql;
    try {
      return { value: await run(), sql };
    } finally {
      observed = null;
    }
  }
  try {
    const counts = [];
    for (const size of [2, 8]) {
      const { roomId } = await createRoom(app.store, {
        creator: user.user_id,
        preset: 'public_chat',
      }, signer);
      const room = await openRoom(app.store, roomId);
      const send = async (
        type: string,
        content: Record<string, unknown>,
        stateKey?: string,
      ) => {
        const result = await sendLocal(room, {
          type,
          sender: user.user_id,
          content,
          ...(stateKey === undefined ? {} : { state_key: stateKey }),
        }, signer);
        assertEquals(result.standing, 'accepted', result.reason ?? undefined);
        return result.eventId;
      };
      for (let n = 0; n < size; n++) {
        await send('org.example.state', { old: n }, String(n));
      }
      const since = await eventStreamMax(app.server);
      const messages: string[] = [];
      const state: string[] = [];
      for (let n = 0; n < size; n++) {
        state.push(await send('org.example.state', { next: n }, String(n)));
        messages.push(
          await send('m.room.message', {
            msgtype: 'm.text',
            body: String(n),
          }),
        );
      }
      const end = await eventStreamMax(app.server);
      const timeline = await count(() =>
        syncWindow(room, viewer, { since, end, limit: 20 })
      );
      assertEquals(
        timeline.value.events.map((e) => e.event_id),
        messages.flatMap((id, n) => [state[n], id]),
      );
      assertEquals(timeline.value.gap, false);
      assertEquals(timeline.value.trimmed, false);
      const admission = await admitState(room, {
        userId: user.user_id,
        ceiling: end,
      });
      const required = await count(() =>
        renderStateEvents(room, state, viewer, { admission, omitRoomId: true })
      );
      assertEquals([...required.value.keys()], state);
      for (const [n, event] of [...required.value.values()].entries()) {
        assertEquals(event.content, { next: n });
        assertEquals((event.unsigned as Record<string, unknown>).prev_content, {
          old: n,
        });
      }
      counts.push({
        timeline: timeline.sql.length,
        required: required.sql.length,
        timelineBefore: timeline.sql.filter((sql) =>
          /FROM event_state/.test(sql)
        ).length,
        timelineMembership: timeline.sql.filter((sql) =>
          /FROM state_entries/.test(sql)
        ).length,
        requiredPrevious: required.sql.filter((sql) =>
          /FROM state_entries/.test(sql)
        ).length,
      });
    }
    console.log('sync room statement counts', JSON.stringify(counts));
    assertEquals(
      counts[1],
      counts[0],
      'room reads must not scale with the returned event and state count',
    );
  } finally {
    Turso.prototype.open = open;
    Turso.prototype.connect = connect;
    Turso.prototype.query = query;
  }
});
