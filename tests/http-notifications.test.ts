import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { setConfigForTests } from '#engine/config.ts';
import { theApp } from '#engine/app.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP notification history');
suite.test('history requires a valid authenticated account', async () => {
  for (
    const headers of [
      new Headers(),
      new Headers({ Authorization: 'Bearer invalid' }),
    ]
  ) {
    const response = await suite.matrix(
      new Request('http://x/_matrix/client/v3/notifications', { headers }),
    );
    assertEquals(response.status, 401);
    await response.body?.cancel();
  }
});
async function call(
  path: string,
  token: string,
  body?: unknown,
  method?: string,
  status = 200,
) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  assertEquals(response.status, status, await response.clone().text());
  return await response.json() as Json;
}

suite.test('would-have-notified history, highlights and stable exclusive pagination without pushers', async () => {
  const a = await suite.registerTestUser('history-a', 'pw');
  const b = await suite.registerTestUser('history-b', 'pw');
  const stranger = await suite.registerTestUser('history-stranger', 'pw');
  const room = String(
    (await call('createRoom', a.access_token!, { invite: [b.user_id] }))
      .room_id,
  );
  const base = 'rooms/' + encodeURIComponent(room);
  await call(base + '/join', b.access_token!, {});
  const send = async (txn: string, highlight = false) =>
    String(
      (await call(base + '/send/m.room.message/' + txn, a.access_token!, {
        body: txn,
        'm.mentions': highlight ? { user_ids: [b.user_id] } : {},
      }, 'PUT')).event_id,
    );
  const first = await send('first');
  const second = await send('second', true);
  const third = await send('third');
  const page = await call('notifications?limit=2', b.access_token!);
  const items = page.notifications as Json[];
  assertEquals(items.map((n) => (n.event as Json).event_id), [third, second]);
  for (const item of items) {
    assertEquals(item.room_id, room);
    assertEquals(item.read, false);
    assertEquals((item.event as Json).room_id, undefined);
    assertEquals((item.event as Json).signatures, undefined);
    assertEquals((item.event as Json).auth_events, undefined);
    assert(Array.isArray(item.actions));
    assert(typeof item.ts === 'number' && item.ts > 0);
    assertEquals(item.profile_tag, undefined);
  }
  assert(typeof page.next_token === 'string');
  const highlighted = await call(
    'notifications?only=highlight',
    b.access_token!,
  );
  assertEquals(
    (highlighted.notifications as Json[]).map((n) =>
      (n.event as Json).event_id
    ),
    [second],
  );
  await send('after-page');
  await call(
    base + '/receipt/m.read.private/' + encodeURIComponent(second),
    b.access_token!,
    {},
  );
  const rest = await call(
    'notifications?limit=100&from=' + page.next_token,
    b.access_token!,
  );
  assertEquals(
    (rest.notifications as Json[]).map((n) => (n.event as Json).event_id),
    [
      first,
      (await theApp().server.query(
        'SELECT event FROM notifications WHERE user=? AND room=? ORDER BY seq LIMIT 1',
        [b.user_id, room],
      ))[0].event,
    ],
  );
  assert((rest.notifications as Json[]).every((n) => n.read === true));
  assertEquals(rest.next_token, undefined);
  assertEquals(
    (await call('notifications', stranger.access_token!)).notifications,
    [],
  );
  await call(
    base + '/redact/' + encodeURIComponent(second) + '/redact',
    a.access_token!,
    {},
    'PUT',
  );
  assertEquals(
    (await call('notifications?only=highlight', b.access_token!)).notifications,
    [],
  );
  for (
    const query of [
      'from=nope',
      'from=n0',
      'from=n9007199254740992',
      'limit=-1',
      'limit=0',
      'limit=1.2',
      'limit=nope',
      'only=anything',
    ]
  ) {
    await call(
      'notifications?' + query,
      b.access_token!,
      undefined,
      undefined,
      400,
    );
  }
});

suite.test('encrypted events stay ciphertext and read status follows independent thread horizons', async () => {
  const a = await suite.registerTestUser('history-enc-a', 'pw');
  const b = await suite.registerTestUser('history-enc-b', 'pw');
  const room = String(
    (await call('createRoom', a.access_token!, { invite: [b.user_id] }))
      .room_id,
  );
  const base = 'rooms/' + encodeURIComponent(room);
  await call(base + '/join', b.access_token!, {});
  const ciphertext = {
    algorithm: 'm.megolm.v1.aes-sha2',
    ciphertext: 'opaque-blob',
    session_id: 'session',
  };
  const root = String(
    (await call(
      base + '/send/m.room.encrypted/root',
      a.access_token!,
      ciphertext,
      'PUT',
    )).event_id,
  );
  const child = String(
    (await call(base + '/send/m.room.encrypted/child', a.access_token!, {
      ...ciphertext,
      'm.relates_to': { rel_type: 'm.thread', event_id: root },
    }, 'PUT')).event_id,
  );
  await call(
    base + '/receipt/m.read.private/' + encodeURIComponent(root),
    b.access_token!,
    { thread_id: 'main' },
  );
  const items = (await call('notifications', b.access_token!))
    .notifications as Json[];
  const byId = new Map(items.map((n) => [(n.event as Json).event_id, n]));
  assertEquals((byId.get(root)!.event as Json).content, ciphertext);
  assertEquals(byId.get(root)!.read, true);
  assertEquals(byId.get(child)!.read, false);
});

suite.test('zero-day read history is removed immediately without deleting reconciliation facts', async () => {
  // The config seam is per-file; restore it even if an assertion fails.
  setConfigForTests({ push: { readretentiondays: 0 } });
  try {
    const a = await suite.registerTestUser('history-zero-a', 'pw');
    const b = await suite.registerTestUser('history-zero-b', 'pw');
    const room = String(
      (await call('createRoom', a.access_token!, { invite: [b.user_id] }))
        .room_id,
    );
    const base = 'rooms/' + encodeURIComponent(room);
    await call(base + '/join', b.access_token!, {});
    const event = String(
      (await call(base + '/send/m.room.message/read', a.access_token!, {
        body: 'activity',
        'm.mentions': {},
      }, 'PUT')).event_id,
    );
    assert(
      ((await call('notifications', b.access_token!)).notifications as Json[])
        .some((n) => (n.event as Json).event_id === event),
    );
    await call(
      base + '/receipt/m.read.private/' + encodeURIComponent(event),
      b.access_token!,
      {},
    );
    // Observe durable list membership before GET performs maintenance.
    assertEquals(
      await theApp().server.query(
        'SELECT h.seq FROM notification_history h JOIN notifications n ON n.seq=h.seq WHERE n.user=? AND n.room=?',
        [b.user_id, room],
      ),
      [],
    );
    assertEquals(
      (await call('notifications', b.access_token!)).notifications,
      [],
    );
    assertEquals(
      (await theApp().server.query(
        'SELECT COUNT(*) AS n FROM notifications WHERE user=? AND event=?',
        [b.user_id, event],
      ))[0].n,
      1,
    );
  } finally {
    setConfigForTests({});
  }
});

suite.test('bounded hidden-row scans advance cursors without leaking unavailable events', async () => {
  const a = await suite.registerTestUser('history-hidden-a', 'pw');
  const b = await suite.registerTestUser('history-hidden-b', 'pw');
  const room = String(
    (await call('createRoom', a.access_token!, { invite: [b.user_id] }))
      .room_id,
  );
  const base = 'rooms/' + encodeURIComponent(room);
  await call(base + '/join', b.access_token!, {});
  const event = String(
    (await call(base + '/send/m.room.message/visible', a.access_token!, {
      body: 'visible',
      'm.mentions': {},
    }, 'PUT')).event_id,
  );
  const app = theApp();
  await app.server.tx(async (tx) => {
    const max = Number(
      (await tx.query("SELECT value FROM counters WHERE name='notifications'"))[
        0
      ].value,
    );
    for (let i = 1; i <= 501; i++) {
      await tx.execute(
        "INSERT INTO notifications(seq,tenant,user,event,room,event_seq,thread,actions,highlight,created_ms,read_ms,withdrawn) VALUES(?,?,?,?,?,1,'main','[\"notify\"]',0,0,NULL,0)",
        [
          max + i,
          app.tenant.serverName,
          b.user_id,
          '$hidden-' + i,
          '!not-held:remote',
        ],
      );
      await tx.execute(
        'INSERT INTO notification_history(seq,user,room,highlight,read_ms) VALUES(?,?,?,0,NULL)',
        [max + i, b.user_id, '!not-held:remote'],
      );
    }
    await tx.execute("UPDATE counters SET value=? WHERE name='notifications'", [
      max + 501,
    ]);
  });
  const hidden = await call('notifications', b.access_token!);
  assertEquals(hidden.notifications, []);
  assert(typeof hidden.next_token === 'string');
  const visible = await call(
    'notifications?from=' + hidden.next_token,
    b.access_token!,
  );
  const events = (visible.notifications as Json[]).map((n) =>
    (n.event as Json).event_id
  );
  assert(events.includes(event));
  assert(!events.some((id) => String(id).startsWith('$hidden-')));
  assertEquals(visible.next_token, undefined);
});
