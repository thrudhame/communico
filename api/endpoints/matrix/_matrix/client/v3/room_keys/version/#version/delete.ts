import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { backupVersion } from '#engine/client/key-backup.ts';

export default async function (request: PathfinderRequest, context: Context) {
  return await backupVersion(
    context.state.user as string,
    'delete',
    request.params.version as string,
  );
}
