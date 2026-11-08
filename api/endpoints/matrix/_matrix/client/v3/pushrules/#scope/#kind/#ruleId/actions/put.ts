import { localpartOf } from '#engine/tenant/auth.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { assertScopeKind, setRuleActions } from '#engine/tenant/pushrules.ts';
import { theApp } from '#engine/app.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// PUT /_matrix/client/v3/pushrules/#scope/#kind/#ruleId/actions —
// {actions} required.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  assertScopeKind(
    request.params.scope as string,
    request.params.kind as string,
  );
  const body = (await parseJson(request)) as Record<string, unknown>;
  if (!Array.isArray(body.actions)) {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'actions is required');
  }
  await setRuleActions(
    theApp().tenant,
    localpartOf(context.state.user as string),
    request.params.kind as string,
    request.params.ruleId as string,
    body.actions,
  );
  return {};
}
