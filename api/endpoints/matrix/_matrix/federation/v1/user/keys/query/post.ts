import { parseJson } from '@pathfinder/pathfinder/body';
import type { PathfinderRequest } from '@pathfinder/pathfinder';
import { queryUserKeys } from '#engine/federation/e2ee.ts';
export default async function (request: PathfinderRequest) {
  return await queryUserKeys(await parseJson(request));
}
