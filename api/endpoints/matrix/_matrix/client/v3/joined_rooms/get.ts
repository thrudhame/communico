import { joinedRooms } from '#engine/room.ts';

// GET /_matrix/client/v3/joined_rooms — {joined_rooms: [...]}.
export default async function (
  _request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  return { joined_rooms: await joinedRooms(context.state.user as string) };
}
