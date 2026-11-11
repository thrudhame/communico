// Shared stream hints schedule a fresh capture; only the consumer decides
// relevance. No database transaction or acknowledgment is held while waiting.
import type { Store } from '#engine/store/index.ts';
import type { Database } from '#engine/store/db.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { onProjected } from '#engine/server/project.ts';
import { onEventStream } from '#engine/server/stream.ts';
import { onTenantStream } from '#engine/tenant/streams.ts';
import { onEphemeral } from '#engine/server/ephemeral.ts';
import { onTypingChange } from '#engine/typing.ts';

export async function waitForSync<T>(
  owner: { store: Store; server: Database; tenant: Tenant },
  options: { timeoutMs: number; signal?: AbortSignal },
  capture: () => Promise<{ relevant: boolean; value: T }>,
): Promise<T> {
  const { signal } = options;
  const deadline = Date.now() + Math.min(30000, Math.max(0, options.timeoutMs));
  while (true) {
    signal?.throwIfAborted();
    let wake!: () => void;
    const changed = new Promise<void>((resolve) => {
      wake = resolve;
    });
    // Register before any snapshot read so a commit during capture is retained.
    const removers = [
      onTypingChange(wake),
      onEphemeral((server) => {
        if (server.path === owner.server.path) wake();
      }),
      onProjected((store) => {
        if (store === owner.store) wake();
      }),
      onEventStream((path) => {
        if (path === owner.server.path) wake();
      }),
      onTenantStream((store, tenant) => {
        if (store === owner.store && tenant === owner.tenant.serverName) wake();
      }),
    ];
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const abort = () => {
      wake();
      rejectAbort(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    // Typing expiry has no durable writer notification. The same bounded sweep
    // cadence as ordinary sync keeps expiry visible without a separate daemon.
    const timer = setTimeout(
      wake,
      Math.min(500, Math.max(0, deadline - Date.now())),
    );
    try {
      signal?.throwIfAborted();
      // Capture is read-only. A cancelled request can release its listeners
      // immediately even if a native read or renderer has not settled yet;
      // that abandoned result has no authority to publish tenant effects.
      const snapshot = await Promise.race([capture(), aborted]);
      signal?.throwIfAborted();
      if (snapshot.relevant || Date.now() >= deadline) return snapshot.value;
      await changed;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      for (const remove of removers) remove();
    }
  }
}
