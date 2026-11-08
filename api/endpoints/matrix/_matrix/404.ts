import type { Context } from '@pathfinder/pathfinder';
import { HttpError } from '@pathfinder/pathfinder';
import { json } from '@pathfinder/pathfinder/response';

// Matrix-shaped 404 for the _matrix tree. Two sources, told apart by what
// pathfinder hands the page (0.2.2): a handler threw → context.error is
// that HttpError and its body is the answer; a routing miss → no thrown
// error, the address/method is unknown: M_UNRECOGNIZED (spec: 404 for an
// unimplemented endpoint).
// deno-lint-ignore require-await
export default async function (_request: unknown, context: Context) {
  const thrown = context.error;
  if (thrown instanceof HttpError && thrown.body !== undefined) {
    return json(thrown.body, { status: 404 });
  }
  return json(
    { errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' },
    { status: 404 },
  );
}
