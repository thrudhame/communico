import { assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { eventStreamMax } from '#engine/server/stream.ts';
import { syncWindow } from '#engine/client/sync-window.ts';
import { renderEvents, renderStateEvents } from '#engine/client/render.ts';
import { admitState } from '#engine/client/state-admission.ts';
import { putAccountData } from '#engine/tenant/accountdata.ts';
import { localpartOf } from '#engine/ids.ts';
import type { Room } from '#engine/room/index.ts';
import { Turso } from '#engine/store/ffi.ts';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('render batch work ownership');
suite.test('one timeline page captures ignore policy once, not per event or relation kind', async () => {
  const app = theApp();
  const user = await suite.registerTestUser('render-batch', 'pw');
  const signer = app.tenant.signer();
  const { roomId } = await createRoom(app.store, {
    creator: user.user_id,
    preset: 'public_chat',
  }, signer);
  const room = await openRoom(app.store, roomId);
  const since = await eventStreamMax(app.server);
  const ids: string[] = [];
  for (let n = 0; n < 12; n++) {
    ids.push(
      (await sendLocal(room, {
        type: 'm.room.message',
        sender: user.user_id,
        content: { body: String(n) },
      }, signer)).eventId,
    );
  }
  const end = await eventStreamMax(app.server);
  const original = Turso.prototype.query;
  let ignoreReads = 0;
  Turso.prototype.query = function (...args) {
    if (
      args[1].includes('FROM account_data') &&
      args[2]?.includes('m.ignored_user_list')
    ) ignoreReads++;
    return original.apply(this, args);
  };
  try {
    const page = await syncWindow(room, {
      userId: user.user_id,
      deviceId: null,
      tenant: app.tenant,
    }, { since, end, limit: 12 });
    assertEquals(page.events.map((event) => event.event_id), ids);
    console.log(
      'page events / ignored-policy captures',
      ids.length,
      ignoreReads,
    );
    assertEquals(
      ignoreReads,
      1,
      'the shared page owner captures one viewer policy',
    );
  } finally {
    Turso.prototype.query = original;
  }
});

suite.test('timeline and state batches share an attempt without enclosing cross-file reads', async () => {
  const app = theApp();
  const user = await suite.registerTestUser('render-snapshot', 'pw');
  const { roomId } = await createRoom(app.store, {
    creator: user.user_id,
    preset: 'public_chat',
  }, app.tenant.signer());
  const room = await openRoom(app.store, roomId);
  const ids: string[] = [];
  for (let n = 0; n < 6; n++) {
    ids.push(
      (await sendLocal(room, {
        type: 'm.room.message',
        sender: user.user_id,
        content: { body: String(n) },
      }, app.tenant.signer())).eventId,
    );
  }
  let roomAttempts = 0;
  let insideRoom = false;
  const observed: Room = {
    ...room,
    tx: (fn) => {
      roomAttempts++;
      return room.tx(async (tx) => {
        insideRoom = true;
        try {
          return await fn(tx);
        } finally {
          insideRoom = false;
        }
      });
    },
  };
  const tenantTx = app.tenant.tx.bind(app.tenant);
  const serverTx = app.server.tx.bind(app.server);
  app.tenant.tx = (fn) => {
    assertEquals(
      insideRoom,
      false,
      'tenant capture must not run in a retryable room callback',
    );
    return tenantTx(fn);
  };
  app.server.tx = (fn, opts) => {
    assertEquals(
      insideRoom,
      false,
      'projection capture must not run in a retryable room callback',
    );
    return serverTx(fn, opts);
  };
  const viewer = { userId: user.user_id, deviceId: null, tenant: app.tenant };
  try {
    const first = await renderEvents(observed, ids, viewer);
    assertEquals([...first.keys()], ids);
    assertEquals(
      roomAttempts,
      1,
      'all unchanged non-erased messages share one room read attempt',
    );
    const admission = await admitState(room, { userId: user.user_id });
    roomAttempts = 0;
    const state = await renderStateEvents(
      observed,
      admission.rows.map((row) => row.eventId),
      viewer,
      { admission },
    );
    assertEquals([...state.keys()], admission.rows.map((row) => row.eventId));
    assertEquals(
      roomAttempts,
      1,
      'state serialization uses the same room batch owner',
    );
    await putAccountData(
      app.tenant,
      localpartOf(user.user_id),
      '',
      'm.ignored_user_list',
      { ignored_users: { [user.user_id]: {} } },
    );
    assertEquals(
      (await renderEvents(observed, ids, viewer)).size,
      0,
      'a later operation captures its new ignore policy',
    );
    // State is not hidden by the non-state presentation filter.
    assertEquals(
      (await renderStateEvents(
        observed,
        admission.rows.map((row) => row.eventId),
        viewer,
        { admission },
      )).size,
      state.size,
    );
  } finally {
    app.tenant.tx = tenantTx;
    app.server.tx = serverTx;
  }
});
