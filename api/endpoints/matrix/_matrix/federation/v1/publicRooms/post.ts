// doltgres publicRooms POST; the shared directory owns filtering/pagination.
import { publicRooms } from '#engine/client/directory.ts';
import { decodeDirectoryRequest } from '#engine/client/directory-request.ts';
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest) {
  assertFederationEnabled();
  return await publicRooms(
    decodeDirectoryRequest(request.query, await parseJson(request)),
  );
}
