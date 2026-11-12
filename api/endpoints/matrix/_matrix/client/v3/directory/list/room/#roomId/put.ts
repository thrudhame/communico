import { authorize } from '#engine/auth-context.ts';
import { setVisibility } from '#engine/client/directory.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
import { decodeVisibility } from '#engine/client/directory-request.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  const user = await authorize(request),
    visibility = decodeVisibility(await parseJson(request));
  await setVisibility(
    request.params.roomId as string,
    user,
    visibility,
  );
  return {};
}
