// Bearer / ?access_token= auth, as on doltgres: auth is placement. The
// protected folders re-export this middleware; mixed public/protected
// folders (profile) call authorize() from their write handlers instead.
// The tenant file owns tokens; lookupToken hashes the presented secret.
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { lookupToken, type TokenInfo } from '#engine/tenant/auth.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { roomCompletion } from '#engine/client/completion.ts';
import type { DeviceIdentity } from '#engine/tenant/devices.ts';
import { localpartOf } from '#engine/ids.ts';

export type AuthContext = TokenInfo & { tenant: Tenant; token: string };

/** Reuse the authenticated generation; never look up a replacement device. */
export function authenticatedDevice(context: Context): DeviceIdentity | null {
  const deviceId = context.state.device as string | undefined;
  const generation = context.state.deviceGeneration as number | undefined;
  return deviceId == null || generation == null ? null : {
    localpart: localpartOf(context.state.user as string),
    deviceId,
    generation,
  };
}

export async function authorizeFull(
  request: PathfinderRequest,
): Promise<AuthContext> {
  const header = request.headers.get('Authorization') ?? '';
  const token = /^Bearer (.+)$/.exec(header)?.[1] ??
    request.query.get('access_token');
  if (!token) throw new MatrixError(401, 'M_MISSING_TOKEN', 'no Bearer token');
  const tenant = theApp().tenant;
  const info = await lookupToken(tenant, token);
  if (info === null) {
    throw new MatrixError(401, 'M_UNKNOWN_TOKEN', 'token not recognized');
  }
  // Explicit room reads await only this device's exact pending cuts in that
  // room. Audience consumers select their scopes in the engine instead.
  const roomId = request.params.roomId;
  if (
    request.method === 'GET' && typeof roomId === 'string' &&
    !request.path.endsWith('/initialSync')
  ) {
    await roomCompletion(
      theApp(),
      [roomId],
      request._raw.signal,
      info.device_id === null || info.generation === null ? null : {
        localpart: info.localpart,
        deviceId: info.device_id,
        generation: info.generation,
      },
    );
  }
  return { ...info, tenant, token };
}

export async function authorize(request: PathfinderRequest): Promise<string> {
  return (await authorizeFull(request)).user_id;
}

export default async function (request: PathfinderRequest, context: Context) {
  const info = await authorizeFull(request);
  context.state.tenant = info.tenant;
  context.state.user = info.user_id;
  context.state.device = info.device_id ?? undefined;
  context.state.deviceGeneration = info.generation ?? undefined;
  context.state.token = info.token;
}
