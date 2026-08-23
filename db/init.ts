// Provisions the server DB (plain tables in the default postgres
// database) from db/server/schema.sql.
import { SERVER_DB, withDb } from '../api/engine/db.ts';
import { runSqlFile } from '../api/engine/room.ts';

await withDb(SERVER_DB, async (c) => {
  await runSqlFile(c, 'db/server/schema.sql');
});
console.log(`server DB '${SERVER_DB}' provisioned from db/server/schema.sql`);
