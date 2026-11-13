// doltgres publicRooms POST; the shared directory owns filtering/pagination.
import {
  assertFederationDirectoryAllowed,
  listLocalPublishedRooms,
} from '#engine/client/directory.ts';
import { decodeDirectoryRequest } from '#engine/client/directory-request.ts';
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
import { parseJson } from '#engine/operation-body.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest) {
  assertFederationEnabled();
  assertFederationDirectoryAllowed();
  return await listLocalPublishedRooms(
    decodeDirectoryRequest(request.query, await parseJson(request)),
  );
}
