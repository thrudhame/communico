import { theApp } from '#engine/app.ts';
import {
  assertFederationEnabled,
  keyDocResponse,
  notaryFromCache,
} from '#engine/federation/keydoc.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest) {
  assertFederationEnabled();
  const app = theApp();
  const doc = await notaryFromCache(
    app.server,
    app.tenant.signer(),
    request.params.serverName as string,
  );
  return keyDocResponse({ server_keys: doc === null ? [] : [doc] });
}
