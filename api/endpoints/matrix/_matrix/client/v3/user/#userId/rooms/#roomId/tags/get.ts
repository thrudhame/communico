import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { tags } from '#engine/client/tags.ts';
export default function (request: PathfinderRequest, context: Context) {
  return tags(
    context.state.user as string,
    request.params.userId as string,
    request.params.roomId as string,
  );
}
