// Public implementation version, as on doltgres.
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
import config from '#root/deno.json' with { type: 'json' };

// deno-lint-ignore require-await
export default async function () {
  assertFederationEnabled();
  return { server: { name: 'communico', version: config.version } };
}
