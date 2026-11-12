// Wire failures carry provenance, not a client HTTP status. Public/worker owners
// decide how to render or retry them. Unknown errors remain local faults.
export type UpstreamCategory =
  | 'transport'
  | 'protocol'
  | 'validation'
  | 'local'
  | 'cancellation';
export type UpstreamContext = {
  phase: string;
  reason: string;
  peer?: string;
  endpoint?: string; // Symbolic endpoint name, never a URL or request target.
  remoteStatus?: number;
  resourceLimit?: boolean;
  cause?: unknown;
};
export class UpstreamError extends Error {
  override readonly name = 'UpstreamError';
  constructor(
    readonly category: UpstreamCategory,
    readonly context: UpstreamContext,
  ) {
    super(`upstream ${category}: ${context.reason}`, { cause: context.cause });
  }
}

// A completed non-success response is not a failed network operation and is
// not a grammar failure. Its status remains available to endpoint fallback.
export class UpstreamHttpError extends Error {
  override readonly name: string = 'UpstreamHttpError';
  constructor(readonly remoteStatus: number, readonly phase: string) {
    super(`upstream returned ${remoteStatus}`);
  }
}
export function protocol(
  phase: string,
  reason: string,
  cause?: unknown,
): never {
  throw new UpstreamError('protocol', { phase, reason, cause });
}
export function limit(phase: string, reason = 'Content is too large'): never {
  throw new UpstreamError('validation', { phase, reason, resourceLimit: true });
}
export function upstreamCategory(
  error: unknown,
  signal?: AbortSignal,
): UpstreamCategory | 'http' {
  if (error instanceof UpstreamError) return error.category;
  if (signal?.aborted && error === signal.reason) return 'cancellation';
  if (error instanceof UpstreamHttpError) return 'http';
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'cancellation';
  }
  return 'local';
}

export function upstreamDeadline(parent: AbortSignal, ms: number): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  const timeout = new AbortController();
  deadline.addEventListener(
    'abort',
    () =>
      timeout.abort(
        new UpstreamError('transport', {
          phase: 'deadline',
          reason: 'upstream timeout',
        }),
      ),
    { once: true },
  );
  return AbortSignal.any([parent, timeout.signal]);
}
// Call only around a network primitive, never around response parsing or sinks.
export async function networkOperation<T>(
  phase: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  try {
    return await run();
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof UpstreamError) throw cause;
    throw new UpstreamError('transport', {
      phase,
      reason: 'connection failed',
      cause,
    });
  }
}
