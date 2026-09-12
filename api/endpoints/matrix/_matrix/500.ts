import { json } from '@pathfinder/pathfinder/response';

// Matrix-shaped 500 (uncaught errors). context.error holds the thrown
// value; the framework already logged it. Never leak internals.
// deno-lint-ignore require-await
export default async function () {
  return json(
    { errcode: 'M_UNKNOWN', error: 'Internal server error' },
    { status: 500 },
  );
}
