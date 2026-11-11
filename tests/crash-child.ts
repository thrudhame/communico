// One lifetime owns the absolute deadline, both pipe drains and child cleanup.
export type KillReason = 'watchdog' | 'sample' | 'checkpoint';

export async function runCrashChild<T>(
  command: Deno.Command,
  options: {
    deadlineMs: number;
    deadlineReason?: KillReason;
    onEvent: (event: T, stop: (reason: KillReason) => void) => void;
  },
): Promise<
  { reason: KillReason | 'exited'; status: Deno.CommandStatus; stderr: string }
> {
  const child = command.spawn();
  let reason: KillReason | 'exited' = 'exited';
  let ended = false;
  const status = child.status.then((status) => {
    ended = true;
    return status;
  });
  const stop = (why: KillReason) => {
    if (ended || reason !== 'exited') return;
    try {
      child.kill('SIGKILL');
      reason = why;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  };
  const timer = setTimeout(
    () => stop(options.deadlineReason ?? 'watchdog'),
    options.deadlineMs,
  );
  let diagnostic = '';
  const stderr = child.stderr.pipeThrough(new TextDecoderStream()).pipeTo(
    new WritableStream<string>({
      write(chunk) {
        diagnostic = (diagnostic + chunk).slice(-65536);
      },
    }),
  );
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) options.onEvent(JSON.parse(line) as T, stop);
      }
    }
    if (buffer.trim()) options.onEvent(JSON.parse(buffer) as T, stop);
    const finalStatus = await status;
    await stderr;
    return { reason, status: finalStatus, stderr: diagnostic };
  } finally {
    clearTimeout(timer);
    stop('watchdog');
    await reader.cancel();
    reader.releaseLock();
    await Promise.all([status, stderr]);
  }
}
