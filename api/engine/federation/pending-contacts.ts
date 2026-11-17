import type { Database } from '#engine/store/db.ts';
import { lookupPeer, type PendingRow, recordPending } from './peers.ts';

type Batch = { count: number; detail: string };
type Writer = {
  pending?: Batch;
  task: Promise<void>;
  error?: { cause: unknown };
};

/** Application-owned operator diagnostics, not an authentication commit barrier.
 * An abrupt crash can lose every accepted contact still queued or in an
 * uncommitted flush (no fixed count bound). Orderly close drains them before
 * storage closes; failures remain owned and are reported by drain/close.
 * Business outcomes composed with a Conn must keep using recordPending directly.
 */
export class PendingContacts {
  private readonly writers = new Map<string, Writer>();
  private closing = false;
  private closed?: Promise<void>;

  constructor(
    private readonly server: Database,
    private readonly failed: (error: unknown) => void = (error) =>
      console.error('federation contact diagnostics:', error),
  ) {}

  record(name: string, kind: PendingRow['kind'], detail: string): void {
    if (this.closing) throw new Error('federation contact log is closing');
    const key = JSON.stringify([name, kind]);
    const active = this.writers.get(key);
    if (active !== undefined) {
      if (active.pending === undefined) active.pending = { count: 1, detail };
      else {
        active.pending.count++;
        active.pending.detail = detail;
      }
      return;
    }
    const writer: Writer = {
      pending: { count: 1, detail },
      task: Promise.resolve(),
    };
    this.writers.set(key, writer);
    // The owner retains and observes every flush, including its error. Only
    // diagnostic persistence runs here; signatures and request work never queue.
    writer.task = Promise.resolve().then(async () => {
      while (writer.pending !== undefined) {
        const batch = writer.pending;
        writer.pending = undefined;
        try {
          await this.server.tx(async (tx) => {
            // An approval completed while this diagnostic was queued removes
            // the knock. Do not recreate it from the earlier auth admission.
            if (
              (kind === 'inbound' || kind === 'outbound') &&
              await lookupPeer(tx, name) !== null
            ) return;
            await recordPending(
              tx,
              name,
              kind,
              true,
              batch.detail,
              batch.count,
            );
          });
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

  private retain(writer: Writer, batch: Batch): void {
    // Admission can append another batch while the failed flush awaits I/O.
    const following = writer.pending;
    writer.pending = {
      count: batch.count + (following === undefined ? 0 : following.count),
      detail: following === undefined ? batch.detail : following.detail,
    };
  }

  async drain(): Promise<void> {
    // Include contacts accepted while an earlier flush was running. Closing
    // stops admission first; a normal explicit drain includes overlapping work.
    while (this.writers.size > 0) {
      const writers = [...this.writers.values()];
      await Promise.all(writers.map((writer) => writer.task));
      const errors = writers.flatMap((writer) =>
        writer.error === undefined ? [] : [writer.error.cause]
      );
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          'federation contact diagnostics failed',
        );
      }
    }
  }

  close(): Promise<void> {
    this.closing = true;
    if (this.closed === undefined) this.closed = this.drain();
    return this.closed;
  }
}
