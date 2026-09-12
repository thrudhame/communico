import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { authorize } from '../../../../../engine/auth.ts';

// Bearer / ?access_token= auth for /_matrix/client/v3 (F1 semantics, moved
// from per-endpoint authorize() calls to pathfinder middleware). Throws
// MatrixError 401s (M_MISSING_TOKEN / M_UNKNOWN_TOKEN) with verbatim
// Matrix bodies. Routes opt out via `export const auth = false` (login,
// register*, versions). pathfinder ≥ c17cb14: middleware runs on misses
// and wrong-methods alike — an unauthenticated request to an unknown or
// wrong-method path under v3 gets the 401 (Complement's probes are
// authenticated, so the gate never sees this; recorded in RESULTS).
export default async function (request: PathfinderRequest, context: Context) {
  if (context.meta.auth === false) return;
  context.state.user = await authorize(request);
  const header = request.headers.get('Authorization') ?? '';
  context.state.token = /^Bearer (.+)$/.exec(header)?.[1] ??
    request.query.get('access_token') ?? undefined;
}
