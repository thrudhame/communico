import { syncSince } from '#engine/syncfeed.ts';

// GET /_matrix/client/v3/sync — phase-2 step 2.3. `since` = 's<digits>';
// `timeout` = long-poll budget in ms (default 0, capped at 30000 in
// syncSince). Auth enforced by the 20-auth middleware.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
) {
  const sinceRaw = request.query.get('since');
  const sinceMatch = sinceRaw ? /^s(\d+)$/.exec(sinceRaw) : null;
  const since = sinceMatch ? Number(sinceMatch[1]) : null;
  const timeoutRaw = request.query.get('timeout');
  const timeoutMs = timeoutRaw ? Math.max(0, Number(timeoutRaw) || 0) : 0;
  return await syncSince(since, timeoutMs);
}
