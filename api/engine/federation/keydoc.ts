// api/engine/federation/keydoc.ts — our key document serving and the
// notary answer from cache. The notary is the spec's Perspectives shape:
// the origin's verbatim document with OUR signature added — both
// signatures present. No fetch on miss: we serve what we hold (a fetch on
// an unauthenticated endpoint would be an amplifier). Ported from
// doltgres; the server file's Db and the tenant Signer are explicit.
import { canonicalJson } from '#engine/canonical.ts';
import { config } from '#engine/config.ts';
import type { Db } from '#engine/store/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Signer } from '#engine/room/signer.ts';
import { type KeyDoc, signWithSigner } from './keys.ts';

/** Every handler under /_matrix/federation/, /_matrix/key/ and — with a
 *  plain 404 in the .well-known handler — checks this first. Not a guard:
 *  the endpoint's own precondition. */
export function assertFederationEnabled(): void {
  if (!config().federation.enabled) {
    throw new MatrixError(404, 'M_UNRECOGNIZED', 'federation disabled');
  }
}

// The notary answer from what we hold: the cached document verbatim with
// our signature added (the origin's self-signature stays).
export async function notaryFromCache(
  server: Db,
  signer: Signer,
  name: string,
): Promise<KeyDoc | null> {
  const rows = await server.query(
    'SELECT key_json FROM server_key_docs WHERE server_name = ?',
    [name],
  );
  if (rows.length === 0) return null;
  const doc = JSON.parse(String(rows[0].key_json)) as KeyDoc;
  await signWithSigner(doc as unknown as Record<string, unknown>, signer);
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
