import { serveBackfill } from '#engine/federation/serve.ts';
import { backfillRequest } from '#engine/federation/history-request.ts';
import { serveDeps } from '#engine/federation/context.ts';
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
  const { v, limit } = backfillRequest(request.query);
  return await serveBackfill(
    request.params.roomId as string,
    v,
    limit,
    origin,
    serveDeps(),
  );
}
