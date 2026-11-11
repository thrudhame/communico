// tests/server-crash.test.ts — SIGKILL during projection batches: ten
// kills at random moments while the child writes and projects. After
// every kill the reopened store's startup roll-forward must leave every
// room's watermark at its last change position, with no duplicate seq or
// outbox rows (the (room, pos) / (room, pos, destination) keys and the
// watermark-in-the-same-transaction make the replay a no-op).
import { assert, assertEquals } from '@std/assert';
import { roomSchema } from '#engine/room/index.ts';
import { sourceOf } from '#engine/server/project.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import { integrityCheck } from '#engine/store/create.ts';
import { get } from '#engine/store/watermark.ts';
import { openStore } from '#engine/store/index.ts';
import { runCrashChild } from './crash-child.ts';

installServerHooks();

const CHILD = new URL('./fixtures/server-crash-child.ts', import.meta.url)
  .pathname;
const LIBRARY = './.native/libturso_ffi.so';
const ROOM = '!pc:test';
type ChildEvent = { projected?: number };

Deno.test('server crash: 10 SIGKILLs during projection — watermark at the last pos, no duplicates', async () => {
  const dir = await Deno.makeTempDir();
  const kills: { iteration: number; reported: number }[] = [];

  async function killOnce(
    iteration: number,
    deadlineMs: number,
  ): Promise<void> {
    let reported = 0;
    let sampleTimer: ReturnType<typeof setTimeout> | undefined;
    const result = await runCrashChild<ChildEvent>(
      new Deno.Command(Deno.execPath(), {
        args: [
          'run',
          '--allow-read',
          '--allow-write',
          '--allow-env',
          '--allow-ffi',
          CHILD,
          'loop',
          dir,
          LIBRARY,
        ],
        stdout: 'piped',
        stderr: 'piped',
      }),
      {
        // One lifetime bounds startup and sampling. Sample only after the
        // first real projection, not while the child is still booting.
        deadlineMs: 60000,
        onEvent(event, stop) {
          if (event.projected !== undefined) {
            reported = event.projected;
            sampleTimer ??= setTimeout(() => stop('sample'), deadlineMs);
          }
        },
      },
    ).finally(() => clearTimeout(sampleTimer));
    assertEquals(result.status.signal, 'SIGKILL', 'child must die by SIGKILL');
    assertEquals(result.reason, 'sample', result.stderr);
    kills.push({ iteration, reported });

    // Reopen with the hooks installed: the startup roll-forward completes
    // whatever the kill interrupted.
    const store = await openStore({
      dir,
      library: LIBRARY,
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, {
      schemas: { room: roomSchema, server: serverSchema },
    });
    try {
      const server = await store.server();
      await integrityCheck(server);
      // the watermark equals the room's last change position
      const room = await store.room(ROOM);
      const last = await room.tx(async (tx) => {
        const rows = await tx.query(
          'SELECT pos FROM changes ORDER BY pos DESC LIMIT 1',
        );
        return Number(rows[0].pos);
      });
      assertEquals(
        await get(server, sourceOf(ROOM)),
        last,
        `kill ${iteration}: watermark behind the room`,
      );
      // no duplicate feed rows, seqs or events
      const dupes = await server.query(
        `SELECT COUNT(*) AS n, COUNT(DISTINCT seq) AS seqs,
                COUNT(DISTINCT room || ':' || pos) AS positions,
                COUNT(DISTINCT event) AS events
         FROM feed`,
      );
      assertEquals(
        Number(dupes[0].n),
        Number(dupes[0].seqs),
        `kill ${iteration}: duplicate seq`,
      );
      assertEquals(
        Number(dupes[0].n),
        Number(dupes[0].positions),
        `kill ${iteration}: duplicate (room, pos)`,
      );
      assertEquals(
        Number(dupes[0].n),
        Number(dupes[0].events),
        `kill ${iteration}: duplicate event`,
      );
      // per-room the seq follows the change positions
      const ordered = await server.query(
        `SELECT seq, pos FROM feed WHERE room = ? ORDER BY seq`,
        [ROOM],
      );
      for (let i = 1; i < ordered.length; i++) {
        assert(
          Number(ordered[i].pos) > Number(ordered[i - 1].pos),
          `kill ${iteration}: pos order broken at seq ${ordered[i].seq}`,
        );
      }
      // the feed holds exactly the room's live accepted changes
      const accepted = await room.tx(async (tx) => {
        const rows = await tx.query(
          `SELECT data FROM changes WHERE kind IN ('event', 'transition')`,
        );
        let live = 0;
        for (const row of rows) {
          const data = JSON.parse(String(row.data)) as {
            standing: string;
            stay: number | null;
          };
          if (data.standing === 'accepted' && data.stay !== null) live++;
        }
        return live;
      });
      assertEquals(
        ordered.length,
        accepted,
        `kill ${iteration}: feed count ${ordered.length} != live changes ${accepted}`,
      );
      // no duplicate outbox obligations
      const outbox = await server.query(
        `SELECT COUNT(*) AS n,
                COUNT(DISTINCT room || ':' || pos || ':' || destination) AS obligations
         FROM outbox`,
      );
      assertEquals(
        Number(outbox[0].n),
        Number(outbox[0].obligations),
        `kill ${iteration}: duplicate outbox rows`,
      );
    } finally {
      await store.close();
    }
  }

  try {
    for (let iteration = 0; iteration < 10; iteration++) {
      await killOnce(iteration, 500 + Math.floor(Math.random() * 2500));
    }
    const reportedTotal = kills[kills.length - 1].reported;
    assert(
      reportedTotal >= 20,
      `the child projected ${reportedTotal} messages across 10 kills — too little work to prove the window`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
