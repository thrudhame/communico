import { localpartOf } from '#engine/auth.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { assertScopeKind, putRule } from '#engine/pushrules.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// PUT /_matrix/client/v3/pushrules/#scope/#kind/#ruleId — create or
// update a rule (pushrules.yaml:185-309): actions required; created
// rules are enabled by default and (absent before/after) become the most
// important user-defined rule of the kind.
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
  await putRule(
    localpartOf(context.state.user as string),
    request.params.kind as string,
    request.params.ruleId as string,
    {
      actions: body.actions,
      conditions: body.conditions as unknown[] | undefined,
      pattern: typeof body.pattern === 'string' ? body.pattern : undefined,
    },
    {
      before: request.query.get('before') ?? undefined,
      after: request.query.get('after') ?? undefined,
    },
  );
  return {};
}
