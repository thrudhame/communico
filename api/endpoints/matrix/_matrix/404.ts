import type { Context } from '@pathfinder/pathfinder';
import { json } from '@pathfinder/pathfinder/response';

// Matrix-shaped 404 for the whole _matrix tree (replaces the framework's
// default {"detail"} page). Two sources reach it, told apart by
// context.miss (pathfinder renders this page for BOTH and does not expose
// the thrown value — TODO-0.3.0 item 2):
// - routing miss (context.miss carries the match data) → the address or
//   method is unknown: M_UNRECOGNIZED, per the M1 contract.
// - handler-thrown MatrixError(404) (no miss) → the address exists, the
//   resource does not: M_NOT_FOUND. Every thrown 404 in this tree is
//   M_NOT_FOUND (media/profile/account-data resources); the thrown error
//   message is lost to the page, so the reason is generic.
// deno-lint-ignore require-await
export default async function (_request: unknown, context: Context) {
  return context.miss !== undefined
    ? json(
      { errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' },
      { status: 404 },
    )
    : json(
      { errcode: 'M_NOT_FOUND', error: 'Not found' },
      { status: 404 },
    );
}
