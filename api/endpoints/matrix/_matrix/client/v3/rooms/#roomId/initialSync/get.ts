import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { peekNumber, roomInitialSync } from '#engine/client/peeking.ts';
import { config } from '#engine/config.ts';
export default async function (request: PathfinderRequest, context: Context) {
  return await roomInitialSync(
    request.params.roomId as string,
    context.state.user as string,
    context.state.device as string | null,
    peekNumber(
      request.query.get('limit'),
      config().peeking.maxevents,
      config().peeking.maxevents,
    ),
  );
}
