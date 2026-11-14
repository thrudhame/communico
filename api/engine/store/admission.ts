// Common storage admission. Higher-level operations may stop between commits,
// exactly as at a crash; no transaction or file lifecycle can cross the cut.
export class Admission {
  private paused = false;
  private active = 0;
  private waiters: (() => void)[] = [];
  private drained: (() => void)[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.paused) {
      await new Promise<void>((wake) => this.waiters.push(wake));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      if (this.active === 0) {
        for (const wake of this.drained.splice(0)) wake();
      }
    }
  }

  // Pause duration is observed, not capped. Await actual maintenance cleanup
  // before reopening admission, including when the snapshot fails.
  exclusive<T>(
    fn: () => Promise<T>,
  ): Promise<{ value: T; pauseMs: number }> {
    const result = this.queue.then(async () => {
      this.paused = true;
      const started = performance.now();
      try {
        if (this.active) {
          await new Promise<void>((resolve) => {
            this.drained.push(resolve);
          });
        }
        const value = await fn();
        return { value, pauseMs: performance.now() - started };
      } finally {
        this.paused = false;
        for (const wake of this.waiters.splice(0)) wake();
      }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}
