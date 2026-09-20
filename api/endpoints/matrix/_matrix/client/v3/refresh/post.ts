import { MatrixError } from '#engine/matrix-error.ts';
import { consumeRefreshToken } from '#engine/tenant.ts';
import { serverName } from '#engine/config.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// POST /_matrix/client/v3/refresh — rotate the token pair (spec v1.16
// refresh.yaml; band C D8/3h). PUBLIC: "this endpoint does not require
// authentication via an access token. Authentication is provided via the
// refresh token." (refresh.yaml:37-39) — http-contract pins it as the
// first public POST beyond login/register (plan §7).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  const body = (await parseJson(request)) as Record<string, unknown>;
  const token = body.refresh_token;
  if (typeof token !== 'string') {
    throw new MatrixError(
      400,
      'M_MISSING_PARAM',
      'refresh_token is required',
    );
  }
  const rotated = await consumeRefreshToken(serverName(), token);
  return {
    access_token: rotated.accessToken,
    refresh_token: rotated.refreshToken,
    expires_in_ms: rotated.expiresInMs,
  };
}
