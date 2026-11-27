import { StoreError } from '#engine/store/ffi.ts';

/** A refused write that may succeed after storage becomes available. */
export class StoragePressureError extends Error {
  constructor(cause?: unknown, message = 'Storage capacity exhausted') {
    super(message, { cause });
    this.name = 'StoragePressureError';
  }
}

/** Retry only after releasing any transaction or resources held by the caller. */
export class StorageBusyError extends StoragePressureError {
  constructor(readonly released: Promise<void>) {
    super();
    this.name = 'StorageBusyError';
    this.message = 'Storage capacity is reserved by other work';
  }
}

export function isStoragePressure(error: unknown): boolean {
  if (error instanceof StoragePressureError) return true;
  if (error instanceof StoreError) return error.storageFull;
  if (!(error instanceof Error)) return false;
  if ('code' in error && (error.code === 'ENOSPC' || error.code === 'EDQUOT')) {
    return true;
  }
  // Deno can report only the underlying Linux errno for filesystem errors.
  return /\(os error (28|122)\)(?=[:\s]|$)/.test(error.message);
}

export function storageFailure(error: unknown): unknown {
  return isStoragePressure(error) && !(error instanceof StoragePressureError)
    ? new StoragePressureError(error)
    : error;
}
