// Durable EDU work and frozen mixed envelopes are server-owned delivery truth.
import type { Conn, Database } from '#engine/store/db.ts';
import type { OutboxDueRow } from '#engine/server/read.ts';

export type ReliableEdu = {
  source: string;
  edu_type: string;
  content: Record<string, unknown>;
};
export type FrozenBatch = {
  txnId: string;
  body: string;
  rows: OutboxDueRow[];
  sources: string[];
};

export async function enqueueEdu(
  tx: Conn,
  source: string,
  destination: string,
  type: string,
  content: Record<string, unknown>,
): Promise<void> {
  if (
    (await tx.query(
      'SELECT 1 FROM edu_outbox WHERE source=? AND destination=?',
      [source, destination],
    )).length
  ) return;
  await tx.execute(
    "UPDATE counters SET value=value+1 WHERE name='reliable-edus'",
  );
  const position = (await tx.query(
    "SELECT value FROM counters WHERE name='reliable-edus'",
  ))[0].value;
  await tx.execute(
    "INSERT INTO edu_outbox(source,destination,edu_type,payload,state,enqueue_pos) VALUES(?,?,?,?,'pending',?)",
    [source, destination, type, JSON.stringify(content), position],
  );
}

export async function pendingEdus(
  server: Database,
  destination: string,
  limit: number,
): Promise<ReliableEdu[]> {
  return (await server.query(
    "SELECT source,edu_type,payload FROM edu_outbox WHERE destination=? AND state='pending' ORDER BY enqueue_pos LIMIT ?",
    [destination, limit],
  )).map((row) => ({
    source: String(row.source),
    edu_type: String(row.edu_type),
    content: JSON.parse(String(row.payload)),
  }));
}

async function current(
  tx: Conn,
  destination: string,
  batch: FrozenBatch,
): Promise<boolean> {
  for (const row of batch.rows) {
    if (
      !(await tx.query(
        "SELECT 1 FROM outbox WHERE room=? AND pos=? AND destination=? AND state='pending' AND added_ms=?",
        [row.room, row.pos, destination, row.addedMs],
      )).length
    ) return false;
  }
  for (const source of batch.sources) {
    if (
      !(await tx.query(
        "SELECT 1 FROM edu_outbox WHERE source=? AND destination=? AND state='pending'",
        [source, destination],
      )).length
    ) return false;
  }
  return true;
}

export async function frozenBatch(
  server: Database,
  destination: string,
): Promise<FrozenBatch | null> {
  return await server.tx(async (tx) => {
    const row =
      (await tx.query('SELECT * FROM federation_batches WHERE destination=?', [
        destination,
      ]))[0];
    if (!row) return null;
    const batch: FrozenBatch = {
      txnId: String(row.txn_id),
      body: String(row.body),
      rows: JSON.parse(String(row.pdu_rows)),
      sources: JSON.parse(String(row.edu_sources)),
    };
    if (await current(tx, destination, batch)) return batch;
    // Expiry/prune/retry can retire PDU work. Re-form a new envelope with a
    // fresh id, leaving accepted reliable EDUs pending rather than expiring them.
    await tx.execute('DELETE FROM federation_batches WHERE destination=?', [
      destination,
    ]);
    return null;
  });
}

export async function freezeBatch(
  server: Database,
  destination: string,
  batch: FrozenBatch,
): Promise<boolean> {
  return await server.tx(async (tx) => {
    if (!await current(tx, destination, batch)) return false;
    await tx.execute('INSERT INTO federation_batches VALUES(?,?,?,?,?)', [
      destination,
      batch.txnId,
      batch.body,
      JSON.stringify(batch.rows),
      JSON.stringify(batch.sources),
    ]);
    await tx.execute(
      'INSERT INTO counters VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=value+1',
      ['delivery-turn:' + destination],
    );
    return true;
  });
}

export async function deliveryTurn(
  server: Database,
  destination: string,
): Promise<number> {
  const row = (await server.query('SELECT value FROM counters WHERE name=?', [
    'delivery-turn:' + destination,
  ]))[0];
  return Number(row?.value ?? 0);
}

export async function completeBatch(
  tx: Conn,
  destination: string,
  batch: FrozenBatch,
): Promise<void> {
  for (const row of batch.rows) {
    await tx.execute(
      "UPDATE outbox SET state='sent' WHERE room=? AND pos=? AND destination=?",
      [row.room, row.pos, destination],
    );
  }
  for (const source of batch.sources) {
    const edu = (await tx.query(
      "SELECT payload FROM edu_outbox WHERE source=? AND destination=? AND edu_type='m.device_list_update'",
      [source, destination],
    ))[0];
    if (edu) {
      const content = JSON.parse(String(edu.payload));
      await tx.execute(
        'UPDATE device_subscriptions SET sent_stream=? WHERE subject=? AND destination=? AND (sent_stream IS NULL OR sent_stream<?)',
        [content.stream_id, content.user_id, destination, content.stream_id],
      );
      // Publication epochs/tenant watermarks already own replay prevention.
      // This server-owned work needs no cross-file completion marker.
      await tx.execute(
        'DELETE FROM edu_outbox WHERE source=? AND destination=?',
        [source, destination],
      );
      continue;
    }
    await tx.execute(
      "UPDATE edu_outbox SET state='sent' WHERE source=? AND destination=?",
      [source, destination],
    );
  }
  await tx.execute(
    'DELETE FROM federation_batches WHERE destination=? AND txn_id=?',
    [destination, batch.txnId],
  );
}
