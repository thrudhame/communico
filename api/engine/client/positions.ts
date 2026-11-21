// Admission reads composition's existing store identity; a request can never
// create or infer authority from its bookmark. Restore recovery stays separate.
import { readPublicationIdentity } from '#engine/facade/ownership.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Database } from '#engine/store/db.ts';
import { parseStreamToken, type StreamToken } from './tokens.ts';

export async function requireStreamDomain(
  server: Pick<Database, 'query'>,
  token: StreamToken | null,
): Promise<string> {
  const local = await readPublicationIdentity(server);
  if (local === null) {
    throw new MatrixError(
      503,
      'M_UNAVAILABLE',
      'publication domain unavailable',
    );
  }
  // The original home store alone retains its pre-domain grammar. An enrolled
  // facade cannot reinterpret a home legacy token as a locally issued position.
  if (
    token !== null &&
    (token.domain === undefined
      ? local.node !== 'home'
      : token.domain !== local.domain)
  ) {
    throw new MatrixError(
      400,
      'M_UNKNOWN_POS',
      'foreign sync position; retry without since for a full resync',
    );
  }
  return local.domain;
}

export async function parseLocalStreamToken(
  server: Pick<Database, 'query'>,
  raw: string | null,
): Promise<StreamToken | null> {
  const token = parseStreamToken(raw);
  if (token !== null) await requireStreamDomain(server, token);
  return token;
}
