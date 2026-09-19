import { writeStateKey } from '#engine/stateops.ts';
import { validateCanonicalAliasContent } from '#engine/aliases.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// PUT /_matrix/client/v3/rooms/#roomId/state/#type — the empty state key
// (bare or trailing-slash form). m.room.canonical_alias content is
// validated first (band C §3a — aliases must exist and point at THIS
// room; M_INVALID_PARAM syntax / M_BAD_ALIAS lookup).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const content = (await parseJson(request)) as Record<string, unknown>;
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
