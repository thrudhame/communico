// PUT /_matrix/federation/v1/send/{txnId} — inbound transactions (§3.3):
// PDUs through the ingest pipeline (per-PDU outcomes), then EDUs. Auth:
// the folder's 20-auth.ts (the origin is on context.state).
import { handleTransaction } from '#engine/federation/transactions.ts';
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (
  request: PathfinderRequest,
  context: Context,
) {
  assertFederationEnabled();
  const origin = context.state.origin as string | undefined;
  if (origin === undefined) {
    throw new MatrixError(
      401,
      'M_UNAUTHORIZED',
      'missing or invalid signature',
    );
  }
  const body = await request.body.json().catch(() => {
    throw new MatrixError(400, 'M_BAD_JSON', 'transaction body must be JSON');
  });
  const result = await handleTransaction(
    origin,
    request.params.txnId as string,
    body,
  );
  return result.body;
}
