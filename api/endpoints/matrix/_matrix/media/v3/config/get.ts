import { mediaMaxBytes } from '#engine/media.ts';

// GET /_matrix/media/v3/config — "Get the configuration for the content
// repository." (spec v1.16, deprecated in favour of
// /_matrix/client/v1/media/config,
// https://spec.matrix.org/v1.16/client-server-api/#get_matrixmediav3config)
// m.upload.size is a JSON number (Complement M3 asserts the type). Auth:
// folder middleware.
// deno-lint-ignore require-await
export default async function () {
  return { 'm.upload.size': mediaMaxBytes() };
}
