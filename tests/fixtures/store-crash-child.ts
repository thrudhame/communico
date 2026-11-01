// tests/fixtures/store-crash-child.ts — the kill target. Reports every
// committed row and every checkpoint window on stdout; the parent kills it.
import { openStore } from '#engine/store/index.ts';

const [dir, library] = Deno.args;
const store = await openStore({
  dir,
  library,
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});
const lease = await store.leaseRoom('!crash:test', { create: true });
const db = lease.db;
await db.exec(
  'CREATE TABLE IF NOT EXISTS rows(id INTEGER PRIMARY KEY, body TEXT)',
);
lease.events.addEventListener('checkpoint', () => {
  console.log(JSON.stringify({ barrier: 'start' }));
});
lease.events.addEventListener('checkpointend', () => {
  console.log(JSON.stringify({ barrier: 'end' }));
});
const body = 'crash-row-'.repeat(16);
for (;;) {
  const inserted = await db.tx((tx) =>
    tx.query('INSERT INTO rows(body) VALUES(?) RETURNING id', [body])
  );
  console.log(JSON.stringify({ row: inserted[0].id }));
}
