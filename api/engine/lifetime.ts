/** Attempt every resource in ownership order without hiding another failure. */
export async function drainResources(
  stops: readonly (() => unknown | Promise<unknown>)[],
  errors: unknown[] = [],
): Promise<void> {
  for (const stop of stops) {
    try {
      await stop();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'resource shutdown failed');
  }
}
