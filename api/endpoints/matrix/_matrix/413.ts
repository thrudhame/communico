import { json } from '@pathfinder/pathfinder/response';

// Matrix-shaped 413 (replaces the framework's default
// {"detail":"Payload Too Large"} page — same pattern as 404/405/500).
// Sources: the media upload limit (storeUploadBody throws MatrixError(413,
// M_TOO_LARGE) past MEDIA_MAX_BYTES) and pathfinder's own bodyLimit
// (BodyLimitError → the 413 outcome). Both mean the same thing on this
// wire — spec v1.16, Content repository security considerations:
// "returning a HTTP 413 error with the M_TOO_LARGE code"
// (https://spec.matrix.org/v1.16/client-server-api/#content-repository-security).
// deno-lint-ignore require-await
export default async function () {
  return json(
    { errcode: 'M_TOO_LARGE', error: 'Payload too large' },
    { status: 413 },
  );
}
