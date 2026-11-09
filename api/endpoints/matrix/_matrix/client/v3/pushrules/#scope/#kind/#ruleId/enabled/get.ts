import { localpartOf } from '#engine/tenant/auth.ts';
import { assertScopeKind, getRule } from '#engine/tenant/pushrules.ts';
import { theApp } from '#engine/app.ts';

// GET /_matrix/client/v3/pushrules/#scope/#kind/#ruleId/enabled
// (pushrules.yaml:330-391) → {enabled}.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  assertScopeKind(
    request.params.scope as string,
    request.params.kind as string,
    'read',
  );
  const rule = await getRule(
    theApp().tenant,
    localpartOf(context.state.user as string),
    request.params.kind as string,
    request.params.ruleId as string,
  );
  return { enabled: rule.enabled };
}
