// GET /_matrix/federation/v1/version — "Get the implementation name and
// its version." (spec v1.16, data/api/server-server/version.yaml:19-50).
// Public — like the /_matrix/key/ tree, no auth placement. Version comes
// from deno.json (the field added in this commit).
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
import config from '#root/deno.json' with { type: 'json' };

// deno-lint-ignore require-await
export default async function () {
  assertFederationEnabled();
  return {
    server: {
      name: 'communico',
      version: config.version,
    },
  };
}
