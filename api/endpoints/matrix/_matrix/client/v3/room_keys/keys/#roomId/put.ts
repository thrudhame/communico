import { parseJson } from '#engine/operation-body.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { backupKeys } from '#engine/client/key-backup.ts';

export default async function (request: PathfinderRequest, context: Context) {
  return await backupKeys(
    context.state.user as string,
    'put',
    request.query.get('version'),
    request.params.roomId as string,
    undefined,
    await parseJson(request),
  );
}
