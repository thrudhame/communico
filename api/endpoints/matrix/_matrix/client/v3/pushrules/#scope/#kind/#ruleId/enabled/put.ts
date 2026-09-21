import { localpartOf } from '#engine/auth.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { assertScopeKind, setRuleEnabled } from '#engine/pushrules.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// PUT /_matrix/client/v3/pushrules/#scope/#kind/#ruleId/enabled
// (pushrules.yaml:393+) — {enabled} required.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  assertScopeKind(
    request.params.scope as string,
    request.params.kind as string,
  );
  const body = (await parseJson(request)) as Record<string, unknown>;
  if (typeof body.enabled !== 'boolean') {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'enabled is required');
  }
  await setRuleEnabled(
    localpartOf(context.state.user as string),
    request.params.kind as string,
    request.params.ruleId as string,
    body.enabled,
  );
  return {};
}
