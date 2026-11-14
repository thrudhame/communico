import { receiveTransaction } from '#engine/federation/transactions.ts';
import { transactionDeps } from '#engine/federation/context.ts';
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { parseJson } from '#engine/operation-body.ts';
import { theApp } from '#engine/app.ts';
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
  const app = theApp();
  const ingress = app.federationIngress;
  if (ingress) {
    return (await ingress.receive(origin, request.params.txnId as string)).body;
  }
  if (app.replica) {
    throw new MatrixError(503, 'M_UNAVAILABLE', 'durable ingress unavailable');
  }
  const body = await parseJson(request);
  const result = await receiveTransaction(
    origin,
    request.params.txnId as string,
    body,
    transactionDeps(),
  );
  return result.body;
}
