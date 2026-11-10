import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { changeTag } from '#engine/client/tags.ts';
export default function (request: PathfinderRequest, context: Context) {
  return changeTag(
    context.state.user as string,
    request.params.userId as string,
    request.params.roomId as string,
    request.params.tag as string,
  );
}
