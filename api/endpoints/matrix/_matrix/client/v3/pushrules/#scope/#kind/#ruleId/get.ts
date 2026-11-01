import { localpartOf } from '#engine/tenant/auth.ts';
import { assertScopeKind, getRule } from '#engine/tenant/pushrules.ts';
import { theApp } from '#engine/app.ts';

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
    theApp().tenant,
    localpartOf(context.state.user as string),
    request.params.kind as string,
    request.params.ruleId as string,
  );
}
