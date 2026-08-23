import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';
import { createHttpError, Status } from '@oak/oak';
import { authorize } from '../../../../../engine/auth.ts';
import { syncSince } from '../../../../../engine/syncfeed.ts';

// GET /_matrix/client/v3/sync — phase-2 step 2.3. `since` = 's<digits>';
// `timeout` = long-poll budget in ms (default 0, capped at 30000 in
// syncSince). Route file carried over from the phase-1 step-1.5b minimal
// shape; internals are the real syncfeed now (decision Q4 guard-rail:
// Act 1 re-verified after this swap).
export default async function (
  request: TApiComponentRequest,
): TApiComponentOutcome {
  try {
    await authorize(request);
  } catch (e) {
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }
  try {
    const sinceRaw = request.search.get('since');
    const sinceMatch = sinceRaw ? /^s(\d+)$/.exec(sinceRaw) : null;
    const since = sinceMatch ? Number(sinceMatch[1]) : null;
    const timeoutRaw = request.search.get('timeout');
    const timeoutMs = timeoutRaw ? Math.max(0, Number(timeoutRaw) || 0) : 0;
    const result = await syncSince(since, timeoutMs);
    return [null, result];
  } catch (e) {
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }
}
