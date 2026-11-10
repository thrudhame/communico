import { joinByIdOrAlias, knock } from '#engine/client/membership.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
export default async function (request: PathfinderRequest, context: Context) {
  const body = await parseJson(request) as Record<string, unknown>;
  if (
    body === null || typeof body !== 'object' || Array.isArray(body) ||
    (body.reason !== undefined && typeof body.reason !== 'string')
  ) {
    throw new MatrixError(400, 'M_BAD_JSON', 'invalid knock content');
  }
  const via = request.query.getAll('via');
  const result = await joinByIdOrAlias(
    request.params.roomIdOrAlias as string,
    context.state.user as string,
    body,
    via.length ? via : request.query.getAll('server_name'),
    knock,
  );
  return { room_id: result.roomId };
}
