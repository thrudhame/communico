import { parseJson } from '@pathfinder/pathfinder/body';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { uploadKeys } from '#engine/client/e2ee.ts';
export default async function (request: PathfinderRequest, context: Context) {
  return await uploadKeys(
    context.state.user!,
    context.state.device,
    context.state.deviceGeneration,
    await parseJson(request),
  );
}
