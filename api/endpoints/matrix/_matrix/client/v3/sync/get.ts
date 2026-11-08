import { MatrixError } from '#engine/matrix-error.ts';
import { parseStreamToken } from '#engine/client/tokens.ts';
import { resolveFilter } from '#engine/tenant/filters.ts';
import { syncFor } from '#engine/syncfeed.ts';
import { theApp } from '#engine/app.ts';

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
  const filter = await resolveFilter(
    theApp().tenant,
    userId,
    request.query.get('filter'),
  );
  const fullState = request.query.get('full_state') === 'true';
  const setPresence = request.query.get('set_presence') ?? undefined;
  return await syncFor({
    userId,
    deviceId,
    deviceGeneration: context.state.deviceGeneration,
    since,
    timeoutMs,
    filter,
    fullState,
    setPresence,
  });
}
