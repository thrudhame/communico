import { localpartOf } from '#engine/auth.ts';
import { assertScopeKind, deleteRule } from '#engine/pushrules.ts';

// DELETE /_matrix/client/v3/pushrules/#scope/#kind/#ruleId — remove a
// rule (pushrules.yaml:131-183); 404 M_NOT_FOUND when absent.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  assertScopeKind(
    request.params.scope as string,
    request.params.kind as string,
  );
  await deleteRule(
    localpartOf(context.state.user as string),
    request.params.kind as string,
    request.params.ruleId as string,
  );
  return {};
}
