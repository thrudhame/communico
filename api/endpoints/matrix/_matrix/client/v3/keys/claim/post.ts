import { parseJson } from '@pathfinder/pathfinder/body';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { claimKeys } from '#engine/client/e2ee.ts';
export default async function (request: PathfinderRequest, context: Context) {
  return await claimKeys(context.state.user!, await parseJson(request));
}
