import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { authorize } from '#engine/auth.ts';

// Bearer / ?access_token= auth (F1 semantics) as one shared pathfinder
// middleware — placed on each protected folder by a one-line 20-auth.ts
// re-export. Auth is placement, never a guard: unknown addresses under
// public ground get the spec's 404; unknown addresses inside protected
// ground get 401. Throws MatrixError 401s (M_MISSING_TOKEN /
// M_UNKNOWN_TOKEN) with verbatim Matrix bodies.
export default async function (request: PathfinderRequest, context: Context) {
  context.state.user = await authorize(request);
  const header = request.headers.get('Authorization') ?? '';
  context.state.token = /^Bearer (.+)$/.exec(header)?.[1] ??
    request.query.get('access_token') ?? undefined;
}
