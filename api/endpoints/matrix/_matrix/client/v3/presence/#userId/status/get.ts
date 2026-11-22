import { getPresence } from '#engine/client/presence.ts';

export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const row = await getPresence(
    context.state.user as string,
    request.params.userId as string,
    request._raw.signal,
  );
  const out: Record<string, unknown> = { presence: row.presence };
  if (row.statusMsg !== null) out.status_msg = row.statusMsg;
  if (row.presence !== 'offline' && row.lastActiveMs > 0) {
    out.last_active_ago = Math.max(0, Date.now() - row.lastActiveMs);
  }
  return out;
}
