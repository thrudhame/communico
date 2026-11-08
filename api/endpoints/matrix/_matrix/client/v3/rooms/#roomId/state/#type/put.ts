import {
  validateCanonicalAliasContent,
  writeStateKey,
} from '#engine/client/state.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const content = await parseJson(request) as Record<string, unknown>;
  const roomId = request.params.roomId as string;
  if (request.params.type === 'm.room.canonical_alias') {
    await validateCanonicalAliasContent(roomId, content);
  }
  return await writeStateKey(
    roomId,
    context.state.user as string,
    request.params.type as string,
    '',
    content,
  );
}
