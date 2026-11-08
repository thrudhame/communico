import type { PathfinderRequest } from '@pathfinder/pathfinder';
import { userDevices } from '#engine/federation/e2ee.ts';
export default async function (request: PathfinderRequest) {
  return await userDevices(request.params.userId as string);
}
