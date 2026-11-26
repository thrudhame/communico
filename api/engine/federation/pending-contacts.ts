import type { Database } from '#engine/store/db.ts';
import { isStoragePressure, StorageBusyError } from '#engine/store/pressure.ts';
import { lookupPeer, type PendingRow, recordPending } from './peers.ts';

type Writer<T> = {
  pending?: T;
  task: Promise<void>;
  error?: { cause: unknown };
};

/** Application-owned operator diagnostics, not an authentication commit barrier.
 * An abrupt crash can lose every accepted contact still queued or in an
 * uncommitted flush (no fixed count bound). Orderly close drains them before
 * storage closes. Non-storage failures are reported by drain/close; storage
 * refusal is reported but must not turn diagnostic work into a shutdown error.
 * The injected merge preserves the caller's facts; only persistence queues.
 * Business outcomes must keep their own durable transaction barriers.
 */
export class ContactObservations<T> {
  private readonly writers = new Map<string, Writer<T>>();
  private closing = false;
  private closed?: Promise<void>;
  private readonly closingSignal = Promise.withResolvers<void>();

  constructor(
    private readonly persist: (key: string, batch: T) => Promise<void>,
    private readonly merge: (earlier: T, later: T) => T,
    private readonly failed: (error: unknown) => void = (error) =>
      console.error('contact diagnostics:', error),
  ) {}

  observe(key: string, observation: T): void {
    if (this.closing) throw new Error('contact log is closing');
    const active = this.writers.get(key);
    if (active !== undefined) {
      active.pending = active.pending === undefined
        ? observation
        : this.merge(active.pending, observation);
      if (
        active.error === undefined || !isStoragePressure(active.error.cause)
      ) {
        return;
      }
      // Renew deferred diagnostics when another observation arrives after a
      // real storage refusal. The original batch is still owned by this writer.
      active.error = undefined;
    }
    const writer: Writer<T> = active == null
      ? {
        pending: observation,
        task: Promise.resolve(),
      }
      : active;
    this.writers.set(key, writer);
    // The owner retains and observes every flush, including its error. Only
    // diagnostic persistence runs here; signatures and request work never queue.
    writer.task = Promise.resolve().then(async () => {
      while (writer.pending !== undefined) {
        const batch = writer.pending;
        writer.pending = undefined;
        try {
          await this.persistWhenAvailable(key, batch);
        } catch (cause) {
          this.retain(writer, batch);
          writer.error = { cause };
          try {
            this.failed(cause);
          } catch (report) {
            writer.error = {
              cause: new AggregateError(
                [cause, report],
                'contact diagnostics and reporting failed',
              ),
            };
          }
          return;
        }
      }
      this.writers.delete(key);
    });
  }

  private async persistWhenAvailable(key: string, batch: T): Promise<void> {
    for (;;) {
      try {
        return await this.persist(key, batch);
      } catch (cause) {
        // persist has already left its failed transaction before we wait.
        if (!(cause instanceof StorageBusyError) || this.closing) throw cause;
        await Promise.race([cause.released, this.closingSignal.promise]);
        if (this.closing) throw cause;
      }
    }
  }

  private retain(writer: Writer<T>, batch: T): void {
    // Admission can append another batch while the failed flush awaits I/O.
    const following = writer.pending;
    writer.pending = following === undefined
      ? batch
      : this.merge(batch, following);
  }

  async drain(): Promise<void> {
    await this.flush(false);
  }

  private async flush(closing: boolean): Promise<void> {
    // Include contacts accepted while an earlier flush was running. Closing
    // stops admission first; a normal explicit drain includes overlapping work.
    while (this.writers.size > 0) {
      const writers = [...this.writers.values()];
      await Promise.all(writers.map((writer) => writer.task));
      const errors = writers.flatMap((writer) =>
        writer.error === undefined ? [] : [writer.error.cause]
      );
      const failures = closing
        ? errors.filter((error) => !isStoragePressure(error))
        : errors;
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          'contact diagnostics failed',
        );
      }
      if (closing) return;
    }
  }

  close(): Promise<void> {
    this.closing = true;
    this.closingSignal.resolve();
    if (this.closed === undefined) this.closed = this.flush(true);
    return this.closed;
  }
}

type Batch = {
  name: string;
  kind: PendingRow['kind'];
  count: number;
  detail: string;
};

/** Federation's diagnostic facts use the same lifetime/coalescing owner as
 * facade contact timestamps. Authentication and request outcomes never queue. */
export class PendingContacts extends ContactObservations<Batch> {
  constructor(
    server: Database,
    failed: (error: unknown) => void = (error) =>
      console.error('federation contact diagnostics:', error),
  ) {
    super(
      (_key, batch) =>
        server.tx(async (tx) => {
          // An approval completed while this diagnostic was queued removes the
          // knock. Do not recreate it from the earlier auth admission.
          if (
            (batch.kind === 'inbound' || batch.kind === 'outbound') &&
            await lookupPeer(tx, batch.name) !== null
          ) return;
          await recordPending(
            tx,
            batch.name,
            batch.kind,
            true,
            batch.detail,
            batch.count,
          );
        }),
      (earlier, later) => ({ ...later, count: earlier.count + later.count }),
      failed,
    );
  }

  record(name: string, kind: PendingRow['kind'], detail: string): void {
    this.observe(JSON.stringify([name, kind]), {
      name,
      kind,
      count: 1,
      detail,
    });
  }
}
