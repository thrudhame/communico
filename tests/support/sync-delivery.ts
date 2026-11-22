// Consume accepted sends as a client does: since-token long polls, not a
// projection-completion shortcut. Suppress the owner's sweep timers so these
// requests can advance only through real notifier wakes. No synthetic sweeps.
import { assert, assertEquals } from '@std/assert';
import { observeSyncWait } from './sync-turn.ts';

type Matrix = (request: Request) => Promise<Response>;
type Expected = Record<string, string[]>;
type Sync = {
  next_batch: string;
  rooms?: {
    join?: Record<string, { timeline?: { events?: { event_id: string }[] } }>;
  };
};

export async function deliveredBySync(
  matrix: Matrix,
  token: string,
  produce: () => Promise<Expected>,
  options: { since?: string; observed?: (events: Expected) => void } = {},
): Promise<Expected> {
  const sync = async (
    since?: string,
    signal?: AbortSignal,
    timeout = 30000,
  ) => {
    const query = new URLSearchParams({ timeout: String(timeout) });
    if (since !== undefined) query.set('since', since);
    const response = await matrix(
      new Request(
        'http://x/_matrix/client/v3/sync?' + query,
        { headers: { Authorization: 'Bearer ' + token }, signal },
      ),
    );
    assertEquals(response.status, 200, await response.clone().text());
    const body = await response.json() as Sync;
    assert(typeof body.next_batch === 'string');
    return body;
  };
  let since = options.since ?? (await sync(undefined, undefined, 0)).next_batch;
  const turns = observeSyncWait();
  const received: Expected = {};
  const record = (body: Sync) => {
    for (const [room, value] of Object.entries(body.rooms?.join ?? {})) {
      (received[room] ??= []).push(
        ...(value.timeline?.events ?? []).map((event) => event.event_id),
      );
    }
    since = body.next_batch;
  };
  const start = () => turns.start((signal) => sync(since, signal));
  let pending = start();
  try {
    // Drain already-relevant cuts until this actual long poll is armed before
    // the producer writes. Unrelated activity is not an artificial retry wake.
    for (;;) {
      const armed = await Promise.race([
        pending.capture().then(() => true),
        pending.result.then(() => false),
      ]).catch((error) => {
        if (
          error instanceof Error &&
          error.message === 'stream returned before an irrelevant capture'
        ) return false;
        throw error;
      });
      if (armed) break;
      record(await pending.finish());
      pending = start();
    }
    const expected = await produce();
    const selected = () =>
      Object.fromEntries(
        Object.entries(expected).map(([room, ids]) => [
          room,
          (received[room] ?? []).filter((id) => ids.includes(id)),
        ]),
      );
    for (;;) {
      record(await pending.finish());
      const seen = selected();
      for (const [room, ids] of Object.entries(expected)) {
        assertEquals(
          seen[room],
          ids.slice(0, seen[room].length),
          'sync delivers each event exactly once and in room order',
        );
      }
      options.observed?.(seen);
      if (
        Object.entries(expected).every(([room, ids]) =>
          seen[room].length === ids.length
        )
      ) break;
      pending = start();
    }
    const successor = await sync(since, undefined, 0);
    for (const [room, ids] of Object.entries(expected)) {
      assertEquals(
        (successor.rooms?.join?.[room]?.timeline?.events ?? [])
          .filter((event) => ids.includes(event.event_id)),
        [],
        'the successor since token never replays delivered events',
      );
    }
    return expected;
  } finally {
    await turns.close();
  }
}

export async function roomDeliveredBySync(
  matrix: Matrix,
  token: string,
  room: string,
  produce: () => Promise<string[]>,
): Promise<string[]> {
  return (await deliveredBySync(matrix, token, async () => ({
    [room]: await produce(),
  })))[room];
}
