import { assert, assertEquals, assertRejects } from '@std/assert';
import { startHttp } from '#tests/http-app.ts';
import { getRule, putRule, setRuleActions } from '#engine/tenant/pushrules.ts';
import { setReceipt, streamMax } from '#engine/server/ephemeral.ts';
import { setTyping, typingIn, typingSeq } from '#engine/typing.ts';
import { setConfigForTests } from '#engine/config.ts';
import { eduState } from '#engine/federation/edus.ts';

Deno.test('F6 expired notification listing is a read, not retention maintenance', async () => {
  const http = await startHttp();
  try {
    const a = await http.registerTestUser('retention', 'pw');
    const db = http.app.server;
    await db.execute(
      `INSERT INTO notifications VALUES(1,'localhost',?,'$old','!gone:localhost',1,'main','["notify"]',0,1,1,0)`,
      [a.user_id],
    );
    await db.execute(
      "INSERT INTO notification_history VALUES(1,?,'!gone:localhost',0,1)",
      [a.user_id],
    );
    const before = await db.query('SELECT * FROM notification_history');
    const response = await http.matrix(
      new Request('http://x/_matrix/client/v3/notifications', {
        headers: { Authorization: 'Bearer ' + a.access_token },
      }),
    );
    assertEquals(response.status, 200);
    assertEquals((await response.json()).notifications, []);
    assertEquals(await db.query('SELECT * FROM notification_history'), before);
    assertEquals(
      (await db.query('SELECT COUNT(*) AS n FROM notifications'))[0].n,
      1,
    );
  } finally {
    await http.close();
  }
});

Deno.test('F6 push-rule shared writers reject malformed shapes without changing rule or stream', async () => {
  const http = await startHttp();
  try {
    const account = await http.registerTestUser('rules', 'pw');
    const tenant = http.app.tenant;
    const tenantDb = await http.app.store.tenant(tenant.serverName);
    const valid = {
      actions: ['notify'],
      conditions: [{ kind: 'future_condition', extra: true }],
    };
    await putRule(tenant, 'rules', 'override', 'mine', valid, {});
    const before = await getRule(tenant, 'rules', 'override', 'mine');
    const stream = await tenantDb.query('SELECT * FROM push_rules_stream');
    const invalidPattern = await http.matrix(
      new Request(
        'http://x/_matrix/client/v3/pushrules/global/content/bad-pattern',
        {
          method: 'PUT',
          headers: { Authorization: 'Bearer ' + account.access_token },
          body: JSON.stringify({ actions: ['notify'], pattern: 7 }),
        },
      ),
    );
    assertEquals(invalidPattern.status, 400);
    await invalidPattern.body?.cancel();
    assertEquals(
      await tenantDb.query('SELECT * FROM push_rules_stream'),
      stream,
    );
    for (
      const conditions of [
        {},
        null,
        'bad',
        [null],
        [[]],
        [{}],
        [{ kind: 3 }],
        [{ kind: 'event_match' }],
        [{ kind: 'event_match', key: 'content.body', pattern: 3 }],
        [{ kind: 'event_property_is', key: 'content.x' }],
        [{ kind: 'event_property_contains', key: 'content.x', value: [] }],
        [{ kind: 'room_member_count' }],
        [{ kind: 'sender_notification_permission' }],
      ]
    ) {
      await assertRejects(() =>
        putRule(tenant, 'rules', 'override', 'mine', {
          ...valid,
          conditions: conditions as unknown[],
        }, {})
      );
      assertEquals(await getRule(tenant, 'rules', 'override', 'mine'), before);
      assertEquals(
        await tenantDb.query('SELECT * FROM push_rules_stream'),
        stream,
      );
    }
    for (const actions of [{}, null, ['unknown'], [null], [{ set_tweak: 7 }]]) {
      await assertRejects(() =>
        putRule(tenant, 'rules', 'override', 'mine', {
          ...valid,
          actions: actions as unknown[],
        }, {})
      );
      await assertRejects(() =>
        setRuleActions(
          tenant,
          'rules',
          'override',
          'mine',
          actions as unknown[],
        )
      );
      assertEquals(await getRule(tenant, 'rules', 'override', 'mine'), before);
      assertEquals(
        await tenantDb.query('SELECT * FROM push_rules_stream'),
        stream,
      );
    }
    await setRuleActions(tenant, 'rules', 'override', 'mine', ['notify', {
      set_tweak: 'sound',
      value: 'default',
    }]);
    assertEquals(
      (await getRule(tenant, 'rules', 'override', 'mine')).actions.length,
      2,
    );
    for (
      const condition of [
        { kind: 'event_match', key: 'content.body', pattern: '*' },
        { kind: 'event_property_is', key: 'content.x', value: null },
        { kind: 'event_property_contains', key: 'content.x', value: true },
        { kind: 'room_member_count', is: '>=2' },
        { kind: 'sender_notification_permission', key: 'room' },
        { kind: 'contains_display_name' },
        { kind: 'future_condition', extra: [] },
      ]
    ) {
      await putRule(tenant, 'rules', 'override', 'valid', {
        actions: ['dont_notify'],
        conditions: [condition],
      }, {});
      assertEquals(
        (await getRule(tenant, 'rules', 'override', 'valid')).conditions,
        [condition],
      );
    }
  } finally {
    await http.close();
  }
});

Deno.test('F6 receipt capacity cannot block notification projection of legacy receipts', async () => {
  const http = await startHttp();
  try {
    const a = await http.registerTestUser('capacity-a', 'pw');
    const b = await http.registerTestUser('capacity-b', 'pw');
    const call = async (
      path: string,
      token: string,
      body: unknown,
      method = 'POST',
    ) => {
      const response = await http.matrix(
        new Request('http://x/_matrix/client/v3/' + path, {
          method,
          headers: { Authorization: 'Bearer ' + token },
          body: JSON.stringify(body),
        }),
      );
      assertEquals(response.status, 200, await response.clone().text());
      return await response.json();
    };
    const room =
      (await call('createRoom', a.access_token!, { invite: [b.user_id] }))
        .room_id;
    const base = 'rooms/' + encodeURIComponent(room);
    await call(base + '/join', b.access_token!, {});
    const db = http.app.server;
    await db.tx(async (tx) => {
      for (let i = 0; i < 256; i++) {
        await tx.execute(
          'INSERT INTO notification_receipt_refs(user,room,scope,event) VALUES(?,?,?,?)',
          [a.user_id, room, '', '$pending-' + i],
        );
      }
      // Supported upgrades can have a retained wire receipt without a pending ref.
      await tx.execute(
        "INSERT INTO receipts VALUES(?,?,'m.read','','$legacy',1,1)",
        [room, a.user_id],
      );
    });
    const sent = await call(
      base + '/send/m.room.message/capacity',
      b.access_token!,
      { body: 'still published', msgtype: 'm.text' },
      'PUT',
    );
    assertEquals(
      (await db.query(
        'SELECT event FROM notifications WHERE user=? AND event=?',
        [a.user_id, sent.event_id],
      )).length,
      1,
    );
    assertEquals(
      (await db.query(
        'SELECT COUNT(*) AS n FROM notification_receipt_refs WHERE user=? AND room=?',
        [a.user_id, room],
      ))[0].n,
      256,
    );
    await assertRejects(() =>
      setReceipt(db, room, a.user_id, 'm.read', '$overflow')
    );
    assertEquals(
      (await db.query(
        'SELECT event_id FROM receipts WHERE user_id=? AND room_id=?',
        [a.user_id, room],
      ))[0].event_id,
      '$legacy',
    );
  } finally {
    await http.close();
  }
});

Deno.test('F6 receipt ingress preserves unthreaded state and bounds unknown durable roots', async () => {
  const http = await startHttp();
  try {
    const db = http.app.server;
    const room = '!receipts:test', user = '@remote:test';
    await db.execute(
      "INSERT INTO memberships(user,room,membership,event,seq) VALUES(?,?,'join','$join',0)",
      [user, room],
    );
    await setReceipt(db, room, user, 'm.read', '$first');
    const seq = await streamMax(db, 'receipts');
    for (
      const threadId of [
        '',
        123,
        {},
        [],
        'no-dollar',
        '$' + 'x'.repeat(255),
        '$' + 'é'.repeat(128),
      ]
    ) {
      await assertRejects(() =>
        setReceipt(db, room, user, 'm.read', '$bad', {
          threadId: threadId as string,
        })
      );
      assertEquals(await streamMax(db, 'receipts'), seq);
    }
    for (let i = 0; i < 105; i++) {
      await setReceipt(db, room, user, 'm.read', '$event' + i, {
        threadId: '$unknown' + i,
      });
    }
    const rows = await db.query(
      'SELECT thread_id,event_id FROM receipts WHERE room_id=? ORDER BY seq',
      [room],
    );
    assertEquals(rows.length, 101);
    assertEquals(rows[0], { thread_id: '', event_id: '$first' });
    assertEquals(rows[1], { thread_id: '$unknown0', event_id: '$event0' });
    const capSeq = await streamMax(db, 'receipts');
    assertEquals(
      await setReceipt(db, room, user, 'm.read', '$overflow', {
        threadId: '$overflow',
      }),
      false,
    );
    assertEquals(await streamMax(db, 'receipts'), capSeq);
    assert(
      await setReceipt(db, room, user, 'm.read', '$updated', {
        threadId: '$unknown0',
      }),
    );
    assert(
      await setReceipt(db, room, user, 'm.read', '$main', { threadId: 'main' }),
    );
    assert(
      (await db.query('SELECT 1 FROM notification_receipt_refs')).length <= 256,
    );
    for (let i = 0; i < 150; i++) {
      await setReceipt(db, room, user, 'm.read', '$pending' + i);
    }
    assertEquals(
      (await db.query('SELECT 1 FROM notification_receipt_refs')).length,
      253,
    );
    for (let i = 150; i < 153; i++) {
      await setReceipt(db, room, user, 'm.read', '$pending' + i);
    }
    const atCap = await streamMax(db, 'receipts');
    await assertRejects(() =>
      setReceipt(db, room, user, 'm.read', '$pending-overflow')
    );
    assertEquals(await streamMax(db, 'receipts'), atCap);
    assertEquals(
      (await db.query('SELECT 1 FROM notification_receipt_refs')).length,
      256,
    );
  } finally {
    await http.close();
  }
});

Deno.test('F6 sync captures receipt/member sets in constant queries and relevance avoids count hydration', async () => {
  const http = await startHttp();
  try {
    const a = await http.registerTestUser('snapshot', 'pw');
    const call = async (path: string, body?: unknown) => {
      const response = await http.matrix(
        new Request('http://x/_matrix/client/v3/' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Authorization: 'Bearer ' + a.access_token },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      assertEquals(response.status, 200, await response.clone().text());
      return await response.json();
    };
    for (let i = 0; i < 8; i++) await call('createRoom', {});
    const db = http.app.server, original = db.tx.bind(db);
    let queries = 0, elapsed = 0;
    db.tx = (fn, options) =>
      original(async (tx) => {
        const query = tx.query.bind(tx);
        tx.query = async (...args: Parameters<typeof tx.query>) => {
          const sql = args[0];
          const measured =
            /SELECT (?:r\.\*|\*) FROM receipts|SELECT (?:m\.room,m\.user,m\.membership,m\.seq|user,membership,seq) FROM memberships/
              .test(sql);
          const start = performance.now();
          const rows = await query(...args);
          if (measured) {
            queries++;
            elapsed += performance.now() - start;
          }
          return rows;
        };
        try {
          return await fn(tx);
        } finally {
          tx.query = query;
        }
      }, options);
    const initial = await call('sync');
    db.tx = original;
    assertEquals(Object.keys(initial.rooms.join).length, 8);
    console.log(
      JSON.stringify({ snapshotQueries: queries, snapshotMs: elapsed }),
    );
    assertEquals(queries, 2);
    const directQuery = db.query.bind(db);
    let hydrated = 0;
    db.query = async (...args) => {
      if (args[0].includes('FROM notification_counts')) hydrated++;
      return await directQuery(...args);
    };
    await call('sync?timeout=10&since=' + initial.next_batch);
    db.query = directQuery;
    assertEquals(hydrated, 0);
  } finally {
    await http.close();
  }
});

Deno.test('F6 typing outsider clears retained state without admitting a new start', async () => {
  const http = await startHttp();
  try {
    const db = http.app.server, room = '!typing:test', user = '@remote:test';
    await db.execute(
      "INSERT INTO memberships(user,room,membership,event,seq) VALUES(?,?,'join','$join',0)",
      [user, room],
    );
    assert(await setTyping(db, room, user, true));
    const before = typingSeq();
    await db.execute("UPDATE memberships SET membership='leave' WHERE room=?", [
      room,
    ]);
    assertEquals(await setTyping(db, room, user, false), false);
    assertEquals(typingIn(room).userIds, []);
    assert(typingSeq() > before);
    assertEquals(await setTyping(db, room, user, true), false);
    assertEquals(typingIn(room).userIds, []);
  } finally {
    await http.close();
  }
});

Deno.test('F6 HTTP departure clears typing and notification listing filters without deleting', async () => {
  const http = await startHttp();
  try {
    const a = await http.registerTestUser('a', 'pw'),
      b = await http.registerTestUser('b', 'pw');
    const call = async (
      path: string,
      token: string,
      body?: unknown,
      method?: string,
    ) => {
      const response = await http.matrix(
        new Request('http://x/_matrix/client/v3/' + path, {
          method: method ?? (body === undefined ? 'GET' : 'POST'),
          headers: { Authorization: 'Bearer ' + token },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      assertEquals(response.status, 200, await response.clone().text());
      return await response.json();
    };
    const room =
      (await call('createRoom', a.access_token!, { invite: [b.user_id] }))
        .room_id;
    const base = 'rooms/' + encodeURIComponent(room);
    await call(base + '/join', b.access_token!, {});
    await call(base + '/send/m.room.message/notification', b.access_token!, {
      body: 'hello',
      'm.mentions': {},
    }, 'PUT');
    const inbound = eduState(http.app.server, 'localhost', http.app.store);
    await inbound.dispatch('localhost', {
      edu_type: 'm.receipt',
      content: {
        [room]: {
          'm.read': {
            [a.user_id]: { event_ids: ['$bad'], data: { thread_id: 7 } },
            [b.user_id]: { event_ids: ['$valid'], data: { thread_id: 'main' } },
          },
        },
      },
    });
    assertEquals(
      await http.app.server.query(
        'SELECT user_id,thread_id,event_id FROM receipts WHERE room_id=?',
        [room],
      ),
      [{ user_id: b.user_id, thread_id: 'main', event_id: '$valid' }],
    );
    await inbound.dispatch('localhost', {
      edu_type: 'm.receipt',
      content: {
        [room]: {
          'm.read': {
            [b.user_id]: {
              event_ids: ['$bad-null'],
              data: { thread_id: null },
            },
            [a.user_id]: {
              event_ids: ['$later'],
              data: { thread_id: '$unknown-root' },
            },
          },
        },
      },
    });
    assertEquals(
      (await http.app.server.query(
        'SELECT event_id FROM receipts WHERE room_id=? ORDER BY seq',
        [room],
      )).map((r) => r.event_id),
      ['$valid', '$later'],
    );
    await setTyping(http.app.server, room, b.user_id, true);
    await call(base + '/leave', b.access_token!, {});
    assertEquals(typingIn(room).userIds, []);
    await call(base + '/invite', a.access_token!, { user_id: b.user_id });
    await call(base + '/join', b.access_token!, {});
    await setTyping(http.app.server, room, b.user_id, true);
    await call(base + '/ban', a.access_token!, { user_id: b.user_id });
    assertEquals(typingIn(room).userIds, []);
    await http.app.server.execute(
      'UPDATE notifications SET read_ms=1 WHERE user=?',
      [a.user_id],
    );
    await http.app.server.execute(
      'UPDATE notification_history SET read_ms=1 WHERE user=?',
      [a.user_id],
    );
    const retained = await http.app.server.query(
      'SELECT * FROM notification_history',
    );
    assert(retained.length > 0);
    const counts = await http.app.server.query(
      'SELECT * FROM notification_counts',
    );
    setConfigForTests({ push: { readretentiondays: 0 } });
    const listed = await call('notifications', a.access_token!);
    assertEquals(listed.notifications, []);
    assertEquals(
      await http.app.server.query('SELECT * FROM notification_history'),
      retained,
    );
    assertEquals(
      await http.app.server.query('SELECT * FROM notification_counts'),
      counts,
    );
  } finally {
    setConfigForTests({});
    await http.close();
  }
});
