import { json } from '@pathfinder/pathfinder/response';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import {
  UpstreamError,
  UpstreamHttpError,
} from '#engine/net/upstream-error.ts';
import { matrixFailure } from '#engine/request-diagnostics.ts';
import { config } from '#engine/config.ts';
import { isStoragePressure } from '#engine/store/pressure.ts';

// Matrix-shaped 500 (uncaught errors). context.error holds the thrown
// value. Retain safe request correlation even when the framework also logs it.
// deno-lint-ignore require-await
export default async function (request: PathfinderRequest, context: Context) {
  matrixFailure(request, context);
  if (isStoragePressure(context.error)) {
    const path = new URL(request._raw.url).pathname;
    const client = path.startsWith('/_matrix/client/') ||
      path.startsWith('/_matrix/media/');
    const contact = client && config().server.admincontact;
    return contact
      ? json({
        errcode: 'M_RESOURCE_LIMIT_EXCEEDED',
        error: 'Storage capacity exhausted',
        admin_contact: contact,
      }, { status: 403 })
      : json({
        errcode: 'M_UNAVAILABLE',
        error: 'Storage capacity exhausted',
      }, { status: 503 });
  }
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
