import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { backupKeys } from '#engine/client/key-backup.ts';

export default async function (request: PathfinderRequest, context: Context) {
  return await backupKeys(
    context.state.user as string,
    'get',
    request.query.get('version'),
    request.params.roomId as string,
  );
}
