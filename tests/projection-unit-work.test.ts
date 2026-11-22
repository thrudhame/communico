import { assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { project, withProjectionLock } from '#engine/server/project.ts';
import { bobJoins, genesis } from '#tests/fixtures/genesis.ts';

Deno.test('publication unit: contended turns publish complete acceptance and reconcile once without starving rooms', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 16,
    idleseconds: 300,
  }, {
    schemas: { room: roomSchema, server: serverSchema, tenant: tenantSchema },
  });
  const waiting: Promise<void>[] = [];
  try {
    // The signed-control activation has its own owner tests. Start this work
    // probe at that committed boundary so both reconciliation sweeps do work.
    await (await store.server()).execute(
      "INSERT INTO facade_owner_activation VALUES('publication-unit-test',1,'verified-test')",
    );
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('dev', 'Dev');
      await tx.users.insert('bob', 'Bob');
    });
    const rooms: {
      g: Awaited<ReturnType<typeof genesis>>;
      events: Awaited<ReturnType<typeof sendLocal>>[];
      baseline: number;
    }[] = [];
    for (let n = 0; n < 3; n++) {
      const g = await genesis(store, { roomId: `!publication-unit-${n}:test` });
      await bobJoins(g);
      await bobJoins(g, '@foreign:remote');
      await project(store, g.roomId);
      const baseline = await g.room.tx((tx) => tx.changes.head());
      const events = [];
      for (let index = 0; index < 8; index++) {
        events.push(
          await sendLocal(g.room, {
            type: 'm.room.message',
            sender: g.creator,
            content: { body: `unit ${n}/${index}`, msgtype: 'm.text' },
          }, g.signer),
        );
      }
      rooms.push({ g, events, baseline });
    }
    const cuts = new Map(rooms.map(({ g, events }) => [
      'room:' + g.roomId,
      new Set(events.map((event) => event.completion!.through)),
    ]));
    const server = await store.server();
    const originalTx = server.tx.bind(server);
    const originalQuery = server.query.bind(server);
    const originalTenant = store.tenant.bind(store);
    const turns: { room: string; through: number }[] = [];
    const observations: { room: string; through: number }[] = [];
    let baselineReads = 0,
      validationReads = 0,
      receiptReconciliations = 0,
      eventApplies = 0;
    let policySnapshots = 0,
      tenantTransactions = 0,
      publicationTransactions = 0,
      notificationReconciliations = 0;
    store.tenant = async (...args) => {
      const db = await originalTenant(...args);
      return {
        ...db,
        tx: (fn, options) => {
          tenantTransactions++;
          // Demand arrives while capturing policy, before the turn chooses its
          // complete input prefix. No unused policy may be repeatedly prepared.
          waiting.push(withProjectionLock(async () => {
            for (const { g, baseline } of rooms) {
              const source = 'room:' + g.roomId;
              const [mark] = await originalQuery(
                'SELECT position FROM watermarks WHERE source=?',
                [source],
              );
              const through = Number(mark?.position ?? 0);
              if (through > baseline) {
                observations.push({ room: source, through });
              }
            }
          }));
          return db.tx((conn) => {
            const query = conn.query.bind(conn);
            let policy = false;
            conn.query = (sql, values) => {
              if (
                !policy &&
                // Account admission identifies the policy attempt for scalar
                // and selected-set readers, independent of their SQL shape.
                /\b(?:FROM|JOIN)\s+users\b/i.test(sql)
              ) {
                policy = true;
                policySnapshots++;
              }
              return query(sql, values);
            };
            return fn(conn);
          }, options);
        },
      };
    };
    server.query = (sql, values) => {
      if (sql === 'SELECT position FROM watermarks WHERE source = ?') {
        baselineReads++;
      }
      if (sql.includes('json_each(?)') && sql.includes('JOIN watermarks')) {
        validationReads++;
      }
      return originalQuery(sql, values);
    };
    server.tx = (fn, options) =>
      originalTx(async (conn) => {
        const previousTurns = turns.length;
        const execute = conn.execute.bind(conn), query = conn.query.bind(conn);
        conn.query = (sql, values) => {
          if (
            sql ===
              'SELECT user_id,receipt_type,thread_id,event_ids FROM receipts WHERE room_id=?'
          ) receiptReconciliations++;
          if (
            sql ===
              'SELECT DISTINCT user FROM notification_graph_reads WHERE room=?'
          ) notificationReconciliations++;
          return query(sql, values);
        };
        conn.execute = async (sql, values = []) => {
          if (sql.startsWith('INSERT INTO event_index(')) eventApplies++;
          const result = await execute(sql, values);
          if (
            sql.startsWith('INSERT INTO watermarks VALUES') &&
            cuts.has(String(values[0]))
          ) {
            turns.push({ room: String(values[0]), through: Number(values[1]) });
          }
          return result;
        };
        const value = await fn(conn);
        if (turns.length > previousTurns) publicationTransactions++;
        return value;
      }, options);
    const started = performance.now();
    try {
      await Promise.all(rooms.map(({ g }) => project(store, g.roomId)));
      await Promise.all(waiting);
    } finally {
      server.tx = originalTx;
      server.query = originalQuery;
      store.tenant = originalTenant;
    }
    const elapsedMs = performance.now() - started;
    console.log(
      JSON.stringify({
        events: 24,
        turns: turns.length,
        turns_per_event: turns.length / 24,
        baseline_reads: baselineReads,
        validation_reads: validationReads,
        receipt_reconciliations: receiptReconciliations,
        notification_reconciliations: notificationReconciliations,
        tenant_policy_snapshots: policySnapshots,
        tenant_transactions: tenantTransactions,
        event_applies: eventApplies,
        elapsed_ms: elapsedMs,
        published_events_per_second: 24000 / elapsedMs,
        turns_by_room: turns,
      }),
    );
    assertEquals(
      turns.every((turn) => cuts.get(turn.room)!.has(turn.through)),
      true,
      'a contended writer exposed only part of a durable acceptance unit',
    );
    assertEquals(
      observations.every((turn) => cuts.get(turn.room)!.has(turn.through)),
      true,
      'an independent writer observed a half-published acceptance',
    );
    assertEquals(
      turns.length,
      24,
      'contention must cost one turn per accepted event, not per raw change',
    );
    assertEquals(receiptReconciliations, turns.length);
    assertEquals(notificationReconciliations, turns.length);
    assertEquals(
      policySnapshots,
      publicationTransactions,
      'each committed ready-room group owns exactly one fresh tenant policy snapshot',
    );
    assertEquals(baselineReads, rooms.length * 4);
    assertEquals(validationReads, turns.length);
    assertEquals(eventApplies, 24);
    for (const { g, events } of rooms) {
      const source = 'room:' + g.roomId;
      const last = turns.findIndex((turn) =>
        turn.room === source &&
        turn.through === events.at(-1)!.completion!.through
      );
      assertEquals(
        rooms.every(({ g: other }) =>
          turns.slice(0, last + 1).some((turn) =>
            turn.room === 'room:' + other.roomId
          )
        ),
        true,
        'one room drained its backlog before another room received any writer turn',
      );
      assertEquals(
        (await server.query(
          'SELECT event FROM feed WHERE room=? ORDER BY seq',
          [g.roomId],
        ))
          .filter((row) => events.some((event) => event.eventId === row.event))
          .map((row) => row.event),
        events.map((event) => event.eventId),
      );
    }
  } finally {
    await Promise.allSettled(waiting);
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
