import { authorize } from '#engine/auth-context.ts';
import { createAlias } from '#engine/client/directory.ts';
import { parseJson } from '#engine/operation-body.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  const user = await authorize(request),
    body = await parseJson(request) as Record<string, unknown>;
  if (typeof body.room_id !== 'string') {
    return Response.json({
      errcode: 'M_INVALID_PARAM',
      error: 'room_id is required',
    }, { status: 400 });
  }
  await createAlias(request.params.roomAlias as string, body.room_id, user);
  return {};
}
