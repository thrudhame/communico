import type { PathfinderRequest } from '@pathfinder/pathfinder';
import { theApp } from '#engine/app.ts';
import { openIdUserInfo } from '#engine/tenant/openid.ts';

// The OpenID bearer authenticates itself. This folder deliberately does not
// inherit the signed-federation middleware used by the other v1 routes.
export default function (request: PathfinderRequest) {
  const header = request.headers.get('Authorization') ?? '';
  const token = /^Bearer (.+)$/.exec(header)?.[1] ??
    request.query.get('access_token') ?? '';
  return openIdUserInfo(theApp().tenant, token);
}
