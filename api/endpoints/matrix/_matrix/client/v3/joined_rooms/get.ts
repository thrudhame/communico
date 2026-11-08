import { joinedRooms } from '#engine/client/membership.ts';
export default async function (
  _request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  return { joined_rooms: await joinedRooms(context.state.user as string) };
}
