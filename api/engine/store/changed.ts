// Static SQL fragments only, never request values. Domain owners choose the
// actual mutation fields; NULL is a value, not an unknown comparison result.
export function changedColumns(
  table: string,
  ...columns: [string, ...string[]]
): string {
  return '(' +
    columns.map((column) => `${table}.${column} IS NOT excluded.${column}`)
      .join(' OR ') +
    ')';
}
