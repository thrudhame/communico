// api/engine/tenant/pushers.ts — pusher rows. This commit lands only the
// delete cascades token/device revocation needs; the pusher API
// (setPusher/listPushers) arrives with the account-data stage.
import type { Conn } from '#engine/store/db.ts';

export async function deletePushersForToken(
  conn: Conn,
  accessHash: string,
): Promise<void> {
  await conn.execute('DELETE FROM pushers WHERE access_token = ?', [
    accessHash,
  ]);
}

export async function deletePushersOfUser(
  conn: Conn,
  localpart: string,
): Promise<void> {
  await conn.execute('DELETE FROM pushers WHERE localpart = ?', [localpart]);
}
