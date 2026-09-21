import { parseJson } from '@pathfinder/pathfinder/body';
import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { putAccountData } from '#engine/tenant.ts';
import { localpartOf } from '#engine/auth.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

// PUT /_matrix/client/v3/user/{userId}/account_data/{type} — "Set some
// account data for the client. This config is only visible to the user
// that set the account data. The config will be available to clients
// through the top-level `account_data` field in the homeserver response
// to /sync." (spec v1.11, Client Config.) Self-only (403 otherwise); the
// body must be a JSON object. Response: {}.
export default async function (request: PathfinderRequest, context: Context) {
  const caller = context.state.user as string;
  const userId = request.params.userId as string;
  if (userId !== caller) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'account data is private to its owner',
    );
  }
  const content = await parseJson(request);
  if (
    content === null || typeof content !== 'object' || Array.isArray(content)
  ) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'account data content must be a JSON object',
    );
  }
  // 3g: server-controlled types are 405 M_BAD_JSON (account-data.yaml
  // :98-101 — "controlled by the server; it cannot be modified by
  // clients"). m.push_rules is synthesised from the push_rules table;
  // m.fully_read belongs to /read_markers.
  const type = request.params.type as string;
  if (type === 'm.push_rules' || type === 'm.fully_read') {
    throw new MatrixError(
      405,
      'M_BAD_JSON',
      `Cannot set ${type} through this API.`,
    );
  }
  await putAccountData(
    serverName(),
    localpartOf(caller),
    '',
    type,
    content,
  );
  return {};
}
