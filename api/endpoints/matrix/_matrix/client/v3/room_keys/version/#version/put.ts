import { parseJson } from '@pathfinder/pathfinder/body';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { backupVersion } from '#engine/client/key-backup.ts';

export default async function (request: PathfinderRequest, context: Context) {
  return await backupVersion(
    context.state.user as string,
    'put',
    request.params.version as string,
    await parseJson(request),
  );
}
