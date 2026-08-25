// W0B-NODE — the clone-test logic under deno/node (phase-sanctioned
// fallback): proves the amalgamation-lineage remote client works when the
// runtime offers real TCP (the browser's WebSocket-wrapped sockets cannot
// reach a plain HTTPS host — recorded verbatim in the W0 log).
import SQLiteESMFactory from './vendor/doltlite.mjs';
import * as SQLite from 'wa-sqlite';

const module_ = await SQLiteESMFactory();
module_._sqlite3_initialize();
const sqlite3 = SQLite.Factory(module_);
const db = await sqlite3.open_v2('remote-prod-test.doltlite');
console.log('module up; cloning https://dolthub.com/dolthub/remote-prod-test …');
const t0 = performance.now();
try {
  await sqlite3.exec(
    db,
    "SELECT dolt_clone('https://dolthub.com/dolthub/remote-prod-test')",
    (row, columns) => console.log(`${columns.join('|')} = ${row.join('|')}`),
  );
} catch (e) {
  console.log(`W0B-NODE: FAIL ${e.message}`);
  throw e;
}
const ms = Math.round(performance.now() - t0);
let n = 0;
await sqlite3.exec(db, 'SELECT message FROM dolt_log', (row) => { console.log('  log:', row[0]); n++; });
console.log(`W0B-NODE: PASS (${n} log rows, clone in ${ms} ms)`);
await sqlite3.close(db);
