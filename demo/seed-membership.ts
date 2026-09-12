// demo/seed-membership.ts — F0 demo helper: invite + join the demo users
// through the engine pipeline (author + ingest: signed, depth-linked,
// stub-authorized). The CS invite/join endpoints are M4 (30rooms) scope;
// the demo room is invite-only (v11 genesis), so seeds arrive this way.
// Run (inside the container): deno run --env --allow-net --allow-env --allow-read demo/seed-membership.ts <roomId>
import { author, ingestEvent } from '#engine/ingest.ts';
import { lookupRoom } from '#engine/room.ts';

const roomId = Deno.args[0];
if (!roomId) {
  console.error('usage: seed-membership.ts <roomId>');
  Deno.exit(2);
}
const room = await lookupRoom(roomId);
if (!room) throw new Error('room not found: ' + roomId);

const CREATOR = '@dev:localhost';
for (const user of ['@alice:localhost', '@bob:localhost']) {
  const invite = await author(roomId, {
    type: 'm.room.member',
    state_key: user,
    sender: CREATOR,
    content: { membership: 'invite' },
    origin_server_ts: Date.now(),
  });
  await ingestEvent(roomId, invite);
  const join = await author(roomId, {
    type: 'm.room.member',
    state_key: user,
    sender: user,
    content: { membership: 'join' },
    origin_server_ts: Date.now(),
  });
  await ingestEvent(roomId, join);
  console.log(`seeded membership: ${user} invited + joined ${roomId}`);
}
