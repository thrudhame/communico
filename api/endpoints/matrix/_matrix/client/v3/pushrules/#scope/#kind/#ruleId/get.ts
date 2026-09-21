import { localpartOf } from '#engine/auth.ts';
import { assertScopeKind, getRule } from '#engine/pushrules.ts';

// GET /_matrix/client/v3/pushrules/#scope/#kind/#ruleId — one rule
// (pushrules.yaml:65-129); 404 M_NOT_FOUND when absent.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  assertScopeKind(
    request.params.scope as string,
    request.params.kind as string,
  );
  return await getRule(
    localpartOf(context.state.user as string),
    request.params.kind as string,
    request.params.ruleId as string,
  );
}
