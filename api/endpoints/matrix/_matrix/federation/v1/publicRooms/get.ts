// Federation directory operations are local reads, never remote relays.
import {
  assertFederationDirectoryAllowed,
  listLocalPublishedRooms,
} from '#engine/client/directory.ts';
import { decodeDirectoryRequest } from '#engine/client/directory-request.ts';
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest) {
  assertFederationEnabled();
  assertFederationDirectoryAllowed();
  return await listLocalPublishedRooms(decodeDirectoryRequest(request.query));
}
