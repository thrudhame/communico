import { getPresence } from '#engine/presence.ts';

// GET /_matrix/client/v3/presence/#userId/status — {presence,
// status_msg?} (the spec's default is offline).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  const row = await getPresence(request.params.userId as string);
  const out: Record<string, unknown> = { presence: row.presence };
  if (row.statusMsg !== null) out.status_msg = row.statusMsg;
  if (row.presence !== 'offline' && row.lastActiveMs > 0) {
    out.last_active_ago = Math.max(0, Date.now() - row.lastActiveMs);
  }
  return out;
}
