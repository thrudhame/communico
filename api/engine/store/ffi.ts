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
}

const definitions = {
  ffi_open: { parameters: ['buffer'], result: 'pointer', nonblocking: true },
  ffi_connect: { parameters: ['u32'], result: 'pointer', nonblocking: true },
  ffi_exec: {
    parameters: ['u32', 'buffer'],
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
  ffi_rollback: { parameters: ['u32'], result: 'pointer', nonblocking: true },
  ffi_checkpoint: {
    parameters: ['u32', 'u32'],
    result: 'pointer',
    nonblocking: true,
  },
  ffi_close: {
    parameters: ['u32', 'u32'],
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
          throw new StoreError(reply.code, reply.message, reply.last_error);
        }
        return reply.value as T;
      } finally {
        await this.library.symbols.ffi_free(pointer);
      }
    } finally {
      this.calls--;
    }
  }

  async open(path: string): Promise<number> {
    const handle = await this.value<number>(() =>
      this.library.symbols.ffi_open(bytes(path))
    );
    this.files++;
    return handle;
  }

  connect(file: number): Promise<number> {
    return this.value(() => this.library.symbols.ffi_connect(file));
  }

  exec(connection: number, sql: string): Promise<void> {
    return this.value(() =>
      this.library.symbols.ffi_exec(connection, bytes(sql))
    );
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
        ) => [key, Array.isArray(value) ? new Uint8Array(value) : value]),
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

  rollback(connection: number): Promise<void> {
    return this.value(() => this.library.symbols.ffi_rollback(connection));
  }

  checkpoint(connection: number, mode: CheckpointMode): Promise<Row[]> {
    return this.value(() =>
      this.library.symbols.ffi_checkpoint(
        connection,
        { PASSIVE: 0, FULL: 1, RESTART: 2, TRUNCATE: 3 }[mode],
      )
    );
  }

  closeConnection(connection: number): Promise<void> {
    return this.value(() => this.library.symbols.ffi_close(connection, 1));
  }

  async closeFile(file: number): Promise<void> {
    await this.value(() => this.library.symbols.ffi_close(file, 0));
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
}
