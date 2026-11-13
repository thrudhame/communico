import { parseJson } from '#engine/operation-body.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';
import { claimUserKeys } from '#engine/federation/e2ee.ts';
export default async function (request: PathfinderRequest) {
  return await claimUserKeys(await parseJson(request));
}
