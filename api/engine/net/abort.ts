// Bound an asynchronous phase even when its primitive (DB/DNS/signing) cannot
// be cancelled. Late completion cannot continue the caller's operation. Socket
// owners additionally close their transport when the same signal fires.
export async function abortable<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  if (signal === undefined) return await run();
  let onAbort: () => void = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      run().then(resolve, reject);
    });
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
