// tests/store-crash.test.ts — SIGKILL recovery. A child writes under barrier
// pressure and is killed 30 times: 20 at random moments (at least five while
// a barrier checkpoint runs) and ten aimed at 10%…100% of the measured
// checkpoint duration, so the crash window inside the checkpoint is covered.
// After every kill the reopened store must pass integrity_check and hold
// every row the child reported committed.
import { assert, assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { integrityCheck } from '#engine/store/create.ts';
import { runCrashChild } from './crash-child.ts';

const CHILD = new URL('./fixtures/store-crash-child.ts', import.meta.url)
  .pathname;
const LIBRARY = './.native/libturso_ffi.so';

type ChildEvent = { row?: number; barrier?: 'start' | 'end' };

Deno.test('store crash: 30 SIGKILLs, reopen passes integrity and keeps every reported row', async () => {
  const dir = await Deno.makeTempDir();
  const reported = new Set<number>();
  const durations: number[] = [];
  let barrierKills = 0;
  let aimedKills = 0;
  const kills: {
    iteration: number;
    mode: string;
    duringBarrier: boolean;
    rows: number;
  }[] = [];

  function medianDuration(): number {
    const sorted = [...durations].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  // One child, one kill. In 'aimed' mode the kill fires fraction × the
  // measured checkpoint duration after a barrier starts, cancelled if the
  // barrier ends first; otherwise the kill fires at the deadline.
  async function killOnce(
    iteration: number,
    mode: 'measure' | 'random' | 'aimed',
    deadlineMs: number,
    fraction = 0,
    killOnBarrierStart = false,
  ): Promise<void> {
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--allow-read',
        '--allow-write',
        '--allow-env',
        '--allow-ffi',
        CHILD,
        dir,
        LIBRARY,
      ],
      stdout: 'piped',
      stderr: 'piped',
    });
    let barrierOpen = false;
    let barrierStartedAt = 0;
    let duringBarrier = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let targetFired = false;
    const result = await runCrashChild<ChildEvent>(command, {
      deadlineMs,
      deadlineReason: mode === 'random' && !killOnBarrierStart
        ? 'sample'
        : 'watchdog',
      onEvent(event, stop) {
        if (event.row !== undefined) reported.add(event.row);
        if (targetFired) return;
        const now = performance.now();
        if (event.barrier === 'start') {
          barrierOpen = true;
          barrierStartedAt = now;
          if (mode === 'aimed') {
            killTimer = setTimeout(() => {
              duringBarrier = barrierOpen;
              targetFired = true;
              stop('checkpoint');
            }, Math.max(1, medianDuration() * fraction));
          }
        }
        if (event.barrier === 'end') {
          barrierOpen = false;
          if (barrierStartedAt !== 0) durations.push(now - barrierStartedAt);
          barrierStartedAt = 0;
          clearTimeout(killTimer);
          killTimer = undefined;
        }
        const measured = mode === 'measure' && durations.length >= 5;
        const barrierTarget = killOnBarrierStart && event.barrier === 'start';
        if (mode !== 'aimed' && (measured || barrierTarget)) {
          duringBarrier = barrierOpen;
          targetFired = true;
          stop(barrierTarget ? 'checkpoint' : 'sample');
        }
      },
    }).finally(() => clearTimeout(killTimer));
    assertEquals(result.status.signal, 'SIGKILL', 'child must die by SIGKILL');
    assert(
      result.reason !== 'watchdog',
      'crash child exceeded its lifetime without reaching the target',
    );
    if (mode === 'aimed') {
      assertEquals(
        result.reason,
        'checkpoint',
        'watchdog kills are not aimed hits',
      );
      assert(duringBarrier, 'aimed kill missed its window');
    }
    kills.push({ iteration, mode, duringBarrier, rows: reported.size });
    // Reopen with the store: open, integrity, and every reported row.
    const store = await openStore({
      dir,
      library: LIBRARY,
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    });
    try {
      const db = await store.room('!crash:test');
      await integrityCheck(db);
      const rows = await db.query('SELECT id FROM rows');
      const present = new Set(rows.map((row) => row.id));
      const missing = [...reported].filter((id) => !present.has(id));
      assertEquals(
        missing,
        [],
        `kill ${iteration}: ${missing.length} reported rows lost`,
      );
    } finally {
      await store.close();
    }
  }

  try {
    // Measure a few checkpoint durations first, then 19 random kills (at
    // least five while a barrier runs), then ten aimed across the duration.
    await killOnce(0, 'measure', 60000);
    barrierKills += kills[0].duringBarrier ? 1 : 0;
    for (let iteration = 1; iteration < 20; iteration++) {
      const wantBarrier = barrierKills < 5;
      await killOnce(
        iteration,
        'random',
        wantBarrier ? 30000 : 400 + Math.random() * 800,
        0,
        wantBarrier,
      );
      if (kills[iteration].duringBarrier) barrierKills++;
    }
    assert(
      barrierKills >= 5,
      `only ${barrierKills} kills landed during a checkpoint barrier`,
    );
    for (let step = 1; step <= 10; step++) {
      await killOnce(19 + step, 'aimed', 60000, step / 10);
      aimedKills++;
    }
    console.log(JSON.stringify({
      kills: kills.length,
      barrierKills,
      aimedKills,
      medianCheckpointMs: medianDuration(),
      reportedRows: reported.size,
      missing: 0,
    }));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
