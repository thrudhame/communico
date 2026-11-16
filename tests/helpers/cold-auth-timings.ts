type Observation = {
  calls: number;
  elapsedMs: number;
  maxMs: number;
  status?: number;
  errcode?: string;
  transportError: boolean;
};

/** Test-only diagnostics. Request bodies, tokens and exception messages are
 * deliberately not retained; a successful fixture never prints this state. */
export class ColdAuthTimings {
  private phases: {
    name: string;
    started: number;
    elapsedMs?: number;
    requests: Record<string, Observation>;
  }[] = [];

  constructor(private now: () => number = () => performance.now()) {}

  phase(name: string) {
    const started = this.now();
    const prior = this.phases.at(-1);
    if (prior) prior.elapsedMs = started - prior.started;
    this.phases.push({ name, started, requests: {} });
  }

  async request<T extends { status: number; body: Record<string, unknown> }>(
    name: string,
    send: () => Promise<T>,
  ): Promise<T> {
    const phase = this.phases.at(-1);
    const start = this.now();
    let status: number | undefined, errcode: string | undefined;
    try {
      const result = await send();
      status = result.status;
      errcode = typeof result.body.errcode === 'string'
        ? result.body.errcode
        : undefined;
      return result;
    } finally {
      if (phase) {
        const elapsed = this.now() - start;
        const item = phase.requests[name] ??= {
          calls: 0,
          elapsedMs: 0,
          maxMs: 0,
          transportError: false,
        };
        item.calls++;
        item.elapsedMs += elapsed;
        item.maxMs = Math.max(item.maxMs, elapsed);
        item.status = status;
        item.errcode = errcode;
        item.transportError = status === undefined;
      }
    }
  }

  snapshot() {
    const now = this.now();
    return this.phases.map(({ name, started, elapsedMs, requests }) => ({
      name,
      elapsedMs: elapsedMs ?? now - started,
      complete: elapsedMs !== undefined,
      requests,
    }));
  }
}
