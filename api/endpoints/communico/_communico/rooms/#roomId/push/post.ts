import { pushRoom } from '../../../../../../engine/sync.ts';

export default async function (request: import('@pathfinder/pathfinder').PathfinderRequest) {
  await pushRoom(request.params.roomId as string);
  return { ok: true };
}
