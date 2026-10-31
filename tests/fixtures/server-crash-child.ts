// tests/fixtures/server-crash-child.ts — the server-stage kill target and
// crash-window writer, in three modes. The child NEVER installs the
// server hooks: nothing projects or registers on its own; the parent
// reopens with the hooks installed and the startup roll-forward must
// complete whatever the crash interrupted.
//   loop <dir> <library>   — genesis + a remote member, then batches of
//                            20 messages each followed by project();
//                            reports every projected batch on stdout.
//   write <dir> <library>  — genesis + messages with NO projection (the
//                            crash window between room write and
//                            projection), then exit.
//   create <dir> <library> — createRoom with NO hooks (the crash window
//                            between room create and registry), then exit.
import { genesis } from './genesis.ts';
import { createRoom } from '#engine/room/create.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { type Room, roomSchema } from '#engine/room/index.ts';
import { openRoom } from '#engine/room/index.ts';
import { testSigner } from './signer.ts';
import type { Signer } from '#engine/room/signer.ts';
import { project } from '#engine/server/project.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';

const [mode, dir, library] = Deno.args;
const store = await openStore({
  dir,
  library,
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
}, {
  schemas: { room: roomSchema, server: serverSchema },
});

const roomId = '!pc:test';

// The genesis fixture cannot re-run on an existing room (its stay
// creation is one-shot): resume the handle when the file is already
// there.
async function resume(): Promise<
  { room: Room; signer: Signer; creator: string }
> {
  const signer = await testSigner();
  return {
    room: await openRoom(store, roomId),
    signer,
    creator: '@dev:' + signer.serverName,
  };
}

if (mode === 'write') {
  const g = await genesis(store, { roomId, joinRule: 'public' });
  await sendLocal(g.room, {
    type: 'm.room.member',
    sender: '@bob:remote.test',
    state_key: '@bob:remote.test',
    content: { membership: 'join' },
    origin_server_ts: 1000,
  }, g.signer);
  for (let i = 0; i < 5; i++) {
    await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { msgtype: 'm.text', body: `unprojected ${i}` },
      origin_server_ts: 1010 + i,
    }, g.signer);
  }
  console.log(JSON.stringify({ wrote: 5 }));
  await store.close();
} else if (mode === 'create') {
  const signer = await testSigner();
  const created = await createRoom(store, {
    creator: '@dev:' + signer.serverName,
    visibility: 'public',
  }, signer);
  console.log(JSON.stringify({ created: created.roomId }));
  await store.close();
} else if (mode === 'loop') {
  let g: { room: Room; signer: Signer; creator: string };
  try {
    g = await resume();
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    const made = await genesis(store, { roomId, joinRule: 'public' });
    await sendLocal(made.room, {
      type: 'm.room.member',
      sender: '@bob:remote.test',
      state_key: '@bob:remote.test',
      content: { membership: 'join' },
      origin_server_ts: 1000,
    }, made.signer);
    g = { room: made.room, signer: made.signer, creator: made.creator };
  }
  let i = 0;
  for (;;) {
    for (let j = 0; j < 20; j++) {
      i++;
      await sendLocal(g.room, {
        type: 'm.room.message',
        sender: g.creator,
        content: { msgtype: 'm.text', body: `crash message ${i}` },
        origin_server_ts: 2000 + i,
      }, g.signer);
    }
    await project(store, roomId);
    console.log(JSON.stringify({ projected: i }));
  }
} else {
  throw new Error(`unknown mode ${mode}`);
}
