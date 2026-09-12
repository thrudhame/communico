import type { Context } from '@pathfinder/pathfinder';
import { json } from '@pathfinder/pathfinder/response';

// Matrix-shaped 405 with the Allow header rebuilt from the match data
// (context.miss.allowed). Replaces the framework's bare-status default.
// deno-lint-ignore require-await
export default async function (
  _request: unknown,
  context: Context,
) {
  const allowed = context.miss?.kind === 'method-miss'
    ? context.miss.allowed
    : [];
  return json(
    { errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' },
    { status: 405, headers: { Allow: allowed.join(', ') } },
  );
}
