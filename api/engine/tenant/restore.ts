import type { Conn } from '#engine/store/db.ts';
import { purgeRestoredKeyPools } from './e2ee.ts';
import { forgetRestoredDeliveries } from './todevice.ts';
import { resetRestoredPositions } from './sliding-sync.ts';

// Called only inside a private candidate's owning tenant transaction.
export async function sanitizeRestoredTenant(conn: Conn) {
  const pools = await purgeRestoredKeyPools(conn);
  const inboxReceipts = await forgetRestoredDeliveries(conn);
  const sliding = await resetRestoredPositions(conn);
  return { ...pools, inboxReceipts, ...sliding };
}
