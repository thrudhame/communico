// Shared HTTP adapter for stable and historical room-summary spellings.
import type { PathfinderRequest } from '@pathfinder/pathfinder';
import { authorize } from '#engine/auth-context.ts';
import { roomSummary } from './discovery.ts';

export default async function (request: PathfinderRequest) {
  const authenticated = request.headers.has('Authorization') ||
    request.query.has('access_token');
  const user = authenticated ? await authorize(request) : null;
  return await roomSummary(
    request.params.roomIdOrAlias as string,
    user,
    request.query.getAll('via'),
  );
}
