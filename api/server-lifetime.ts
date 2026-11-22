// One admission and transport lifetime, owned by main for every listener.
// Never call HttpServer.shutdown while an admitted request may read its body.
import { requestFailure } from '#engine/request-diagnostics.ts';
export class ServerLifetime {
  readonly controller = new AbortController();
  #operations = new AbortController();
  #draining = false;
  #cancelled = false;
  #active = new Map<string, number>();
  #idle = new Set<() => void>();
  #handlers = new Set<Promise<void>>();

  wrap<A extends Deno.Addr>(
    name: string,
    handler: Deno.ServeHandler<A>,
  ): Deno.ServeHandler<A> {
    return async (request, info) => {
      if (this.#draining) return this.#unavailable(name);
      this.#active.set(name, (this.#active.get(name) ?? 0) + 1);
      const handlerDone = Promise.withResolvers<void>();
      this.#handlers.add(handlerDone.promise);
      const disconnected = new AbortController();
      const signal = AbortSignal.any([
        request.signal,
        disconnected.signal,
        this.#operations.signal,
      ]);
      const operation = new Request(request, {
        signal,
        // Aborting a Request signal does not interrupt reads of an existing
        // body. The listener owns both cancellation paths, not each adapter.
        body: request.body?.pipeThrough(new TransformStream(), {
          signal,
          // Cancelling the native input also tears down its HTTP transport.
          // Retain it until the retryable response has been delivered.
          preventCancel: true,
        }),
      });
      let handled = false, delivered = false, released = false, children = 0;
      const release = () => {
        if (released || !handled || !delivered || children !== 0) return;
        released = true;
        this.#active.set(name, this.#active.get(name)! - 1);
        if (this.count === 0) { for (const idle of this.#idle) idle(); }
      };
      const own = (child: Promise<void>) => {
        children++;
        const settled = () => {
          children--;
          release();
        };
        child.then(settled, settled);
      };
      // A disconnected response is a completed transport, not an unhandled
      // rejection. Handler failures retain the server's normal error handling.
      info.completed.then(() => {
        delivered = true;
        release();
      }, (error) => {
        disconnected.abort(error);
        delivered = true;
        release();
      });
      try {
        const response = await handler(operation, info);
        if (this.#cancelled && signal.aborted) {
          // Adapters may render cancellation themselves (including a generic
          // 500). Shutdown owns its retryable wire outcome, for every listener.
          await response.body?.cancel();
          return this.#unavailable(name);
        }
        if (response.body === null) return response;
        // Handler completion is not response completion. Own returned streams
        // at this boundary too: an expired drain must interrupt a backpressured
        // download before transport settlement can release the store capability.
        const output = new TransformStream();
        // pipeThrough hides the pipe's settlement. A source's asynchronous
        // cancel callback can still own storage after its transport has ended.
        own(response.body.pipeTo(output.writable, { signal }));
        return new Response(output.readable, response);
      } catch (error) {
        if (this.#cancelled && signal.aborted) return this.#unavailable(name);
        // A router/materializer failure can escape its own outcome renderer.
        // Preserve correlation before Deno's final fallback turns it into 500.
        requestFailure(operation, error);
        throw error;
      } finally {
        handled = true;
        release();
        this.#handlers.delete(handlerDone.promise);
        handlerDone.resolve();
      }
    };
  }

  #unavailable(name: string): Response {
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

  get count(): number {
    return [...this.#active.values()].reduce((a, b) => a + b, 0);
  }

  abort(): void {
    this.#draining = true;
    this.#operations.abort();
    this.controller.abort();
  }

  async settled(): Promise<void> {
    if (this.count === 0) return;
    let idle!: () => void;
    try {
      await new Promise<void>((resolve) => {
        idle = resolve;
        this.#idle.add(idle);
      });
    } finally {
      this.#idle.delete(idle);
    }
  }

  async close(): Promise<void> {
    // The drain has stopped admission. Cancelled handlers finish their work
    // and render retryable responses before the listener loses its transports.
    // Delivery is NOT a prerequisite: an already-returned download may remain
    // backpressured forever when its client has stopped reading.
    await Promise.all(this.#handlers);
    if (this.#cancelled) this.controller.abort();
    await this.settled();
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
    if (this.count !== 0) {
      this.#cancelled = true;
      // close() waits for handler work, then aborts expired transports without
      // depending on response delivery. Fatal abort() closes them immediately.
      this.#operations.abort();
    }
    return remaining;
  }
}
