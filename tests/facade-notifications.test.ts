import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import {
  advanceNotificationRead,
  applyPushPublication,
  importNotificationOperation,
  notificationSnapshot,
  reconcileNotificationEvent,
  removeNotificationFacts,
  roomNotificationCounts,
} from '#engine/server/notifications.ts';
import {
  captureNotificationOperations,
  notificationOperations,
} from '#engine/server/notification-operations.ts';
import { createHash } from 'node:crypto';
import type { PushPublication } from '#engine/server/push-project.ts';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-notifications-' });
  const stores: Awaited<ReturnType<typeof openStore>>[] = [];
  for (const side of ['home', 'edge', 'recovered']) {
    const node = side === 'home' ? 'home' : 'edge';
    const store = await openStore({
      dir: dir + '/' + side,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema } });
    stores.push(store);
    const db = await store.server();
    await db.tx(async (conn) => {
      await conn.execute('INSERT INTO publication_domain VALUES(1,?,?,?)', [
        node,
        node + '-store',
        node + '-domain',
      ]);
      await conn.execute('INSERT INTO facade_owner_controls VALUES(?,1,?,?)', [
        'pair',
        'hash',
        JSON.stringify({
          body: {
            server: 'test',
            grantRevision: 1,
            nodes: ['home', 'edge'].map((node) => ({
              node,
              incarnation: node + '-store',
            })),
          },
        }),
      ]);
      await conn.execute('INSERT INTO facade_owner_activation VALUES(?,1,?)', [
        'pair',
        'hash',
      ]);
      await conn.execute(
        "INSERT INTO event_index(event,room,pos,standing,grounding,seq) VALUES('$event','!room:test',1,'accepted','grounded',?)",
        [node === 'home' ? 5 : 71],
      );
      await conn.execute(
        "INSERT INTO receipt_dag_nodes(room,event) VALUES('!room:test','$event')",
      );
    });
  }
  return {
    home: await stores[0].server(),
    edge: await stores[1].server(),
    recovered: await stores[2].server(),
    stores,
    async reopenEdge() {
      await stores[1].close();
      stores[1] = await openStore({
        dir: dir + '/edge',
        library: './.native/libturso_ffi.so',
        checkpointlogbytes: 65536,
        maxopenfiles: 8,
        idleseconds: 300,
      }, { schemas: { server: serverSchema } });
      return await stores[1].server();
    },
    async close() {
      for (const store of stores) await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

function publication(notify = true): PushPublication {
  return {
    sender: '@alice:test',
    decisions: [{
      tenant: 'test',
      user: '@bob:test',
      ruleRevision: 4,
      ignoreRevision: 2,
      pusherIncarnations: ['native-device'],
      decision: {
        kind: 'underride',
        ruleId: 'saved-rule',
        notify,
        highlight: false,
        actions: notify ? ['notify'] : ['dont_notify'],
        tweaks: {},
      },
    }],
  };
}

Deno.test('facade notifications: native notify and suppress retain immutable source intent with their projection', async (t) => {
  for (const notify of [true, false]) {
    await t.step(String(notify), async () => {
      const f = await fixture();
      try {
        const publish = () =>
          f.home.tx((conn) =>
            applyPushPublication(
              conn,
              '!room:test',
              '$event',
              5,
              17,
              publication(notify),
              1000,
            )
          );
        await publish();
        const facts = await f.home.query(
          "SELECT * FROM domain_operations WHERE kind='notification'",
        );
        assertEquals(
          facts.length,
          1,
          'saved evaluation lacks atomic export intent',
        );
        assertEquals(facts[0].source, 'home');
        const saved = JSON.parse(String(facts[0].payload_json));
        assertEquals(saved.notify, notify);
        assertEquals(
          saved.actions,
          publication(notify).decisions[0].decision!.actions,
        );
        assertEquals(saved.ruleRevision, 4);
        await publish();
        assertEquals(
          await f.home.query(
            "SELECT * FROM domain_operations WHERE kind='notification'",
          ),
          facts,
        );
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('facade notifications: source fact and saved evaluation roll back together', async () => {
  const f = await fixture();
  try {
    await assertRejects(
      () =>
        f.home.tx(async (conn) => {
          await applyPushPublication(
            conn,
            '!room:test',
            '$event',
            5,
            17,
            publication(),
            1000,
          );
          throw new Error('rollback');
        }),
      Error,
      'rollback',
    );
    assertEquals(await f.home.query('SELECT * FROM push_evaluations'), []);
    assertEquals(await f.home.query('SELECT * FROM domain_operations'), []);
  } finally {
    await f.close();
  }
});

Deno.test('facade notifications: native notify/suppress wins every import order without changing gateway work', async (t) => {
  for (const notify of [true, false]) {
    for (const nativeFirst of [true, false]) {
      await t.step(`${notify}/${nativeFirst}`, async () => {
        const f = await fixture();
        try {
          await f.home.tx((conn) =>
            applyPushPublication(
              conn,
              '!room:test',
              '$event',
              5,
              17,
              publication(!notify),
              1000,
            )
          );
          const [original] = await f.home.tx((conn) =>
            notificationOperations(conn, '@bob:test')
          );
          const native = () =>
            f.edge.tx((conn) =>
              applyPushPublication(
                conn,
                '!room:test',
                '$event',
                71,
                3,
                publication(notify),
                2000,
              )
            );
          const receive = () =>
            f.edge.tx((conn) =>
              importNotificationOperation(conn, original, 3000)
            );
          if (nativeFirst) await native();
          await receive();
          if (!nativeFirst) {
            assertEquals(await f.edge.query('SELECT * FROM push_delivery'), []);
            assertEquals(await f.edge.query('SELECT * FROM push_badges'), []);
            await native();
          }
          const deliveries = await f.edge.query('SELECT * FROM push_delivery');
          const badges = await f.edge.query('SELECT * FROM push_badges');
          await receive();
          await native();
          assertEquals(
            await f.edge.query('SELECT * FROM push_delivery'),
            deliveries,
          );
          assertEquals(await f.edge.query('SELECT * FROM push_badges'), badges);
          assertEquals(deliveries.length, notify ? 1 : 0);
          const rows = await f.edge.query(
            'SELECT actions,event_seq,created_ms FROM notifications',
          );
          assertEquals(rows.length, notify ? 1 : 0);
          if (notify) {
            assertEquals(rows[0], {
              actions: '["notify"]',
              event_seq: 71,
              created_ms: 2000,
            });
          }
          assertEquals(
            await f.edge.tx(async (conn) =>
              roomNotificationCounts(
                (await notificationSnapshot(conn, '@bob:test', 0)).rooms.get(
                  '!room:test',
                ),
              )
            ),
            {
              notification_count: notify ? 1 : 0,
              highlight_count: 0,
            },
          );
          assertEquals(
            (await f.edge.tx((conn) =>
              notificationOperations(conn, '@bob:test')
            )).length,
            2,
          );
          assertEquals(
            await f.edge.tx((conn) =>
              notificationOperations(conn, '@alice:test')
            ),
            [],
          );
        } finally {
          await f.close();
        }
      });
    }
  }
});

Deno.test('facade notifications: different actions stay native and original imported actions remain immutable', async () => {
  const f = await fixture();
  try {
    const home = publication(), edge = publication();
    home.decisions[0].decision!.actions.push({
      set_tweak: 'sound',
      value: 'home',
    });
    edge.decisions[0].decision!.actions.push({
      set_tweak: 'sound',
      value: 'edge',
    });
    await f.home.tx((conn) =>
      applyPushPublication(conn, '!room:test', '$event', 5, 17, home, 1000)
    );
    const [operation] = await f.home.tx((conn) =>
      notificationOperations(conn, '@bob:test')
    );
    await f.edge.tx((conn) =>
      importNotificationOperation(conn, operation, 2000)
    );
    await f.edge.tx((conn) =>
      applyPushPublication(conn, '!room:test', '$event', 71, 3, edge, 3000)
    );
    await f.edge.tx((conn) =>
      importNotificationOperation(conn, operation, 4000)
    );
    assertEquals(
      JSON.parse(
        String(
          (await f.edge.query('SELECT actions FROM notifications'))[0].actions,
        ),
      ),
      edge.decisions[0].decision!.actions,
    );
    const facts = await f.edge.tx((conn) =>
      notificationOperations(conn, '@bob:test')
    );
    assertEquals(facts.find((op) => op.source === 'home'), operation);
  } finally {
    await f.close();
  }
});

Deno.test('facade notifications: missing event evidence retains facts and projects locally on arrival without dispatch', async () => {
  const f = await fixture();
  try {
    await f.home.tx((conn) =>
      applyPushPublication(
        conn,
        '!room:test',
        '$event',
        5,
        17,
        publication(),
        1000,
      )
    );
    const [operation] = await f.home.tx((conn) =>
      notificationOperations(conn, '@bob:test')
    );
    await f.edge.execute('DELETE FROM event_index');
    await f.edge.tx((conn) =>
      importNotificationOperation(conn, operation, 2000)
    );
    assertEquals(await f.edge.query('SELECT * FROM notifications'), []);
    assertEquals(
      await f.edge.tx((conn) => notificationOperations(conn, '@bob:test')),
      [operation],
    );
    await f.edge.tx(async (conn) => {
      await conn.execute(
        "INSERT INTO event_index(event,room,pos,standing,grounding,seq) VALUES('$event','!room:test',3,'accepted','grounded',71)",
      );
      await reconcileNotificationEvent(conn, '!room:test', '$event', 3000);
      await reconcileNotificationEvent(conn, '!room:test', '$event', 3000);
    });
    assertEquals(
      (await f.edge.query('SELECT event_seq,created_ms FROM notifications'))[0],
      { event_seq: 71, created_ms: 1000 },
    );
    assertEquals(await f.edge.query('SELECT * FROM push_delivery'), []);
    assertEquals(await f.edge.query('SELECT * FROM push_badges'), []);
    await f.edge.tx((conn) =>
      advanceNotificationRead(
        conn,
        '@bob:test',
        '!room:test',
        '',
        '$event',
        4000,
      )
    );
    assertEquals(
      (await f.edge.query('SELECT read_ms FROM notifications'))[0].read_ms,
      4000,
    );
    assertEquals(
      (await f.edge.query('SELECT unread FROM notification_counts'))[0].unread,
      0,
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade notifications: malformed, foreign and changed saved evaluations roll back atomically', async () => {
  const f = await fixture();
  try {
    await f.home.tx((conn) =>
      applyPushPublication(
        conn,
        '!room:test',
        '$event',
        5,
        17,
        publication(),
        1000,
      )
    );
    const [operation] = await f.home.tx((conn) =>
      notificationOperations(conn, '@bob:test')
    );
    await f.edge.tx((conn) =>
      importNotificationOperation(conn, operation, 2000)
    );
    const payload = JSON.stringify({
      ...JSON.parse(operation.payload),
      notify: false,
    });
    for (
      const invalid of [
        {
          ...operation,
          payload,
          payloadHash: createHash('sha256').update(payload).digest('hex'),
        },
        { ...operation, source: 'foreign' },
        {
          ...operation,
          semanticKey: JSON.stringify([
            'notification',
            'alice',
            '!room:test',
            '$event',
          ]),
        },
        { ...operation, sequence: 2 },
      ]
    ) {
      await assertRejects(() =>
        f.edge.tx((conn) => importNotificationOperation(conn, invalid, 3000))
      );
    }
    assertEquals(
      await f.edge.tx((conn) => notificationOperations(conn, '@bob:test')),
      [operation],
    );
    assertEquals(
      (await f.edge.query('SELECT unread FROM notification_counts'))[0].unread,
      1,
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade notifications: legacy capture preserves saved decisions without relabeling imported facts or publishing news', async () => {
  const f = await fixture();
  try {
    await f.home.execute('DELETE FROM facade_owner_activation');
    await f.home.tx((conn) =>
      applyPushPublication(
        conn,
        '!room:test',
        '$event',
        5,
        17,
        publication(),
        1000,
      )
    );
    assertEquals(await f.home.query('SELECT * FROM domain_operations'), []);
    await f.home.execute(
      "INSERT INTO facade_owner_activation VALUES('pair',1,'hash')",
    );
    const notifications = await f.home.query('SELECT * FROM notifications');
    const news = await f.home.query('SELECT * FROM notification_changes');
    const operations = await f.home.tx((conn) =>
      captureNotificationOperations(conn, '@bob:test')
    );
    assertEquals(operations.length, 1);
    assertEquals(
      await f.home.query('SELECT * FROM notifications'),
      notifications,
    );
    assertEquals(
      await f.home.query('SELECT * FROM notification_changes'),
      news,
    );
    await f.edge.tx((conn) =>
      importNotificationOperation(conn, operations[0], 2000)
    );
    assertEquals(
      await f.edge.tx((conn) =>
        captureNotificationOperations(conn, '@bob:test')
      ),
      operations,
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade notifications: account retirement cannot be undone by a saved fact replay or late event', async () => {
  const f = await fixture();
  try {
    await f.home.tx((conn) =>
      applyPushPublication(
        conn,
        '!room:test',
        '$event',
        5,
        17,
        publication(),
        1000,
      )
    );
    const [operation] = await f.home.tx((conn) =>
      notificationOperations(conn, '@bob:test')
    );
    await f.edge.tx((conn) =>
      importNotificationOperation(conn, operation, 2000)
    );
    await f.edge.tx((conn) =>
      removeNotificationFacts(conn, { user: '@bob:test' })
    );
    await f.edge.tx(async (conn) => {
      await importNotificationOperation(conn, operation, 3000);
      await reconcileNotificationEvent(conn, '!room:test', '$event', 3000);
    });
    assertEquals(await f.edge.query('SELECT * FROM notifications'), []);
    assertEquals(await f.edge.query('SELECT * FROM notification_history'), []);
    assertEquals(
      await f.edge.tx((conn) => notificationOperations(conn, '@bob:test')),
      [operation],
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade notifications: home wins imported-only contexts even over a recovered own-source context in either order', async (t) => {
  for (const homeFirst of [true, false]) {
    await t.step(String(homeFirst), async () => {
      const f = await fixture();
      try {
        await f.home.tx((conn) =>
          applyPushPublication(
            conn,
            '!room:test',
            '$event',
            5,
            17,
            publication(false),
            1000,
          )
        );
        await f.edge.tx((conn) =>
          applyPushPublication(
            conn,
            '!room:test',
            '$event',
            71,
            3,
            publication(true),
            2000,
          )
        );
        const [home] = await f.home.tx((conn) =>
          notificationOperations(conn, '@bob:test')
        );
        const [edge] = await f.edge.tx((conn) =>
          notificationOperations(conn, '@bob:test')
        );
        for (const operation of homeFirst ? [home, edge] : [edge, home]) {
          await f.recovered.tx((conn) =>
            importNotificationOperation(conn, operation, 3000)
          );
        }
        assertEquals(
          await f.recovered.query('SELECT * FROM notifications'),
          [],
        );
        assertEquals(
          (await f.recovered.query(
            'SELECT operation_id,native FROM push_evaluations',
          ))[0],
          { operation_id: home.operationId, native: 0 },
        );
        assertEquals(
          await f.recovered.query('SELECT * FROM push_delivery'),
          [],
        );
        assertEquals(await f.recovered.query('SELECT * FROM push_badges'), []);
        assertEquals(
          (await f.recovered.tx((conn) =>
            notificationOperations(conn, '@bob:test')
          )).length,
          2,
        );
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('facade notifications: native context and terminal lifecycle survive cold store reopen', async () => {
  const f = await fixture();
  try {
    await f.home.tx((conn) =>
      applyPushPublication(
        conn,
        '!room:test',
        '$event',
        5,
        17,
        publication(false),
        1000,
      )
    );
    await f.edge.tx((conn) =>
      applyPushPublication(
        conn,
        '!room:test',
        '$event',
        71,
        3,
        publication(true),
        2000,
      )
    );
    const [operation] = await f.home.tx((conn) =>
      notificationOperations(conn, '@bob:test')
    );
    const db = await f.reopenEdge();
    await db.tx((conn) => importNotificationOperation(conn, operation, 3000));
    assertEquals(
      (await db.query('SELECT actions,created_ms FROM notifications'))[0],
      { actions: '["notify"]', created_ms: 2000 },
    );
    assertEquals(
      (await db.query('SELECT native FROM push_evaluations'))[0].native,
      1,
    );
    await db.tx((conn) => removeNotificationFacts(conn, { user: '@bob:test' }));
    const reopened = await f.reopenEdge();
    await reopened.tx((conn) =>
      importNotificationOperation(conn, operation, 4000)
    );
    assertEquals(await reopened.query('SELECT * FROM notifications'), []);
  } finally {
    await f.close();
  }
});
