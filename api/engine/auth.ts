import type { PathfinderRequest } from '@pathfinder/pathfinder';
import { SERVER_NAME } from './config.ts';
import { lookupToken } from './tenant.ts';
import { MatrixError } from './matrix-error.ts';

// Tenant-DB token auth (F1): token from `Authorization: Bearer <token>`
// OR the `?access_token=` query param (matrix-nio's observed mechanism).
// Looks the token up in the tenant's access_tokens, returns the full
// user_id. Throws MatrixError 401s — never 500s. The 20-auth middleware is
// the usual caller (routes opt out via `export const auth = false`); deep
// helpers may still call this directly.
export async function authorize(
  request: PathfinderRequest,
): Promise<string> {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  const token = match?.[1] ?? request.query.get('access_token');
  if (!token) throw new MatrixError(401, 'M_MISSING_TOKEN', 'no Bearer token');
  const info = await lookupToken(SERVER_NAME, token);
  if (!info) {
    throw new MatrixError(401, 'M_UNKNOWN_TOKEN', 'token not recognized');
  }
  return info.user_id;
}
