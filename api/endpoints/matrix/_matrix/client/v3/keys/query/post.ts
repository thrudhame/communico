import { parseJson } from '@pathfinder/pathfinder/body';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { queryKeys } from '#engine/client/e2ee.ts';
export default async function (request: PathfinderRequest, context: Context) {
  return await queryKeys(context.state.user!, await parseJson(request));
}
