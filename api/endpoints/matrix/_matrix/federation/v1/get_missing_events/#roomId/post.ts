import { serveGetMissingEvents } from '#engine/federation/serve.ts';
import { parseJson } from '#engine/operation-body.ts';
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
  const body = await parseJson(request);
  return await serveGetMissingEvents(
    request.params.roomId as string,
    body as Record<string, unknown>,
    origin,
    serveDeps(),
  );
}
