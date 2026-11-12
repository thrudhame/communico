import { json } from '@pathfinder/pathfinder/response';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import {
  UpstreamError,
  UpstreamHttpError,
} from '#engine/net/upstream-error.ts';

// Matrix-shaped 500 (uncaught errors). context.error holds the thrown
// value; the framework already logged it. Never leak internals.
// deno-lint-ignore require-await
export default async function (_request: PathfinderRequest, context: Context) {
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
