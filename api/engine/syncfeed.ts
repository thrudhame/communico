// Minimal /sync feed (phase-2 step 2.2). since token = 's<lastSeq>';
// absent => initial sync (everything). Long-poll: poll MAX(seq) every
// 500 ms until new events or timeout.
import { SERVER_DB, withDb } from './db.ts';
import { eventAtCommit } from './timeline.ts';

export interface SyncResult {
  next_batch: string;
  rooms: { join: Record<string, unknown> };
  presence: { events: unknown[] };
  account_data: { events: unknown[] };
  to_device: { events: unknown[] };
  device_lists: Record<string, unknown>;
  device_one_time_keys_count: Record<string, unknown>;
}

interface IdxRow {
  event_id: string;
  room_id: string;
  commit_hash: string;
  seq: number;
}

function emptySync(batch: string): SyncResult {
  return {
    next_batch: batch,
    rooms: { join: {} },
    presence: { events: [] },
    account_data: { events: [] },
    to_device: { events: [] },
    device_lists: {},
    device_one_time_keys_count: {},
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function syncSince(
  since: number | null,
  timeoutMs: number,
): Promise<SyncResult> {
  const deadline = Date.now() + Math.min(timeoutMs, 30000);

  // 2. long-poll loop on MAX(seq)
  let m: number | null = await withDb(SERVER_DB, async (c) => {
    const r = await c.query('SELECT MAX(seq) AS m FROM event_index;');
    return r.rows[0].m == null ? null : Number(r.rows[0].m);
  });
  while (since !== null && (m === null || m <= since)) {
    if (Date.now() >= deadline) return emptySync('s' + since);
    await sleep(500);
    m = await withDb(SERVER_DB, async (c) => {
      const r = await c.query('SELECT MAX(seq) AS m FROM event_index;');
      return r.rows[0].m == null ? null : Number(r.rows[0].m);
    });
  }

  // 3. fetch new events (all of them on initial sync)
  const rows: IdxRow[] = await withDb(SERVER_DB, async (c) => {
    const r = since === null
      ? await c.query(
        'SELECT event_id, room_id, commit_hash, seq FROM event_index ORDER BY seq;',
      )
      : await c.query(
        'SELECT event_id, room_id, commit_hash, seq FROM event_index WHERE seq > $1 ORDER BY seq;',
        [since],
      );
    // deno-lint-ignore no-explicit-any
    return r.rows.map((row: any) => ({
      event_id: String(row.event_id),
      room_id: String(row.room_id),
      commit_hash: String(row.commit_hash),
      seq: Number(row.seq),
    }));
  });

  const byRoom = new Map<string, IdxRow[]>();
  for (const r of rows) {
    const list = byRoom.get(r.room_id) ?? [];
    list.push(r);
    byRoom.set(r.room_id, list);
  }

  // room set: every room_directory row on initial sync; only rooms with
  // new events on incremental sync (recorded simplification)
  const dir = await withDb(SERVER_DB, async (c) => {
    const r = await c.query('SELECT room_id, db_name FROM room_directory;');
    // deno-lint-ignore no-explicit-any
    return r.rows as any[];
  });

  const join: Record<string, unknown> = {};
  for (const rd of dir) {
    const roomId = String(rd.room_id);
    const evRows = byRoom.get(roomId) ?? [];
    if (since !== null && evRows.length === 0) continue;

    const events: Record<string, unknown>[] = [];
    await withDb(String(rd.db_name), async (c) => {
      for (const er of evRows) {
        const pdu = await eventAtCommit(c, er.commit_hash);
        if (!pdu) continue;
        const ev: Record<string, unknown> = {
          event_id: er.event_id, // wire id from event_index
          sender: pdu.sender,
          type: pdu.type,
          content: pdu.content,
          origin_server_ts: pdu.origin_server_ts ?? pdu.origin_ts,
        };
        if (pdu.state_key != null) ev.state_key = pdu.state_key;
        events.push(ev);
      }
    });

    // state.events on initial sync only: the state-type events from the
    // same loaded set (carries wire ids; see RESULTS.md deviation note —
    // the phase's "state table rows" formulation leaks provisional Mode B
    // ids, and the sets coincide for the demo flows)
    const stateEvents = since === null
      ? events.filter((e) => e.state_key != null)
      : [];

    join[roomId] = {
      timeline: {
        events,
        limited: false,
        prev_batch: 's' + (evRows.length > 0 ? evRows[0].seq - 1 : m ?? 0),
      },
      state: { events: stateEvents },
      ephemeral: { events: [] },
      account_data: { events: [] },
      unread_notifications: {},
    };
  }

  return { ...emptySync('s' + (m ?? 0)), rooms: { join } };
}
