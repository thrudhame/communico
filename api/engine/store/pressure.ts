import { StoreError } from '#engine/store/ffi.ts';

/** A refused write that may succeed after storage becomes available. */
export class StoragePressureError extends Error {
  constructor(cause?: unknown) {
    super('Storage capacity exhausted', { cause });
    this.name = 'StoragePressureError';
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
