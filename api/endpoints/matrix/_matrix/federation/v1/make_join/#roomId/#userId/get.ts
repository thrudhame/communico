// GET /_matrix/federation/v1/make_join/{roomId}/{userId}?ver= — the join
// template (joins-v1.yaml:20-225; SS:866-885). Auth: the folder's
// 20-auth.ts.
import { makeJoin } from '#engine/federation/joins.ts';
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
  const ver = request.query.getAll('ver');
  return await makeJoin(
    request.params.roomId as string,
    request.params.userId as string,
    origin,
    ver.length === 0 ? ['1'] : ver,
  );
}
