import { MatrixError } from '#engine/matrix-error.ts';
import { parseStreamToken } from '#engine/room.ts';
import { resolveFilter } from '#engine/filters.ts';
import { syncFor } from '#engine/syncfeed.ts';

// GET /_matrix/client/v3/sync — M4: the per-user sync (plan §3e).
// `since` = s<eSeq>_p<pSeq> (legacy s<n> parses as _p0); `timeout` =
// long-poll budget in ms (default 0, capped at 30000); `filter` = a
// stored filter id or inline JSON; `full_state`; `set_presence`.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  const deviceId = (context.state.device as string | undefined) ?? null;
  const sinceRaw = request.query.get('since');
  const since = parseStreamToken(sinceRaw);
  if (sinceRaw !== null && since === null) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'bad since token: ' + sinceRaw,
    );
  }
  const timeoutRaw = request.query.get('timeout');
  const timeoutMs = timeoutRaw ? Math.max(0, Number(timeoutRaw) || 0) : 0;
  const filter = await resolveFilter(userId, request.query.get('filter'));
  const fullState = request.query.get('full_state') === 'true';
  const setPresence = request.query.get('set_presence') ?? undefined;
  return await syncFor({
    userId,
    deviceId,
    since,
    timeoutMs,
    filter,
    fullState,
    setPresence,
  });
}
