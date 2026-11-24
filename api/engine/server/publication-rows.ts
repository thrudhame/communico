// Set-valued SQL inputs for publication owners. Identifiers and conflict clauses
// are module-owned SQL, never data; all fact values stay bound in one JSON input.
import type { Conn } from '#engine/store/db.ts';
import type { Value } from '#engine/store/ffi.ts';

/** JSON scalars have no declared affinity. Cast at the input boundary so the
 * native planner can probe TEXT identity indexes instead of scanning facts. */
export async function hasPublicationEvents(
  tx: Conn,
  events: readonly string[],
): Promise<boolean> {
  return (await tx.query(
    'SELECT 1 FROM json_each(?) j JOIN event_index i ON i.event=CAST(j.value AS TEXT) LIMIT 1',
    [JSON.stringify(events)],
  )).length > 0;
}

export async function insertPublicationRows(
  tx: Conn,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly Value[])[],
  conflict = 'ON CONFLICT DO NOTHING',
): Promise<void> {
  if (!rows.length) return;
  await tx.execute(
    `INSERT INTO ${table}(${columns.join(',')}) SELECT ${
      columns.map((_, at) => `json_extract(value,'$[${at}]')`).join(',')
    } FROM json_each(?) WHERE 1 ${conflict}`,
    [JSON.stringify(rows)],
  );
}

export async function reservePublicationCounter(
  tx: Conn,
  name: string,
  count: number,
): Promise<number> {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new TypeError('publication counter count must be a positive integer');
  }
  const [row] = await tx.query(
    'INSERT INTO counters(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=counters.value+excluded.value RETURNING value',
    [name, count],
  );
  return Number(row.value) - count + 1;
}
