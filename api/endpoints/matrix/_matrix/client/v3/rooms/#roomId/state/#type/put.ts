import {
  validateCanonicalAliasContent,
  writeStateKey,
} from '#engine/client/state.ts';
import { parseJson } from '#engine/operation-body.ts';
import { scheduleDelayed } from '#engine/client/delayed.ts';

export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const content = await parseJson(request) as Record<string, unknown>;
  const roomId = request.params.roomId as string;
  if (request.params.type === 'm.room.canonical_alias') {
    await validateCanonicalAliasContent(roomId, content);
  }
  const delayed = await scheduleDelayed(request, context, content, '');
  if (delayed !== null) return delayed;
  return await writeStateKey(
    roomId,
    context.state.user as string,
    request.params.type as string,
    '',
    content,
  );
}
