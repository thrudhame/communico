import { timestampToEvent } from '#engine/client/timestamp.ts';
import { parseTimestampQuery } from '#engine/room/timestamp.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest, context: Context) {
  return await timestampToEvent(
    context.state.user as string,
    request.params.roomId as string,
    parseTimestampQuery(request.query),
  );
}
