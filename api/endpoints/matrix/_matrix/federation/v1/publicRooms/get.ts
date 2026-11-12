// Federation directory operations are local reads, never remote relays.
import { publicRooms } from '#engine/client/directory.ts';
import { decodeDirectoryRequest } from '#engine/client/directory-request.ts';
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest) {
  assertFederationEnabled();
  return await publicRooms(decodeDirectoryRequest(request.query));
}
