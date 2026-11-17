import { assert, assertEquals, assertRejects } from '@std/assert';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { startHttp } from '#tests/http-app.ts';
import { dropOperatorRoom } from '#engine/room/operator.ts';
import { clientCompletion } from '#engine/client/completion.ts';

Deno.test('client completion: tenant finish is atomic, exact, client-scoped and revision-fenced', async () => {
  const http = await startHttp();
  const { app } = http;
  try {
    const alice = await http.registerTestUser('completion-tenant', 'pw');
    const bob = await http.registerTestUser('completion-other', 'pw');
    const device = await deviceIdentity(
      app.tenant,
      'completion-tenant',
      alice.device_id!,
    );
    const other = await deviceIdentity(
      app.tenant,
      'completion-other',
      bob.device_id!,
    );
    const created = await createRoom(app.store, {
      creator: alice.user_id,
      preset: 'public_chat',
    }, app.tenant.signer());
    const room = await openRoom(app.store, created.roomId);
    const db = await app.store.tenant(app.tenant.serverName);
    const endpoint = {
      kind: 'send' as const,
      roomId: room.id,
      eventType: 'm.room.message',
    };
    const write = (body: string) =>
      sendLocal(room, {
        type: 'm.room.message',
        sender: alice.user_id,
        content: { msgtype: 'm.text', body },
      }, app.tenant.signer());
    const first = await write('first');
    const target = first.completion!;
    await app.tenant.tx((tx) =>
      tx.txns.prepare(device, endpoint, 'first', JSON.parse(first.event.pdu))
    );
    await assertRejects(
      () =>
        app.tenant.tx(async (tx) => {
          await tx.txns.finish(
            device,
            endpoint,
            'first',
            first.eventId,
            true,
            target,
          );
          throw new Error('rollback finish');
        }),
      Error,
      'rollback finish',
    );
    assertEquals(
      await db.query('SELECT completed FROM transactions WHERE txn_id=?', [
        'first',
      ]),
      [{ completed: 0 }],
    );
    assertEquals(
      await app.tenant.tx((tx) => tx.completion.pending(device)),
      [],
    );
    assertEquals(await db.query('SELECT * FROM transaction_completions'), []);
    await app.tenant.tx((tx) =>
      tx.txns.finish(device, endpoint, 'first', first.eventId, true, target)
    );
    const [captured] = await app.tenant.tx((tx) =>
      tx.completion.pending(device)
    );
    assertEquals(captured.roomId, target.roomId);
    assertEquals(captured.generation, target.generation);
    assertEquals(captured.through, target.through);
    assertEquals(await app.tenant.tx((tx) => tx.completion.pending(other)), []);
    // Exact repeat is a no-op, including its pending-cut allocator/revision.
    await app.tenant.tx((tx) =>
      tx.txns.finish(device, endpoint, 'first', first.eventId, true, target)
    );
    assertEquals(await app.tenant.tx((tx) => tx.completion.pending(device)), [
      captured,
    ]);
    await assertRejects(
      () =>
        app.tenant.tx((tx) =>
          tx.txns.finish(device, endpoint, 'first', first.eventId, true, {
            ...target,
            through: target.through + 1,
          })
        ),
      Error,
      'E_CLIENT_COMPLETION_TARGET',
    );
    const second = await write('second');
    await app.tenant.tx(async (tx) => {
      await tx.txns.prepare(
        device,
        endpoint,
        'second',
        JSON.parse(second.event.pdu),
      );
      await tx.txns.finish(
        device,
        endpoint,
        'second',
        second.eventId,
        true,
        second.completion!,
      );
    });
    const [higher] = await app.tenant.tx((tx) => tx.completion.pending(device));
    assert(higher.revision > captured.revision);
    assert(higher.through > captured.through);
    await app.tenant.tx((tx) => tx.completion.retire(device, captured));
    assertEquals(await app.tenant.tx((tx) => tx.completion.pending(device)), [
      higher,
    ]);
    await app.tenant.tx((tx) => tx.completion.retire(device, higher));
    assertEquals(
      await app.tenant.tx((tx) => tx.completion.pending(device)),
      [],
    );
    // Retirement is not deletion of the historical exact transaction witness.
    assertEquals(
      (await db.query(
        'SELECT event_id FROM transaction_completions ORDER BY through',
      )).map((r) => r.event_id),
      [first.eventId, second.eventId],
    );
    await app.tenant.tx((tx) =>
      tx.devices.delete(device.deviceId, device.localpart)
    );
    assertEquals(await db.query('SELECT * FROM transaction_completions'), []);
    await assertRejects(
      () => app.tenant.tx((tx) => tx.completion.pending(device)),
      Error,
      'device no longer exists',
    );
    assertEquals(await app.tenant.tx((tx) => tx.completion.pending(other)), []);
  } finally {
    await http.close();
  }
});

Deno.test('client completion: failed sync and cancelled consumer retain captured markers; later revisions survive', async () => {
  const http = await startHttp();
  const { app } = http;
  try {
    const alice = await http.registerTestUser('completion-render', 'pw');
    const device = await deviceIdentity(
      app.tenant,
      'completion-render',
      alice.device_id!,
    );
    const created = await createRoom(app.store, {
      creator: alice.user_id,
      preset: 'public_chat',
    }, app.tenant.signer());
    const send = async (txn: string) => {
      const response = await http.matrix(
        new Request(
          'http://x/_matrix/client/v3/rooms/' +
            encodeURIComponent(created.roomId) + '/send/m.room.message/' + txn,
          {
            method: 'PUT',
            headers: { Authorization: 'Bearer ' + alice.access_token },
            body: JSON.stringify({ msgtype: 'm.text', body: txn }),
          },
        ),
      );
      assertEquals(response.status, 200);
      await response.json();
    };
    await send('render-first');
    const pending = () => app.tenant.tx((tx) => tx.completion.pending(device));
    const first = await pending();
    const original = app.server.tx.bind(app.server);
    let injected = false;
    app.server.tx = (fn, options) =>
      original(async (tx) => {
        const query = tx.query.bind(tx);
        tx.query = (sql, values) => {
          if (sql === 'SELECT name,value FROM counters') {
            injected = true;
            throw new Error('consumer snapshot failed');
          }
          return query(sql, values);
        };
        return await fn(tx);
      }, options);
    try {
      const response = await http.matrix(
        new Request('http://x/_matrix/client/v3/sync?timeout=0', {
          headers: { Authorization: 'Bearer ' + alice.access_token },
        }),
      );
      assertEquals(response.status, 500);
      await response.json();
      assert(injected);
      assertEquals(await pending(), first);
    } finally {
      app.server.tx = original;
    }
    const abort = new AbortController();
    const cancelled = await clientCompletion(app, device, abort.signal);
    abort.abort(new Error('consumer abandoned result'));
    await assertRejects(
      () => cancelled.retire(),
      Error,
      'consumer abandoned result',
    );
    assertEquals(await pending(), first);
    const captured = await clientCompletion(app, device);
    await send('render-higher');
    const higher = await pending();
    assert(higher[0].revision > first[0].revision);
    await captured.retire();
    assertEquals(await pending(), higher);
    const completed = await clientCompletion(app, device);
    await completed.retire();
    assertEquals(await pending(), []);
  } finally {
    await http.close();
  }
});

Deno.test('client completion: explicit retirement reconciles satisfied markers before unlink', async () => {
  const http = await startHttp();
  const { app } = http;
  try {
    const alice = await http.registerTestUser('completion-retire', 'pw');
    const device = await deviceIdentity(
      app.tenant,
      'completion-retire',
      alice.device_id!,
    );
    const created = await createRoom(app.store, {
      creator: alice.user_id,
      preset: 'public_chat',
    }, app.tenant.signer());
    const room = await openRoom(app.store, created.roomId);
    const event = await sendLocal(room, {
      type: 'm.room.message',
      sender: alice.user_id,
      content: { msgtype: 'm.text', body: 'retire after this obligation' },
    }, app.tenant.signer());
    const endpoint = {
      kind: 'send' as const,
      roomId: room.id,
      eventType: 'm.room.message',
    };
    await app.tenant.tx(async (tx) => {
      await tx.txns.prepare(
        device,
        endpoint,
        'retire',
        JSON.parse(event.event.pdu),
      );
      await tx.txns.finish(
        device,
        endpoint,
        'retire',
        event.eventId,
        true,
        event.completion!,
      );
    });
    assertEquals(
      (await app.tenant.tx((tx) => tx.completion.pending(device))).length,
      1,
    );
    await dropOperatorRoom(app, room.id);
    assertEquals(
      await app.tenant.tx((tx) => tx.completion.pending(device)),
      [],
    );
    // Historical completed receipts survive the intentional room lifecycle.
    assertEquals(
      await (await app.store.tenant(app.tenant.serverName)).query(
        'SELECT event_id FROM transaction_completions WHERE txn_id=?',
        ['retire'],
      ),
      [{ event_id: event.eventId }],
    );
    assertEquals((await app.store.rooms()).includes(room.id), false);
  } finally {
    await http.close();
  }
});
