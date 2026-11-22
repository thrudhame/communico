/** Child output belongs to the runner's evidence workspace, not the fixture's
 * disposable store. Retain it unconditionally: cleanup cannot know whether an
 * assertion in its caller failed. No open descriptors survive the child. */
export function childDiagnostics() {
  return createChildDiagnostics();
}

function createChildDiagnostics() {
  const dir = Deno.makeTempDirSync({ prefix: 'child-logs-' });
  Deno.chmodSync(dir, 0o700);
  const append = (name: string) => {
    const path = `${dir}/${name}.log`;
    Deno.writeTextFileSync(path, '', { mode: 0o600 });
    return (text: string) =>
      Deno.writeTextFileSync(path, text, { append: true });
  };
  const stdout = append('stdout'), stderr = append('stderr');
  console.error('child diagnostics: ' + dir);
  const status = (value: Deno.CommandStatus) =>
    Deno.writeTextFileSync(`${dir}/status.json`, JSON.stringify(value) + '\n', {
      mode: 0o600,
    });
  const bytes = (name: 'stdout' | 'stderr', chunk: Uint8Array) =>
    Deno.writeFileSync(`${dir}/${name}.log`, chunk, { append: true });
  const failedToSpawn = (error: unknown) => {
    stderr(
      error instanceof Error
        ? error.stack ?? error.message
        : 'non-Error spawn failure',
    );
    Deno.writeTextFileSync(
      `${dir}/spawn-error.json`,
      JSON.stringify({
        phase: 'spawn',
        name: error instanceof Error ? error.name : 'NonError',
      }) + '\n',
      { mode: 0o600 },
    );
  };
  return { dir, stdout, stderr, status, bytes, failedToSpawn };
}

/** All other fixture commands share the same retained evidence contract. Pipe
 * recording preserves consumer backpressure; output() drains both pipes at once.
 * The private facade observation pipe uses its own filtered recorder instead. */
export class DiagnosticCommand extends Deno.Command {
  constructor(command: string | URL, options: Deno.CommandOptions = {}) {
    super(command, { ...options, stdout: 'piped', stderr: 'piped' });
  }

  override spawn(): Deno.ChildProcess {
    const diagnostics = createChildDiagnostics();
    let child: Deno.ChildProcess;
    try {
      child = super.spawn();
    } catch (error) {
      diagnostics.failedToSpawn(error);
      throw error;
    }
    const status = child.status.then((status) => {
      diagnostics.status(status);
      return status;
    });
    const record = (
      stream: ReadableStream<Uint8Array>,
      name: 'stdout' | 'stderr',
    ) =>
      stream.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            diagnostics.bytes(name, chunk);
            controller.enqueue(chunk);
          },
        }),
      );
    let stdout: ReadableStream<Uint8Array> | undefined;
    let stderr: ReadableStream<Uint8Array> | undefined;
    const getStdout = () => stdout ??= record(child.stdout, 'stdout');
    const getStderr = () => stderr ??= record(child.stderr, 'stderr');
    return new Proxy(child, {
      get(target, key) {
        if (key === 'status') return status;
        if (key === 'stdout') return getStdout();
        if (key === 'stderr') return getStderr();
        if (key === 'output') {
          return async () => {
            const [result, out, err] = await Promise.all([
              status,
              new Response(getStdout()).arrayBuffer(),
              new Response(getStderr()).arrayBuffer(),
            ]);
            return {
              ...result,
              stdout: new Uint8Array(out),
              stderr: new Uint8Array(err),
            };
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  override output(): Promise<Deno.CommandOutput> {
    return this.spawn().output();
  }

  override outputSync(): Deno.CommandOutput {
    const diagnostics = createChildDiagnostics();
    try {
      const result = super.outputSync();
      diagnostics.bytes('stdout', result.stdout);
      diagnostics.bytes('stderr', result.stderr);
      diagnostics.status({
        success: result.success,
        code: result.code,
        signal: result.signal,
      });
      return result;
    } catch (error) {
      diagnostics.failedToSpawn(error);
      throw error;
    }
  }
}
