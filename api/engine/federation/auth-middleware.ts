// Pathfinder adapter for the engine's shared X-Matrix verification path.
import { theApp } from '#engine/app.ts';
import { authenticateRequest } from './auth.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest, context: Context) {
  const app = theApp();
  const url = new URL(request._raw.url);
  context.state.origin = await authenticateRequest(
    {
      server: app.server,
      keys: app.federationKeys,
      onContact: app.sender?.contactHook(),
    },
    app.tenant.serverName,
    {
      method: request.method,
      uri: url.pathname + url.search,
      authorization: request.headers.get('authorization'),
      body: await request.body.bytes(),
    },
  );
}
