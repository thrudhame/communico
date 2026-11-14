// Hints contain heads only. The journal, never this process-local wakeup, owns
// truth. A slow subscriber coalesces changes rather than retaining an event log.
import { canonicalJson } from '#engine/canonical.ts';
import {
  type Cut,
  cutOf,
  LinkError,
  object,
  type Stream,
  streamOf,
} from './protocol.ts';

export type NoticeHead = Stream & { head: Cut };

export function noticeHeads(raw: unknown): NoticeHead[] {
  if (!Array.isArray(raw)) {
    throw new LinkError(
      'LINK_BAD_RECORD',
      'notice heads must be an array',
      400,
    );
  }
  return raw.map((value) => ({
    ...streamOf(value),
    head: cutOf(object(value).head),
  }));
}

export class NoticeHub {
  private readonly listeners = new Set<() => void>();

  changed(): void {
    for (const wake of this.listeners) wake();
  }

  response(
    read: () => Promise<Record<string, unknown>>,
    signal: AbortSignal,
    websocket: boolean,
  ): Response {
    let dirty = true;
    let stopped = false;
    let pending: (() => void) | undefined;
    const wake = () => {
      dirty = true;
      pending?.();
    };
    const stop = () => {
      stopped = true;
      this.listeners.delete(wake);
      signal.removeEventListener('abort', stop);
      pending?.();
    };
    this.listeners.add(wake);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!dirty && !stopped) {
            await new Promise<void>((resolve) => {
              pending = resolve;
            });
            pending = undefined;
          }
          if (stopped) {
            controller.close();
            return;
          }
          dirty = false;
          try {
            // Authority and durable heads are re-read for every emission. Changes
            // during that read stay dirty and cause another snapshot on next pull.
            const value = canonicalJson(await read());
            if (!stopped) {
              controller.enqueue(
                encoder.encode(
                  websocket ? value + '\n' : 'data: ' + value + '\n\n',
                ),
              );
            }
          } catch (error) {
            stop();
            controller.error(error);
          }
        },
        cancel: stop,
      }),
      {
        headers: {
          'content-type': websocket
            ? 'application/x-ndjson'
            : 'text/event-stream',
          'cache-control': 'no-store',
        },
      },
    );
  }
}

/** Chunk boundaries are transport boundaries, not message boundaries. */
export async function* lines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n')) !== -1) {
        yield pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function* sseMessages(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  let data: string[] = [];
  for await (const line of lines(body)) {
    if (line === '') {
      if (data.length) yield data.join('\n');
      data = [];
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
}
