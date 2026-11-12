import type { PathfinderRequest } from '@pathfinder/pathfinder';
import { thirdPartyMappings } from '#engine/client/thirdparty.ts';
export default function (request: PathfinderRequest) {
  return thirdPartyMappings(
    request.query,
    'user',
    request.params.protocol as string,
  );
}
