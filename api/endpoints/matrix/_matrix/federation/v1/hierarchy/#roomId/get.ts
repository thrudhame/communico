import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import {
  federationHierarchy,
  hierarchyQuery,
} from '#engine/client/hierarchy.ts';
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
export default async function (request: PathfinderRequest, context: Context) {
  assertFederationEnabled();
  return await federationHierarchy(
    request.params.roomId as string,
    context.state.origin as string,
    hierarchyQuery(request.query).suggested,
  );
}
