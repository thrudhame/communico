import type { Capacity, NativeReservation } from './capacity.ts';
import { StoreError, type Turso, type Value } from './ffi.ts';
import { storageFailure } from './pressure.ts';

export const NO_GROWTH = { blockSize: 1, bytes: 0 };

const pageBytes = 4096; // Default pager size on the qualified pin.
const frameHeaderBytes = 24;
const walHeaderBytes = 32;
const mvccHeaderBytes = 56;
const frameBytes = pageBytes + frameHeaderBytes;
// Qualified fresh MVCC bootstrap: database header page, initial log header,
// pager mode change, WAL header + two schema frames + persistent timestamp
// frame, then both database pages and final log header. Round each IO the
// same way as the native guard, not just the bytes left in the finished files.
const bootstrapFrames = [
  { offset: 0, length: pageBytes },
  { offset: 0, length: mvccHeaderBytes },
  { offset: 0, length: pageBytes },
  { offset: 0, length: walHeaderBytes },
  { offset: walHeaderBytes, length: 2 * frameBytes },
  { offset: walHeaderBytes + 2 * frameBytes, length: frameBytes },
  { offset: 0, length: 2 * pageBytes },
  { offset: 0, length: mvccHeaderBytes },
];
const encoder = new TextEncoder();

/** Seed a replayable write from its inputs, not from the filesystem size.
 * A dirty page and the input payload cover ordinary small writes. SQL can
 * expand on disk (indexes, computed values, bulk mutations); native IO
 * enforces the actual charge and reports the next required footprint. */
export function writeFrames(
  sql: string,
  values: readonly Value[] = [],
): number {
  const input = values.reduce<number>(
    (bytes, value) =>
      bytes +
      (typeof value === 'string'
        ? encoder.encode(value).length
        : value instanceof Uint8Array
        ? value.byteLength
        : 8),
    encoder.encode(sql).length,
  );
  return pageBytes + input +
    (1 + Math.ceil(input / pageBytes)) * frameHeaderBytes;
}

export function shortfall(
  error: unknown,
  grant: NativeReservation | undefined,
): number | undefined {
  if (!grant || !(error instanceof StoreError)) return;
  const bytes = error.requiredWriteBytes;
  if (
    bytes !== undefined && Number.isSafeInteger(bytes) &&
    bytes > grant.bytes - grant.undoBytes
  ) return bytes;
}

export async function openNative(
  ffi: Turso,
  path: string,
  capacity?: Capacity,
): Promise<number> {
  try {
    if (!capacity) return await ffi.open(path);
    // Do not charge a fresh bootstrap on a clean pool miss or cold reopen.
    // A probe cannot create files or write nonempty buffers. Retry it once
    // only if the native guard refused allocation, not for a physical I/O
    // failure or after any allocating initialization attempt.
    const existing = await Deno.stat(path).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    if (existing?.isFile && existing.size > 0) {
      // Closing the file settles canonical paths even when no grant ran.
      await capacity.initialize();
      try {
        return await ffi.open(path, {
          ...NO_GROWTH,
          scratchRoot: capacity.nativeScratchRoot,
        });
      } catch (error) {
        if (!(error instanceof StoreError && error.openNeedsAllocation)) {
          throw error;
        }
      }
    }
    const grant = await capacity.reserveNative(path, 3, bootstrapFrames, false);
    try {
      return await ffi.open(path, grant);
    } finally {
      grant.release();
    }
  } catch (error) {
    throw storageFailure(error);
  }
}
