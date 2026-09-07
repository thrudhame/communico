// Provisions the server DB (plain tables in the default postgres
// database) from db/server/schema.sql, then ensures the persistent
// server signing keypair (generated ONCE, reused on every subsequent
// init — never rotates; repeated inits are Complement's contract).
import { SERVER_DB, withDb } from '../api/engine/db.ts';
import { runSqlFile } from '../api/engine/room.ts';
import { ensureServerKey } from '../api/engine/signing.ts';

await withDb(SERVER_DB, async (c) => {
  await runSqlFile(c, 'db/server/schema.sql');
});
const key = await ensureServerKey();
console.log(`server DB '${SERVER_DB}' provisioned from db/server/schema.sql`);
console.log(
  `server signing key: ed25519:${key.keyId} for ${key.serverName} (pub ${key.publicB64.slice(0, 12)}…)`,
);
