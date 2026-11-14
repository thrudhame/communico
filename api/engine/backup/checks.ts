// Shared assertions for domain-owned audits. Never include stored rows, key
// material or SQL parameter values in the operator-facing failure message.
import type { CapturedQuery } from '#engine/store/inspect.ts';
import type { Row, Value } from '#engine/store/ffi.ts';

// Keyset batches bound working memory, never the number of audited rows. All
// query fragments are domain-owned constants, never manifest/operator input.
export async function* scan(
  db: CapturedQuery,
  table: string,
  columns: string,
  where = '1',
  values: readonly Value[] = [],
): AsyncGenerator<Row> {
  let cursor: number | undefined;
  for (;;) {
    const rows = await db.query(
      `SELECT rowid AS audit_rowid,${columns} FROM ${table} WHERE (${where})` +
        (cursor === undefined ? '' : ' AND rowid>?') +
        ' ORDER BY rowid LIMIT 256',
      cursor === undefined ? values : [...values, cursor],
    );
    if (!rows.length) return;
    for (const row of rows) yield row;
    cursor = Number(rows.at(-1)!.audit_rowid);
  }
}

export function auditFailure(what: string): never {
  throw new Error('backup audit: ' + what);
}

/** Collect selected metadata only, in keyset pages without a row-count ceiling. */
export async function inventoryRows(
  db: CapturedQuery,
  table: string,
  columns: string,
  where = '1',
  values: readonly Value[] = [],
): Promise<Row[]> {
  const rows: Row[] = [];
  for await (
    const { audit_rowid: _rowid, ...row } of scan(
      db,
      table,
      columns,
      where,
      values,
    )
  ) rows.push(row);
  return rows;
}

export function nonnegative(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    auditFailure(what);
  }
  return value;
}

export async function absent(
  db: CapturedQuery,
  sql: string,
  what: string,
): Promise<void> {
  if ((await db.query(sql)).length) auditFailure(what);
}

export async function counters(
  db: CapturedQuery,
): Promise<Record<string, number>> {
  return Object.fromEntries(
    (await db.query('SELECT name,value FROM counters')).map((
      r,
    ) => [String(r.name), nonnegative(r.value, 'invalid counter')]),
  );
}

export async function counterCeiling(
  db: CapturedQuery,
  heads: Record<string, number>,
  name: string,
  table: string,
  column: string,
): Promise<void> {
  const [{ hi }] = await db.query(
    `SELECT COALESCE(MAX(${column}),0) AS hi FROM ${table}`,
  );
  if (nonnegative(hi, 'invalid stream head') > (heads[name] ?? 0)) {
    auditFailure('counter behind ' + table);
  }
}
