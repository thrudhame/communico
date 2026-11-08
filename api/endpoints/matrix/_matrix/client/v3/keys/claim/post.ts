import { parseJson } from '@pathfinder/pathfinder/body';
import type { PathfinderRequest } from '@pathfinder/pathfinder';
import { claimKeys } from '#engine/client/e2ee.ts';
export default async function (request: PathfinderRequest) {
  return await claimKeys(await parseJson(request));
}
