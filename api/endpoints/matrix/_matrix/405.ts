import type { Context } from '@pathfinder/pathfinder';
import { HttpError } from '@pathfinder/pathfinder';
import { json } from '@pathfinder/pathfinder/response';

// Matrix-shaped 405 with the Allow header rebuilt from the match data
// (context.miss.allowed). Replaces the framework's bare-status default.
// Like the 404 page: a handler's OWN thrown 405 (e.g. the 3g
// server-controlled account-data types) keeps its thrown body; a routing
// method-miss is M_UNRECOGNIZED.
// deno-lint-ignore require-await
export default async function (
  _request: unknown,
  context: Context,
) {
  const thrown = context.error;
  if (thrown instanceof HttpError && thrown.body !== undefined) {
    return json(thrown.body, { status: 405 });
  }
  const allowed = context.miss?.kind === 'method-miss'
    ? context.miss.allowed
    : [];
  return json(
    { errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' },
    { status: 405, headers: { Allow: allowed.join(', ') } },
  );
}
