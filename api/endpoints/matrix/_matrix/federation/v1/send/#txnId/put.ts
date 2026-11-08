import { receiveTransaction } from '#engine/federation/transactions.ts';
import { transactionDeps } from '#engine/federation/context.ts';
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
  const result = await receiveTransaction(
    origin,
    request.params.txnId as string,
    body,
    transactionDeps(),
  );
  return result.body;
}
