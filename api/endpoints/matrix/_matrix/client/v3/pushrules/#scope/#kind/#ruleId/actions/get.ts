import { localpartOf } from '#engine/auth.ts';
import { assertScopeKind, getRule } from '#engine/pushrules.ts';

// GET /_matrix/client/v3/pushrules/#scope/#kind/#ruleId/actions
// (pushrules.yaml — the actions sub-resource) → {actions}.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  assertScopeKind(
    request.params.scope as string,
    request.params.kind as string,
  );
  const rule = await getRule(
    localpartOf(context.state.user as string),
    request.params.kind as string,
    request.params.ruleId as string,
  );
  return { actions: rule.actions };
}
