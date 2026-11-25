import { assertEquals, assertRejects } from '@std/assert';
import { dropOperatorRoom } from '#engine/room/operator.ts';
import { startHttp } from '#tests/http-app.ts';
import { setConfigForTests } from '#engine/config.ts';
import { genesis } from '#tests/fixtures/genesis.ts';

// Independent of removal.ts: a new room-keyed server table must choose its
// lifecycle here, then prove it with a populated row through the real owner.
const cleared = [
  // The visibility deletion retires the rank row in the same transaction.
  'directory_rank',
  'aliases',
  'directory',
  'e2ee_room_members',
  'e2ee_rooms',
  'event_index',
  'federation_invite_attempts',
  'feed',
  'forgotten',
  'memberships',
  'notification_changes',
  'notification_counts',
  'notification_graph_reads',
  'notification_history',
  'notification_horizons',
  'notification_own_events',
  'notification_receipt_refs',
  'notifications',
  'outbox',
  'prejoin_jobs',
  'prejoin_memberships',
  'push_evaluations',
  'receipt_dag_edges',
  'receipt_dag_nodes',
  'receipt_membership_events',
  'receipts',
  'redactions',
  'relations',
  'rooms',
  'search',
  'visibility',
];
// Reports retain operator history; join attempts retain compensating remote
// leave obligations. Push delivery retains its terminal ledger; pending work is
// cancelled by the notification owner, not erased with the room projection.
// Membership protocol receipts retain exact authenticated retry responses after
// removal; disposable sender attempts/jobs are cleared with the room instead.
// Notification retirement markers keep late facts from rebuilding a dropped
// projection or blocking unrelated history after the room file is gone.
const retained = [
  'federation_join_attempts',
  'membership_operations',
  'notification_retired_rooms',
  'push_delivery',
  'reports',
];

Deno.test('operator unlink clears every registered per-room server table', async () => {
  setConfigForTests({ server: { name: 'test' } });
  const http = await startHttp();
  try {
    const app = http.app;
    const signer = app.tenant.signer();
    const gone = await genesis(app.store, { roomId: '!gone:test', signer });
    const kept = await genesis(app.store, { roomId: '!kept:test', signer });
    const tables = new Map<
      string,
      { name: string; type: string; notnull: number; dflt_value: unknown }[]
    >();
    for (
      const row of await app.server.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'",
      )
    ) {
      const name = String(row.name);
      const columns = await app.server.query(`PRAGMA table_info("${name}")`);
      if (columns.some((c) => c.name === 'room' || c.name === 'room_id')) {
        tables.set(
          name,
          columns.map((c) => ({
            name: String(c.name),
            type: String(c.type),
            notnull: Number(c.notnull),
            dflt_value: c.dflt_value,
          })),
        );
      }
    }
    assertEquals(
      [...tables.keys()].sort(),
      [...cleared, ...retained].sort(),
      'every per-room table needs an explicit unlink disposition',
    );
    await app.server.tx(async (tx) => {
      for (const [table, columns] of tables) {
        const key = columns.find((c) =>
          c.name === 'room' || c.name === 'room_id'
        )!.name;
        for (const [i, g] of [gone, kept].entries()) {
          // Seed even owners not exercised by genesis. Values obey the schema;
          // the test checks retirement, not admission of synthetic domain facts.
          // Let the schema initialize defaulted columns, including constrained
          // flags; type-based synthetic values need not satisfy their CHECKs.
          const seeded = columns.filter((c) =>
            c.name === key || c.dflt_value === null
          );
          const values = seeded.map((c) => {
            if (c.name === key) return g.roomId;
            if (c.name === 'kind') {
              return table === 'reports' ? 'room' : 'invite';
            }
            if (c.name === 'state') return 'sent';
            if (c.name === 'status') return 'pending';
            if (c.name === 'membership') return 'join';
            if (c.name === 'user' || c.name === 'user_id') return g.creator;
            if (c.type === 'INTEGER') return i + 9000;
            return `${table}-${c.name}-${i}`;
          });
          // Counts have relational CHECK constraints; equal values satisfy them.
          await tx.execute(
            `INSERT OR IGNORE INTO "${table}" (${
              seeded.map((c) => `"${c.name}"`).join(',')
            }) VALUES(${values.map(() => '?').join(',')})`,
            values,
          );
          assertEquals(
            (await tx.query(`SELECT 1 FROM "${table}" WHERE "${key}"=?`, [
              g.roomId,
            ])).length > 0,
            true,
            table + ' fixture populated',
          );
        }
      }
    });
    const before = new Map<string, unknown>();
    for (const [table, columns] of tables) {
      const key = columns.find((c) =>
        c.name === 'room' || c.name === 'room_id'
      )!.name;
      before.set(
        table,
        await app.server.query(`SELECT * FROM "${table}" WHERE "${key}"=?`, [
          kept.roomId,
        ]),
      );
    }
    await dropOperatorRoom(app, gone.roomId);
    await assertRejects(
      () => app.store.room(gone.roomId),
      Deno.errors.NotFound,
    );
    for (const [table, columns] of tables) {
      const key = columns.find((c) =>
        c.name === 'room' || c.name === 'room_id'
      )!.name;
      const rows = await app.server.query(
        `SELECT * FROM "${table}" WHERE "${key}"=?`,
        [gone.roomId],
      );
      assertEquals(
        rows.length,
        cleared.includes(table) ? 0 : 1,
        table + ' unlink disposition',
      );
      assertEquals(
        await app.server.query(`SELECT * FROM "${table}" WHERE "${key}"=?`, [
          kept.roomId,
        ]),
        before.get(table),
        table + ' unrelated room preserved',
      );
    }
  } finally {
    await http.close();
    setConfigForTests({});
  }
});
