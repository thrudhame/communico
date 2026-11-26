// api/engine/store/ffi.ts — the sole native boundary. Replies are owned JSON;
// every call (including free) runs off the JavaScript thread.
import type { BuildInfo } from '#engine/store/build.ts';

export type Value = null | string | number | Uint8Array;
export type Row = Record<string, Value>;
export type BeginMode = 'deferred' | 'immediate' | 'concurrent';
export type CheckpointMode = 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE';

export class StoreError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly lastError: string,
    readonly requiredWriteBytes?: number,
  ) {
    super(message);
    this.name = 'StoreError';
  }

  get busy(): boolean {
    return (this.code & 255) === 5;
  }

  get conflict(): boolean {
    // At the qualified pin the Rust SDK exposes WriteWriteConflict through
    // its generic Error variant. Match that exact reply, never arbitrary SQL
    // errors containing words such as "busy" or "conflict".
    return this.busy || (this.code === 1 &&
      this.message === 'Write-write conflict' &&
      this.lastError === 'Error("Write-write conflict")');
  }

  get storageFull(): boolean {
    return (this.code & 255) === 13 ||
      (this.code === 10 && this.lastError.startsWith('IoError(StorageFull, '));
  }
}

type OwnedCheckpoint =
  & { peakBytes: number }
  & (
    { rows: Row[]; error?: never } | {
      rows?: never;
      error: { code: number; message: string; lastError: string };
    }
  );

const definitions = {
  ffi_open: { parameters: ['buffer'], result: 'pointer', nonblocking: true },
  ffi_quota_enforced: {
    parameters: ['buffer'],
    result: 'pointer',
    nonblocking: true,
  },
  ffi_open_bounded: {
    parameters: ['buffer', 'u64', 'u64', 'u32', 'buffer'],
    result: 'pointer',
    nonblocking: true,
  },
  ffi_connect: { parameters: ['u32'], result: 'pointer', nonblocking: true },
  ffi_connect_bounded: {
    parameters: ['u32'],
    result: 'pointer',
    nonblocking: true,
  },
  ffi_set_limit: {
    parameters: ['u32', 'u64', 'u64', 'u64', 'u32'],
    result: 'pointer',
    nonblocking: true,
  },
  ffi_exec: {
    parameters: ['u32', 'buffer'],
    result: 'pointer',
    nonblocking: true,
  },
  ffi_vacuum_into: {
    parameters: ['u32', 'buffer'],
    result: 'pointer',
    nonblocking: true,
  },
  ffi_rename_noreplace: {
    parameters: ['buffer', 'buffer'],
    result: 'pointer',
    nonblocking: true,
  },
  ffi_lock_store: {
    parameters: ['buffer'],
    result: 'pointer',
    nonblocking: true,
  },
  ffi_execute: {
    parameters: ['u32', 'buffer', 'buffer'],
    result: 'pointer',
    nonblocking: true,
  },
  ffi_query: {
    parameters: ['u32', 'buffer', 'buffer'],
    result: 'pointer',
    nonblocking: true,
  },
  ffi_begin: {
    parameters: ['u32', 'u32'],
    result: 'pointer',
    nonblocking: true,
  },
  ffi_commit: { parameters: ['u32'], result: 'pointer', nonblocking: true },
  ffi_rollback: {
    parameters: ['u32', 'bool'],
    result: 'pointer',
    nonblocking: true,
  },
  ffi_checkpoint: {
    parameters: ['u32', 'u32'],
    result: 'pointer',
    nonblocking: true,
  },
  ffi_owned_checkpoint: {
    parameters: ['u32'],
    result: 'pointer',
    nonblocking: true,
  },
  ffi_close: {
    parameters: ['u32', 'u32', 'bool'],
    result: 'pointer',
    nonblocking: true,
  },
  ffi_free: { parameters: ['pointer'], result: 'void', nonblocking: true },
  ffi_build_info: {
    parameters: [],
    result: 'pointer',
    nonblocking: true,
  },
} as const;

const encoder = new TextEncoder();
function bytes(value: string): Uint8Array {
  if (value.includes('\0')) throw new TypeError('NUL in native string');
  return encoder.encode(value + '\0');
}

function parameters(values: readonly Value[]): Uint8Array {
  for (const value of values) {
    if (
      typeof value === 'number' && (!Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value)))
    ) {
      throw new TypeError(
        'SQL numbers must be finite and integers must be safe',
      );
    }
  }
  return bytes(
    JSON.stringify(
      values.map((value) => value instanceof Uint8Array ? [...value] : value),
    ),
  );
}

export class Turso {
  private readonly library: Deno.DynamicLibrary<typeof definitions>;
  private files = 0;
  private calls = 0;
  private closed = false;

  constructor(path: string) {
    this.library = Deno.dlopen(path, definitions);
  }

  private async value<T>(call: () => Promise<Deno.PointerValue>): Promise<T> {
    if (this.closed) throw new Error('native library is closed');
    this.calls++;
    try {
      const pointer = await call();
      if (pointer === null) throw new Error('native call returned no reply');
      try {
        const reply = JSON.parse(
          new Deno.UnsafePointerView(pointer).getCString(),
        );
        if (reply.code !== 0) {
          throw new StoreError(
            reply.code,
            reply.message,
            reply.last_error,
            reply.required_write_bytes ?? undefined,
          );
        }
        return reply.value as T;
      } finally {
        await this.library.symbols.ffi_free(pointer);
      }
    } finally {
      this.calls--;
    }
  }

  async open(
    path: string,
    ceiling?: {
      blockSize: number;
      bytes: number;
      creates?: number;
      scratchRoot?: string;
    },
  ): Promise<number> {
    const handle = await this.value<number>(() =>
      ceiling
        ? this.library.symbols.ffi_open_bounded(
          bytes(path),
          BigInt(ceiling.blockSize),
          BigInt(ceiling.bytes),
          ceiling.creates ?? 0,
          ceiling.scratchRoot === undefined ? null : bytes(ceiling.scratchRoot),
        )
        : this.library.symbols.ffi_open(bytes(path))
    );
    this.files++;
    return handle;
  }

  connect(file: number, bounded = false): Promise<number> {
    return this.value(() =>
      bounded
        ? this.library.symbols.ffi_connect_bounded(file)
        : this.library.symbols.ffi_connect(file)
    );
  }

  setLimit(
    connection: number,
    { blockSize, bytes, creates = 0 }: {
      blockSize: number;
      bytes: number;
      creates?: number;
    },
    undoBytes: number,
  ): Promise<void> {
    return this.value(() =>
      this.library.symbols.ffi_set_limit(
        connection,
        BigInt(blockSize),
        BigInt(bytes),
        BigInt(undoBytes),
        creates,
      )
    );
  }

  exec(connection: number, sql: string): Promise<void> {
    return this.value(() =>
      this.library.symbols.ffi_exec(connection, bytes(sql))
    );
  }

  vacuumInto(
    connection: number,
    staging: string,
  ): Promise<void> {
    return this.value(() =>
      this.library.symbols.ffi_vacuum_into(
        connection,
        bytes(staging),
      )
    );
  }

  renameNoReplace(source: string, destination: string): Promise<boolean> {
    return this.value(() =>
      this.library.symbols.ffi_rename_noreplace(
        bytes(source),
        bytes(destination),
      )
    );
  }

  async lockStore(path: string): Promise<number> {
    const handle = await this.value<number>(() =>
      this.library.symbols.ffi_lock_store(bytes(path))
    );
    this.files++;
    return handle;
  }

  async unlockStore(handle: number): Promise<void> {
    await this.value(() => this.library.symbols.ffi_close(handle, 2, false));
    this.files--;
  }

  execute(
    connection: number,
    sql: string,
    values: readonly Value[] = [],
  ): Promise<number> {
    return this.value(() =>
      this.library.symbols.ffi_execute(
        connection,
        bytes(sql),
        parameters(values),
      )
    );
  }

  async query(
    connection: number,
    sql: string,
    values: readonly Value[] = [],
  ): Promise<Row[]> {
    const rows = await this.value<
      Record<string, null | string | number | number[]>[]
    >(() =>
      this.library.symbols.ffi_query(connection, bytes(sql), parameters(values))
    );
    return rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map((
          [key, value],
        ) => {
          if (
            typeof value === 'number' && (!Number.isFinite(value) ||
              (Number.isInteger(value) && !Number.isSafeInteger(value)))
          ) {
            throw new TypeError(
              'SQL results must be finite and integers must be safe',
            );
          }
          return [key, Array.isArray(value) ? new Uint8Array(value) : value];
        }),
      )
    );
  }

  begin(connection: number, mode: BeginMode): Promise<void> {
    return this.value(() =>
      this.library.symbols.ffi_begin(
        connection,
        { deferred: 0, immediate: 1, concurrent: 2 }[mode],
      )
    );
  }

  commit(connection: number): Promise<void> {
    return this.value(() => this.library.symbols.ffi_commit(connection));
  }

  rollback(connection: number, ownedCheckpoint = false): Promise<void> {
    return this.value(() =>
      this.library.symbols.ffi_rollback(connection, ownedCheckpoint)
    );
  }

  checkpoint(connection: number, mode: CheckpointMode): Promise<Row[]> {
    return this.value(() =>
      this.library.symbols.ffi_checkpoint(
        connection,
        { PASSIVE: 0, FULL: 1, RESTART: 2, TRUNCATE: 3 }[mode],
      )
    );
  }

  ownedCheckpoint(connection: number): Promise<OwnedCheckpoint> {
    return this.value(() =>
      this.library.symbols.ffi_owned_checkpoint(connection)
    );
  }

  closeConnection(connection: number, ownedCheckpoint = false): Promise<void> {
    return this.value(() =>
      this.library.symbols.ffi_close(connection, 1, ownedCheckpoint)
    );
  }

  async closeFile(file: number, bounded = false): Promise<void> {
    await this.value(() =>
      this.library.symbols.ffi_close(file, bounded ? 3 : 0, false)
    );
    this.files--;
  }

  close(): void {
    if (this.closed) return;
    if (this.files || this.calls) throw new Error('native library is in use');
    this.closed = true;
    this.library.close();
  }

  buildInfo(): Promise<BuildInfo> {
    return this.value(() => this.library.symbols.ffi_build_info());
  }

  quotaEnforced(path: string): Promise<boolean> {
    return this.value(() =>
      this.library.symbols.ffi_quota_enforced(bytes(path))
    );
  }
}
