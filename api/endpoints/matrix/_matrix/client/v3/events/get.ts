import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { peekNumber, roomEvents } from '#engine/client/peeking.ts';
import { config } from '#engine/config.ts';
export default async function (request: PathfinderRequest, context: Context) {
  return await roomEvents(
    request.query.get('room_id') ?? '',
    context.state.user as string,
    (context.state.device as string | undefined) ?? null,
    request.query.get('from'),
    peekNumber(request.query.get('timeout'), 0, config().peeking.maxtimeoutms),
    request._raw.signal,
  );
}
