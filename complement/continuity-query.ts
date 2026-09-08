// complement/continuity-query.ts — print this tenant's pubkey (b64).
// Piped into the container: docker exec -i ... deno run - < file
// (stdin piping avoids every shell-quoting trap).
import pgpkg from 'pg';
import { tenantDbName } from '../api/engine/tenant.ts';
import { SERVER_NAME } from '../api/engine/config.ts';

const db = await tenantDbName(SERVER_NAME);
const c = new pgpkg.Client({
  host: '127.0.0.1',
  port: 5432,
  user: 'root',
  password: 'secret',
  database: db,
});
await c.connect();
const r = await c.query('SELECT pubkey_b64 FROM tenant;');
console.log(String(r.rows[0].pubkey_b64));
await c.end();
