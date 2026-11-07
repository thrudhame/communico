// One admission and transport lifetime, owned by main for every listener.
// Never call HttpServer.shutdown while an admitted request may read its body.
export class ServerLifetime {
  readonly controller = new AbortController();
  #draining = false;
  #active = new Map<string, number>();
  #idle = new Set<() => void>();

  wrap<A extends Deno.Addr>(
    name: string,
    handler: Deno.ServeHandler<A>,
  ): Deno.ServeHandler<A> {
    return async (request, info) => {
      if (this.#draining) {
        return Response.json(
          name === 'admin'
            ? {
              ok: false,
              error: { code: 'UNAVAILABLE', message: 'server draining' },
            }
            : { errcode: 'M_UNKNOWN', error: 'server draining' },
          { status: 503, headers: { connection: 'close' } },
        );
      }
      this.#active.set(name, (this.#active.get(name) ?? 0) + 1);
      let handled = false, delivered = false;
      const release = () => {
        if (!handled || !delivered) return;
        this.#active.set(name, this.#active.get(name)! - 1);
        if (this.count === 0) { for (const idle of this.#idle) idle(); }
      };
      // A disconnected response is a completed transport, not an unhandled
      // rejection. Handler failures retain the server's normal error handling.
      info.completed.then(() => {
        delivered = true;
        release();
      }, () => {
        delivered = true;
        release();
      });
      try {
        return await handler(request, info);
      } finally {
        handled = true;
        release();
      }
    };
  }

  get count(): number {
    return [...this.#active.values()].reduce((a, b) => a + b, 0);
  }

  async drain(seconds: number): Promise<Record<string, number>> {
    this.#draining = true;
    if (this.count !== 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let idle!: () => void;
      try {
        await new Promise<void>((resolve) => {
          idle = resolve;
          this.#idle.add(idle);
          timer = setTimeout(resolve, seconds * 1000);
        });
      } finally {
        clearTimeout(timer);
        this.#idle.delete(idle);
      }
    }
    const remaining = Object.fromEntries(
      [...this.#active].filter(([, count]) => count !== 0),
    );
    if (this.count !== 0) this.controller.abort();
    return remaining;
  }
}
