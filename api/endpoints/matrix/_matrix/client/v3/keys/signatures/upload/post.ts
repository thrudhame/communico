import { parseJson } from '#engine/operation-body.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { uploadSignatures } from '#engine/client/cross-signing.ts';

export default async function (request: PathfinderRequest, context: Context) {
  return await uploadSignatures(
    context.state.user as string,
    await parseJson(request),
  );
}
