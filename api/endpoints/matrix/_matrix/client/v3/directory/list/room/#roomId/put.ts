import { authorize } from '#engine/auth-context.ts';
import { setVisibility } from '#engine/client/directory.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  const user = await authorize(request),
    body = await parseJson(request) as Record<string, unknown>;
  await setVisibility(
    request.params.roomId as string,
    user,
    body.visibility as string,
  );
  return {};
}
