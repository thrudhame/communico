import { json } from '@pathfinder/pathfinder/response';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import {
  UpstreamError,
  UpstreamHttpError,
} from '#engine/net/upstream-error.ts';
import { matrixFailure } from '#engine/request-diagnostics.ts';

// Matrix-shaped 500 (uncaught errors). context.error holds the thrown
// value. Retain safe request correlation even when the framework also logs it.
// deno-lint-ignore require-await
export default async function (request: PathfinderRequest, context: Context) {
  matrixFailure(request, context);
  if (context.error instanceof UpstreamHttpError) {
    return json(context.error.responseBody(), {
      status: context.error.status,
    });
  }
  if (
    context.error instanceof UpstreamError &&
    ['transport', 'protocol', 'validation'].includes(context.error.category)
  ) {
    const large = context.error.context.resourceLimit === true;
    return json({
      errcode: large ? 'M_TOO_LARGE' : 'M_UNKNOWN',
      error: `Upstream ${context.error.category} failure`,
    }, { status: 502 });
  }
  return json(
    { errcode: 'M_UNKNOWN', error: 'Internal server error' },
    { status: 500 },
  );
}
