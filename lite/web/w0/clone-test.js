// W0b — port of doltlite's examples/wa-sqlite-clone.mjs against the
// W0a-vendored artifact. Clone the public test remote, dump dolt_log.
const out = document.querySelector('#results');
const line = (s) => { out.textContent += s + '\n'; };
addEventListener('error', (e) => line(`PAGE ERROR: ${e.message}`));
addEventListener('unhandledrejection', (e) => line(`PAGE REJECTION: ${e.reason?.message ?? e.reason}`));

try {
  const { default: SQLiteESMFactory } = await import('./vendor/doltlite.mjs');
  const SQLite = await import('../node_modules/wa-sqlite/src/sqlite-api.js');
  const module = await SQLiteESMFactory();
  module._sqlite3_initialize();
  const sqlite3 = SQLite.Factory(module);
  const db = await sqlite3.open_v2('remote-prod-test.doltlite');
  line('module up; cloning https://dolthub.com/dolthub/remote-prod-test …');
  const t0 = performance.now();
  await sqlite3.exec(
    db,
    "SELECT dolt_clone('https://dolthub.com/dolthub/remote-prod-test')",
    (row, columns) => line(`${columns.join('|')} = ${row.join('|')}`),
  );
  const ms = Math.round(performance.now() - t0);
  let n = 0;
  await sqlite3.exec(db, 'SELECT * FROM dolt_log', (row, columns) => { line(`${columns.join(' | ')}\n  ${row.join(' | ')}`); n++; });
  line(`W0B: PASS (${n} log rows, clone in ${ms} ms)`);
} catch (e) {
  line(`W0B: FAIL ${e.message}`);
}
