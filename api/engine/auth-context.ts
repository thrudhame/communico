// Bearer / ?access_token= auth, as on doltgres: auth is placement. The
// protected folders re-export this middleware; mixed public/protected
// folders (profile) call authorize() from their write handlers instead.
// The tenant file owns tokens; lookupToken hashes the presented secret.
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { lookupToken, type TokenInfo } from '#engine/tenant/auth.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { clientCompletion } from '#engine/client/completion.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { localpartOf } from '#engine/ids.ts';

export type AuthContext = TokenInfo & { tenant: Tenant; token: string };

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
  // Authentication supplies the authoritative device generation to the shared
  // read admission. Sync owns its later successful-render retirement; other
  // effect consumers leave the satisfied marker for that owner. Neither send
  // acceptance nor unrelated account commands acquire a publication barrier.
  const effectRead =
    request.method === 'GET' && !request.path.endsWith('/sync') ||
    request.path.endsWith('/search') ||
    /\/(receipt\/|read_markers$)/.test(request.path);
  if (effectRead && info.device_id !== null) {
    await clientCompletion(
      theApp(),
      await deviceIdentity(
        tenant,
        localpartOf(info.user_id),
        info.device_id,
        info.generation ?? undefined,
      ),
      request._raw.signal,
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
