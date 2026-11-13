import { parseJson } from '#engine/operation-body.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { uploadSigningKeys } from '#engine/client/cross-signing.ts';

export default async function (request: PathfinderRequest, context: Context) {
  await uploadSigningKeys(
    context.state.user as string,
    await parseJson(request),
  );
  return {};
}
