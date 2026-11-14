// api/engine/federation/keydoc.ts — our key document serving and the
// notary answer from cache. The notary is the spec's Perspectives shape:
// the origin's verbatim document with OUR signature added — both
// signatures present. No fetch on miss: we serve what we hold (a fetch on
// an unauthenticated endpoint would be an amplifier). Ported from
// doltgres; the server file's Db and the tenant Signer are explicit.
import { canonicalJson } from '#engine/canonical.ts';
import { config } from '#engine/config.ts';
import type { Database as Db } from '#engine/store/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Signer } from '#engine/room/signer.ts';
import { publishedKeyDocument } from '#engine/facade/control.ts';
import { type KeyDoc, ourKeyDocument, signWithSigner } from './keys.ts';

/** Home authors the roster approved by its durable enrollment owner. Pending
 * keys are absent; retirement retains the original public key and cutoff. */
export async function homeKeyDocument(
  server: Db,
  signer: Signer,
  publicKey: string,
): Promise<KeyDoc> {
  const published = await publishedKeyDocument(server, signer, publicKey);
  if (published) return published;
  // The publication owner observed a home-only roster. Do not read a newer
  // roster here and accidentally attach keys whose signatures are not held.
  return await ourKeyDocument(signer, publicKey);
}

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
  minimumValidUntil = Date.now(),
): Promise<KeyDoc | null> {
  const documents = await notaryDocumentsFromCache(server, signer, [{
    server: name,
    minimum: minimumValidUntil,
  }]);
  return documents.length === 0 ? null : documents[0];
}

// Input size is already bounded by request admission. A set-based lookup makes
// misses cheap without a new entry quota, and signs only eligible held hits.
export async function notaryDocumentsFromCache(
  server: Db,
  signer: Signer,
  requests: readonly { server: string; minimum: number }[],
): Promise<KeyDoc[]> {
  if (requests.length === 0) return [];
  const rows = await server.query(
    `SELECT d.key_json, json_extract(r.value, '$.minimum') AS minimum
     FROM json_each(?) r JOIN server_key_docs d
       ON d.server_name = json_extract(r.value, '$.server')
     ORDER BY CAST(r.key AS INTEGER)`,
    [JSON.stringify(requests)],
  );
  const documents: KeyDoc[] = [];
  for (const row of rows) {
    const doc = JSON.parse(String(row.key_json)) as KeyDoc;
    if (doc.valid_until_ts < Number(row.minimum)) continue;
    await signWithSigner(doc as unknown as Record<string, unknown>, signer);
    documents.push(doc);
  }
  return documents;
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
