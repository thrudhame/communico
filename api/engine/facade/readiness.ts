import { MatrixError } from '#engine/matrix-error.ts';

/** A known dependency, not a generic retry on Matrix 503s. */
export class ReplicaCutPending extends MatrixError {
  constructor(
    readonly pairing: string,
    readonly stream: string,
    readonly needsHome: boolean,
  ) {
    super(503, 'M_UNAVAILABLE', 'replica unavailable');
  }
}

type DeliveryHealth = {
  canDeliver(pairing: string): boolean;
  onDeliveryLoss(pairing: string, wake: () => void): () => void;
};

/** Public admission waits outside storage transactions. Receive and apply
 * still own their cuts, and the operation must retain its normal commit fence. */
export class ReplicaReadiness {
  #revision = 0;
  readonly #waiting = new Set<{
    pairing: string;
    stream: string;
    wake: () => void;
  }>();
  readonly #closed = new AbortController();

  constructor(private readonly health: DeliveryHealth) {}

  applied(pairing: string, stream: string): void {
    this.#revision++;
    for (const waiter of this.#waiting) {
      if (waiter.pairing === pairing && waiter.stream === stream) waiter.wake();
    }
  }

  bindingChanged(): void {
    this.#revision++;
    for (const waiter of this.#waiting) waiter.wake();
  }

  close(): void {
    this.#closed.abort();
  }

  async wait<T>(read: () => Promise<T>, request: AbortSignal): Promise<T> {
    const signal = AbortSignal.any([request, this.#closed.signal]);
    while (true) {
      signal.throwIfAborted();
      const revision = this.#revision;
      try {
        const result = await read();
        signal.throwIfAborted();
        return result;
      } catch (error) {
        if (!(error instanceof ReplicaCutPending)) throw error;
        signal.throwIfAborted();
        // Completion or binding publication during the read must not be lost.
        if (revision !== this.#revision) continue;
        const { pairing, stream, needsHome } = error;
        if (needsHome && !this.health.canDeliver(pairing)) throw error;
        const { promise, resolve } = Promise.withResolvers<void>();
        const wake = () => resolve();
        const waiter = { pairing, stream, wake };
        this.#waiting.add(waiter);
        signal.addEventListener('abort', wake, { once: true });
        const off = needsHome
          ? this.health.onDeliveryLoss(pairing, wake)
          : null;
        try {
          await promise;
        } finally {
          off?.();
          signal.removeEventListener('abort', wake);
          this.#waiting.delete(waiter);
        }
      }
    }
  }
}
