import type { PathfinderRequest } from '@pathfinder/pathfinder';
import { thirdPartyProtocol } from '#engine/client/thirdparty.ts';
export default function (request: PathfinderRequest) {
  return thirdPartyProtocol(request.params.protocol as string);
}
