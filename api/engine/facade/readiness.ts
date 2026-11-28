import { MatrixError } from '#engine/matrix-error.ts';

/** An earlier admission proof is no longer usable, not a delivery failure. */
export class ReplicaAdmissionSuperseded extends MatrixError {
  constructor() {
    super(503, 'M_UNAVAILABLE', 'replica unavailable');
  }
}

/** The attempt owns its locks and transactions. Re-enter preparation only
 * after it has unwound; readiness, not this loop, waits on delivery/apply. */
export async function retryReplicaAdmission<T>(
  signal: AbortSignal | undefined,
  attempt: () => Promise<T>,
): Promise<T> {
  while (true) {
    signal?.throwIfAborted();
    try {
      return await attempt();
    } catch (error) {
      if (!signal || !(error instanceof ReplicaAdmissionSuperseded)) {
        throw error;
      }
    }
  }
}

/** A known dependency, not a generic retry on Matrix 503s. */
export class ReplicaCutPending extends MatrixError {
  constructor(
    readonly pairing: string,
    readonly stream: string,
    readonly needsHome: boolean,
    readonly after?: number,
  ) {
    super(503, 'M_UNAVAILABLE', 'replica unavailable');
  }
}

type DeliveryHealth = {
  canDeliver(pairing: string): boolean;
  onDeliveryLoss(pairing: string, wake: () => void): () => void;
};

export type ObserveCut = (pairing: string, stream: string) => void;

const key = (pairing: string, stream: string) =>
  JSON.stringify([pairing, stream]);
const inventoryStream = (stream: string) =>
  /^(room:|membership:|auth:)/.test(stream);

/** Public admission waits outside storage transactions. Receive and apply
 * still own their cuts, and the operation must retain its normal commit fence. */
export class ReplicaReadiness {
  readonly #waiting = new Map<string, Set<() => void>>();
  readonly #bindings = new Set<() => void>();
  readonly #receiving = new Map<string, number>();
  readonly #refused = new Map<string, number>();
  readonly #closed = new AbortController();

  constructor(private readonly health: DeliveryHealth) {}

  #publish(id: string): void {
    for (const wake of this.#waiting.get(id) ?? []) wake();
  }

  #publishStream(pairing: string, stream: string): void {
    this.#publish(key(pairing, stream));
    if (inventoryStream(stream)) this.#publish(key(pairing, 'rooms'));
  }

  receiving(pairing: string, stream: string): () => void {
    const id = key(pairing, stream);
    const ids = inventoryStream(stream) ? [id, key(pairing, 'rooms')] : [id];
    for (const id of ids) {
      this.#receiving.set(id, (this.#receiving.get(id) ?? 0) + 1);
    }
    this.#publishStream(pairing, stream);
    return () => {
      for (const id of ids) {
        const left = this.#receiving.get(id)! - 1;
        if (left) this.#receiving.set(id, left);
        else this.#receiving.delete(id);
      }
      this.#publishStream(pairing, stream);
    };
  }

  applied(pairing: string, stream: string): void {
    const id = key(pairing, stream);
    this.#refused.delete(id);
    this.#publishStream(pairing, stream);
  }

  refused(pairing: string, stream: string, after: number): void {
    const id = key(pairing, stream);
    if (this.#refused.get(id) !== after) {
      this.#refused.set(id, after);
      this.#publish(id);
    }
  }

  bindingChanged(): void {
    this.#refused.clear();
    for (const wake of this.#bindings) wake();
  }

  close(): void {
    this.#closed.abort();
  }

  async wait<T>(
    read: (observe: ObserveCut) => Promise<T>,
    request: AbortSignal,
    remoteDeadline?: AbortSignal,
  ): Promise<T> {
    const signal = AbortSignal.any([request, this.#closed.signal]);
    while (true) {
      signal.throwIfAborted();
      const { promise, resolve } = Promise.withResolvers<void>();
      const observed = new Set<string>();
      let changed = false;
      const wake = () => {
        changed = true;
        resolve();
      };
      const observe: ObserveCut = (pairing, stream) => {
        const id = key(pairing, stream);
        if (observed.has(id)) return;
        observed.add(id);
        const waiters = this.#waiting.get(id) ?? new Set();
        waiters.add(wake);
        this.#waiting.set(id, waiters);
      };
      const receiving = () =>
        [...observed].some((id) => this.#receiving.has(id));
      this.#bindings.add(wake);
      signal.addEventListener('abort', wake, { once: true });
      let off: (() => void) | undefined;
      try {
        const outcome = await read(observe).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        signal.throwIfAborted();
        // The read can race either publication (for success or refusal) or
        // a receive that makes a missing cut locally durable before link loss.
        if (changed) continue;
        if (!receiving()) {
          if (outcome.ok) return outcome.value;
          const { error } = outcome;
          if (error instanceof ReplicaAdmissionSuperseded) continue;
          if (!(error instanceof ReplicaCutPending)) throw error;
          const { pairing, stream, needsHome, after } = error;
          observe(pairing, stream);
          if (
            after !== undefined &&
            this.#refused.get(key(pairing, stream)) === after
          ) {
            throw error;
          }
          if (needsHome && !receiving()) {
            if (remoteDeadline?.aborted || !this.health.canDeliver(pairing)) {
              throw error;
            }
            const delivery = this.health.onDeliveryLoss(pairing, wake);
            remoteDeadline?.addEventListener('abort', wake, { once: true });
            off = () => {
              delivery();
              remoteDeadline?.removeEventListener('abort', wake);
            };
          }
        }
        await promise;
      } finally {
        off?.();
        signal.removeEventListener('abort', wake);
        this.#bindings.delete(wake);
        for (const id of observed) {
          const waiters = this.#waiting.get(id)!;
          waiters.delete(wake);
          if (!waiters.size) this.#waiting.delete(id);
        }
      }
    }
  }
}
