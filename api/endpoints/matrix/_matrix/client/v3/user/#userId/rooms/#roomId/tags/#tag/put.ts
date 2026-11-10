import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { parseJson } from '@pathfinder/pathfinder/body';
import { changeTag } from '#engine/client/tags.ts';
export default async function (request: PathfinderRequest, context: Context) {
  return await changeTag(
    context.state.user as string,
    request.params.userId as string,
    request.params.roomId as string,
    request.params.tag as string,
    await parseJson(request),
  );
}
