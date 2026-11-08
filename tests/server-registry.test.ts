// tests/server-registry.test.ts — the room registry: registration on room
// creation (room-first), startup discovery for the crash window between
// create and registry, and the startup roll-forward for the window
// between a room write and its projection.
import { assert, assertEquals } from '@std/assert';
import { createRoom } from '#engine/room/create.ts';
import { roomSchema } from '#engine/room/index.ts';
import { sourceOf } from '#engine/server/project.ts';
import { listRooms } from '#engine/server/registry.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import { keyFor } from '#engine/store/layout.ts';
import { get } from '#engine/store/watermark.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { testSigner } from './fixtures/signer.ts';

// The whole stage's hooks: the registration/projection wiring and the
// startup roll-forward. Once, process-wide, before any openStore.
installServerHooks();

const CHILD = new URL('./fixtures/server-crash-child.ts', import.meta.url)
  .pathname;
const LIBRARY = './.native/libturso_ffi.so';

const config = (dir: string) => ({
  dir,
  library: LIBRARY,
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

async function withStore(
  dir: string,
  fn: (store: Store) => Promise<void>,
): Promise<void> {
  const store = await openStore(config(dir), {
    schemas: { room: roomSchema, server: serverSchema },
  });
  try {
    await fn(store);
  } finally {
    await store.close();
  }
}

async function runChild(mode: string, dir: string): Promise<void> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--allow-read',
      '--allow-write',
      '--allow-env',
      '--allow-ffi',
      CHILD,
      mode,
      dir,
      LIBRARY,
    ],
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const status = await child.status;
  const stderr = await new Response(child.stderr).text();
  assertEquals(status.code, 0, `child ${mode} failed: ${stderr}`);
}

Deno.test('registry: createRoom registers the room (room-first)', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withStore(dir, async (store) => {
      const signer = await testSigner();
      const created = await createRoom(store, {
        creator: '@dev:' + signer.serverName,
      }, signer);
      const rows = await (await store.server()).query(
        'SELECT room_id, file_key FROM rooms WHERE room_id = ?',
        [created.roomId],
      );
      assertEquals(rows.length, 1);
      assertEquals(rows[0].file_key, await keyFor(created.roomId));
      assertEquals(await listRooms(store), [created.roomId]);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('registry: a room created without the hooks is discovered and rolled forward at startup', async () => {
  const dir = await Deno.makeTempDir();
  try {
    // the child creates the room with no hooks installed — the crash
    // window between the room create and the registry insert
    await runChild('create', dir);
    await withStore(dir, async (store) => {
      // the startup hook already ran: discovery registered the room and
      // the roll-forward projected its create + creator join
      const registered = await listRooms(store);
      assertEquals(registered.length, 1);
      const roomId = registered[0];
      const server = await store.server();
      // the room's createRoom sequence (create, join, power_levels,
      // join_rules, history_visibility) projected
      const feed = await server.query(
        'SELECT event FROM feed WHERE room = ? ORDER BY seq',
        [roomId],
      );
      assertEquals(feed.length, 5);
      const room = await store.room(roomId);
      const last = await room.tx(async (tx) => {
        const rows = await tx.query(
          'SELECT pos FROM changes ORDER BY pos DESC LIMIT 1',
        );
        return Number(rows[0].pos);
      });
      assertEquals(await get(server, sourceOf(roomId)), last);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('registry: a room written without projection rolls forward at startup', async () => {
  const dir = await Deno.makeTempDir();
  try {
    // the child writes genesis + a remote member + five messages with no
    // projection — the crash window between the room write and project()
    await runChild('write', dir);
    await withStore(dir, async (store) => {
      const server = await store.server();
      const roomId = '!pc:test';
      // the feed: 5 genesis + the join + 5 messages
      const feed = await server.query(
        'SELECT seq, pos, event FROM feed WHERE room = ? ORDER BY seq',
        [roomId],
      );
      assertEquals(feed.length, 11);
      for (let i = 1; i < feed.length; i++) {
        assert(Number(feed[i].seq) > Number(feed[i - 1].seq));
        assert(Number(feed[i].pos) > Number(feed[i - 1].pos));
      }
      // the join's delivery intent reached the outbox
      const outbox = await server.query(
        'SELECT destination, event FROM outbox WHERE room = ?',
        [roomId],
      );
      assert(outbox.length >= 1, 'the remote member is owed delivery');
      assertEquals(outbox[0].destination, 'remote.test');
      // the messages are searchable; the membership index has bob's join
      assertEquals(
        (await server.query('SELECT COUNT(*) AS n FROM search WHERE room = ?', [
          roomId,
        ]))[0].n,
        5,
      );
      const bob = await server.query(
        `SELECT membership FROM memberships WHERE room = ? AND user = '@bob:remote.test'`,
        [roomId],
      );
      assertEquals(bob.length, 1);
      assertEquals(bob[0].membership, 'join');
      // the watermark stands at the room's last change position
      const room = await store.room(roomId);
      const last = await room.tx(async (tx) => {
        const rows = await tx.query(
          'SELECT pos FROM changes ORDER BY pos DESC LIMIT 1',
        );
        return Number(rows[0].pos);
      });
      assertEquals(await get(server, sourceOf(roomId)), last);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
