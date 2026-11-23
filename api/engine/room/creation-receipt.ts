// A matching create event proves room identity, not a whole creation request.
// Keep the workflow identity in local room metadata, in the same initialization
// transaction as every initial event. It is not federation-visible state.
import type { Conn } from '#engine/store/db.ts';

const key = 'local_creation_plan';

export async function requireCreationReceipt(conn: Conn, identity: string) {
  const [row] = await conn.query('SELECT v FROM meta WHERE k=?', [key]);
  if (row?.v !== identity) {
    throw new Error('E_CREATE_ROOM_IDENTITY: initialization request differs');
  }
}

export async function recordCreationReceipt(conn: Conn, identity: string) {
  await conn.execute('INSERT INTO meta(k,v) VALUES(?,?)', [key, identity]);
}
