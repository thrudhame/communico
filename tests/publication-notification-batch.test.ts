import { assertEquals } from '@std/assert';
import { applyPushPublication } from '#engine/server/notifications.ts';
import type { PublicationDecision } from '#engine/server/push-project.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import type { Database } from '#engine/store/db.ts';
import { syncStreamHeads } from '#engine/server/stream.ts';

const room = '!ordered:test';
const sender = '@sender:test';
const now = 1800000000000;

async function withServer(run: (db: Database) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema } });
  try {
    await run(await store.server());
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

const recipient = (i: number): PublicationDecision => ({
  tenant: 'test',
  user: `@recipient${i}:test`,
  ruleRevision: 2,
  ignoreRevision: 3,
  decision: {
    notify: true,
    highlight: i % 2 === 0,
    actions: ['notify'],
    tweaks: {},
    ruleId: 'ordered-test',
    kind: 'override',
  },
});

async function index(db: Database, event: string, seq: number) {
  await db.execute(
    "INSERT INTO event_index(event,room,pos,standing,grounding,seq) VALUES(?,?,?,'accepted','grounded',?)",
    [event, room, seq, seq],
  );
}

for (const size of [4, 12]) {
  Deno.test(`ordered notification batch writes ${size} decisions in one set`, async () => {
    await withServer(async (db) => {
      const event = '$fresh';
      await index(db, event, 1);
      const writes = { evaluations: 0, counts: 0, history: 0 };
      await db.tx(async (tx) => {
        const execute = tx.execute.bind(tx);
        tx.execute = (sql, values) => {
          if (sql.includes('INSERT INTO push_evaluations')) {
            writes.evaluations++;
          }
          if (sql.includes('INTO notification_counts')) writes.counts++;
          if (sql.includes('INTO notification_history')) writes.history++;
          return execute(sql, values);
        };
        await applyPushPublication(tx, room, event, 1, 1, {
          sender,
          decisions: Array.from({ length: size }, (_, i) => recipient(i)),
        }, now);
      });
      assertEquals(
        (await db.query('SELECT seq FROM notifications')).length,
        size,
      );
      assertEquals(writes, { evaluations: 1, counts: 1, history: 1 });
    });
  });
}

for (const exclusion of ['graph', 'authority', 'replay', 'seed'] as const) {
  Deno.test(`ordered notification batch preserves scalar ${exclusion} effects`, async () => {
    await withServer(async (db) => {
      const event = '$fresh';
      const user = recipient(1).user;
      await index(db, event, 2);
      if (exclusion === 'graph') {
        await db.execute(
          "INSERT INTO facade_owner_activation VALUES('p',1,'h')",
        );
      } else if (exclusion === 'authority') {
        // Isolate the authority predicate from graph mode with a read witness;
        // the actual scalar decision owner sees the same authority response.
      } else if (exclusion === 'replay') {
        await db.tx((tx) =>
          applyPushPublication(tx, room, event, 2, 2, {
            sender,
            decisions: [recipient(1)],
          }, now)
        );
      } else {
        await index(db, '$receipt', 1);
        await db.execute(
          "INSERT INTO receipts VALUES(?,?,'m.read','',?,1,1)",
          [room, user, JSON.stringify(['$receipt'])],
        );
      }
      const scalar: string[] = [];
      await db.tx(async (tx) => {
        const query = tx.query.bind(tx);
        tx.query = (sql, values = []) => {
          if (
            sql.startsWith('SELECT operation_id,native FROM push_evaluations')
          ) {
            scalar.push(String(values[1]));
          }
          if (
            exclusion === 'authority' &&
            sql.startsWith(
              'SELECT c.signed_json,p.node FROM facade_owner_activation',
            )
          ) {
            return Promise.resolve([{
              signed_json: JSON.stringify({
                body: {
                  server: 'other.test',
                  nodes: [{ node: 'home', incarnation: 'i' }],
                },
              }),
              node: 'home',
            }]);
          }
          return query(sql, values);
        };
        await applyPushPublication(tx, room, event, 2, 2, {
          sender,
          decisions: [recipient(0), recipient(1), recipient(2)],
        }, now);
      });
      assertEquals(
        scalar,
        exclusion === 'graph' || exclusion === 'authority'
          ? [recipient(0).user, user, recipient(2).user]
          : [user],
      );
      assertEquals((await db.query('SELECT seq FROM notifications')).length, 3);
      if (exclusion === 'seed') {
        assertEquals(
          await db.query(
            'SELECT event_seq FROM notification_horizons WHERE user=?',
            [user],
          ),
          [{ event_seq: 1 }],
        );
      }
    });
  });
}

Deno.test('ordered notification batch matches scalar facts and tokens across plain, threaded and redacted events', async () => {
  const results: {
    facts: string[][];
    heads: Awaited<ReturnType<typeof syncStreamHeads>>;
  }[] = [];
  for (const forceScalar of [false, true]) {
    await withServer(async (db) => {
      const events = ['$plain', '$thread', '$redacted'];
      for (let at = 0; at < events.length; at++) {
        await index(db, events[at], at + 1);
      }
      await db.execute(
        "INSERT INTO relations VALUES('$thread','$plain','m.thread',?,2)",
        [room],
      );
      await db.execute(
        "INSERT INTO redactions(room,target,event,pos) VALUES(?,'$redacted','$redaction',3)",
        [room],
      );
      await db.execute('INSERT INTO notification_retired_users VALUES(?)', [
        recipient(2).user,
      ]);
      const decisions = [recipient(0), recipient(1), recipient(2), {
        ...recipient(3),
        decision: null,
      }];
      for (let at = 0; at < events.length; at++) {
        await db.tx(async (tx) => {
          if (forceScalar) {
            const query = tx.query.bind(tx);
            tx.query = async (sql, values) => {
              const rows = await query(sql, values);
              return sql.startsWith('WITH recipients AS (')
                ? rows.map((row) => ({ ...row, replay: 1 }))
                : rows;
            };
          }
          await applyPushPublication(tx, room, events[at], at + 1, at + 1, {
            sender: at === 1 ? recipient(0).user : sender,
            decisions,
          }, now);
        });
      }
      const tables = [
        'push_evaluations',
        'notification_own_events',
        'notifications',
        'notification_history',
        'notification_counts',
        'notification_changes',
        'notification_horizons',
        'notification_graph_reads',
      ];
      const facts = await Promise.all(
        tables.map(async (table) =>
          (await db.query(`SELECT * FROM ${table}`)).map((row) =>
            JSON.stringify(row)
          ).sort()
        ),
      );
      results.push({ facts, heads: await syncStreamHeads(db) });
    });
  }
  assertEquals(results[0], results[1]);
});
