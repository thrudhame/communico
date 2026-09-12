import { HttpError } from '@pathfinder/pathfinder';
import type { PathfinderRequest } from '@pathfinder/pathfinder';
import { attachSocket } from '#hats/lite/peer.ts';

// GET /msync?room= — lite hat (design §4.4): browser peers join rooms over
// msync/ws. Was a raw Deno.upgradeWebSocket intercept in main.ts; now a
// pathfinder handler via request.upgrade(). Served at the ROOT of the
// :8000 listener (the lite client hardcodes /msync in
// lite/web/sync/transport.js); folding it under _communico is deferred.
export default function (request: PathfinderRequest) {
  const roomId = request.query.get('room');
  if (!roomId) throw new HttpError(400, 'missing ?room=');
  const { response, socket } = request.upgrade();
  socket.then((ws) => attachSocket(roomId, ws));
  return response;
}
