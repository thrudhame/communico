import { json } from '@pathfinder/pathfinder/response';

// Matrix-shaped 404 for the whole _matrix tree (replaces the framework's
// default {"detail"} page). context.miss carries the match data.
// deno-lint-ignore require-await
export default async function () {
  return json(
    { errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' },
    { status: 404 },
  );
}
