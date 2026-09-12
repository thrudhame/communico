import { pullRoom } from '#engine/sync.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

export default async function (request: import('@pathfinder/pathfinder').PathfinderRequest) {
  const body = (await parseJson(request)) as { remote_url?: string };
  const n = await pullRoom(request.params.roomId as string, body.remote_url ?? '', true);
  return { new_commits: n };
}
