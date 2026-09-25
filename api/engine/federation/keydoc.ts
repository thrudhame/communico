// api/engine/federation/keydoc.ts — our key document serving and the
// notary answer from cache. The notary is the spec's Perspectives shape:
// the origin's verbatim document with OUR signature added — both
// signatures present. No fetch on miss: we serve what we hold (a fetch on
// an unauthenticated endpoint would be an amplifier).
import { canonicalJson } from '#engine/canonical.ts';
import { config, serverName } from '#engine/config.ts';
import { serverDb, withDb } from '#engine/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getTenantKey } from '#engine/tenant.ts';
import { signJson } from '#engine/signing-primitives.js';
import type { KeyDoc } from './keys.ts';

/** Every handler under /_matrix/federation/, /_matrix/key/ and — with a
 *  plain 404 in the .well-known handler — checks this first. Not a guard:
 *  the endpoint's own precondition, like assertLocalMxc. */
export function assertFederationEnabled(): void {
  if (!config().federation.enabled) {
    throw new MatrixError(404, 'M_UNRECOGNIZED', 'federation disabled');
  }
}

export async function notaryFromCache(
  name: string,
): Promise<KeyDoc | null> {
  const row = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT key_json FROM server_key_docs WHERE server_name = $1;',
      [name],
    );
    if (r.rows.length === 0) return null;
    return String((r.rows[0] as Record<string, unknown>).key_json);
  });
  if (row === null) return null;
  const doc = JSON.parse(row) as KeyDoc;
  const key = await getTenantKey();
  await signJson(doc, serverName(), 'ed25519:' + key.keyId, key.privateKey);
  return doc;
}

// The signed bytes: a key document is served as CANONICAL JSON so that a
// raw-bytes verifier (Complement's federation_keys_test deletes the
// signatures key and verifies the remainder verbatim) agrees with our
// canonical signature.
export function keyDocResponse(doc: unknown): Response {
  return new Response(canonicalJson(doc), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
