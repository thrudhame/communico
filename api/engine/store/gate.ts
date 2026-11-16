// api/engine/store/gate.ts — admission belongs to the file, including readers.
// The committing transaction releases its slot before waiting for the barrier.
import { type Row, StoreError } from '#engine/store/ffi.ts';
import { dirname } from '@std/path';
import { databaseFiles } from '#engine/store/layout.ts';

export type GateStats = {
  active: number;
  closed: boolean;
  checkpointing: boolean;
  transactions: number;
  commits: number;
  barriers: number;
  completed: number;
  exhausted: number;
  retries: number;
  pauseMs: number;
  lastLogBytes: number;
};

export class Gate extends EventTarget {
  private active = 0;
  private paused = false;
  private checkpointing = false;
  private retained = 0;
  private waiters: (() => void)[] = [];
  private drained?: () => void;
  private barrier?: Promise<void>;
  private readonly counters = {
    transactions: 0,
    commits: 0,
    barriers: 0,
    completed: 0,
    exhausted: 0,
    retries: 0,
    pauseMs: 0,
    lastLogBytes: 0,
  };

  constructor(
    readonly path: string,
    readonly threshold: number,
    private readonly checkpoint: (started: () => void) => Promise<Row[]>,
  ) {
    super();
    if (!Number.isSafeInteger(threshold) || threshold < 1) {
      throw new TypeError('checkpointlogbytes must be a positive safe integer');
    }
  }

  stats(): GateStats {
    return {
      ...this.counters,
      active: this.active,
      closed: this.paused,
      checkpointing: this.checkpointing,
    };
  }

  async enter(): Promise<void> {
    while (this.paused) {
      await new Promise<void>((wake) => this.waiters.push(wake));
    }
    this.active++;
    this.counters.transactions++;
  }

  // A backup snapshot prevents checkpoint initiation, not transaction admission.
  // Unlike an ordinary reader it must never make a committing writer wait for
  // the complete export. Native auto-checkpoint is disabled by the Db owner.
  async retain(): Promise<() => void> {
    while (this.paused) {
      await new Promise<void>((wake) => this.waiters.push(wake));
    }
    this.retained++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.retained--;
    };
  }

  async leave(committed: boolean): Promise<void> {
    if (this.active < 1) throw new Error('unbalanced file gate');
    this.active--;
    if (this.active === 0) {
      this.drained?.();
      this.drained = undefined;
    }
    if (!committed) return;
    this.counters.commits++;
    // Check every commit, including read-only ones: query SQL can return rows
    // while writing (RETURNING). No SQL-text guesses can bypass maintenance.
    if (this.retained) return;
    if (this.barrier) return await this.barrier;
    if (await this.logBytes() < this.threshold) return;
    // retain() can have acquired ownership while stat was in flight.
    if (this.retained) return;
    if (this.barrier) return await this.barrier;
    this.paused = true;
    this.barrier = this.maintain();
    await this.barrier;
  }

  private async logBytes(): Promise<number> {
    const path = databaseFiles(dirname(this.path)).log;
    try {
      return (await Deno.stat(path)).size;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new StoreError(
          14,
          `expected MVCC logical log missing: ${path}`,
          'Turso sidecar naming mismatch',
        );
      }
      throw error;
    }
  }

  private async maintain(): Promise<void> {
    const start = performance.now();
    this.counters.barriers++;
    this.dispatchEvent(new Event('barrier'));
    try {
      if (this.active) await new Promise<void>((wake) => this.drained = wake);
      for (let attempt = 0; attempt < 50; attempt++) {
        let busy = false;
        try {
          const rows = await this.checkpoint(() => {
            this.checkpointing = true;
            this.dispatchEvent(new Event('checkpoint'));
          });
          busy = rows.some((row) => Number(row.busy ?? 0) !== 0);
        } catch (error) {
          if (!(error instanceof StoreError) || !error.busy) throw error;
          busy = true;
        } finally {
          this.checkpointing = false;
          this.dispatchEvent(new Event('checkpointend'));
        }
        if (!busy) {
          this.counters.completed++;
          this.counters.lastLogBytes = await this.logBytes();
          return;
        }
        if (attempt < 49) {
          this.counters.retries++;
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(200, 5 * 2 ** Math.min(attempt, 6)))
          );
        }
      }
      this.counters.exhausted++;
    } finally {
      this.counters.pauseMs += performance.now() - start;
      this.paused = false;
      this.barrier = undefined;
      this.dispatchEvent(new Event('open'));
      for (const wake of this.waiters.splice(0)) wake();
    }
  }
}
