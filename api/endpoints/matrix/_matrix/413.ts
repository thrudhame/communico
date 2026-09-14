import type { Context } from '@pathfinder/pathfinder';
import { HttpError } from '@pathfinder/pathfinder';
import { json } from '@pathfinder/pathfinder/response';

// Matrix-shaped 413 (replaces the framework's default
// {"detail":"Payload Too Large"} page — same pattern as 404/405/500).
// Two sources, told apart by what pathfinder hands the page (0.2.2): a
// handler threw an HttpError (the media upload limit — storeUploadBody
// throws MatrixError(413, M_TOO_LARGE) past MEDIA_MAX_BYTES) → its own
// body is the answer; pathfinder's bodyLimit (BodyLimitError, not an
// HttpError) → the fixed body below. Both mean the same thing on this
// wire — spec v1.16, Content repository security considerations:
// "returning a HTTP 413 error with the M_TOO_LARGE code"
// (https://spec.matrix.org/v1.16/client-server-api/#content-repository-security).
// deno-lint-ignore require-await
export default async function (_request: unknown, context: Context) {
  const thrown = context.error;
  if (thrown instanceof HttpError && thrown.body !== undefined) {
    return json(thrown.body, { status: 413 });
  }
  return json(
    { errcode: 'M_TOO_LARGE', error: 'Payload too large' },
    { status: 413 },
  );
}
