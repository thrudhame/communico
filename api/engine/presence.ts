// api/engine/presence.ts — M4 presence (plan §2/E3): the status table
// plus its own monotone stream (presence_seq; sync tokens are
// s<eventSeq>_p<presenceSeq>). register/login create an `offline` row so
// a never-synced joiner has one.
import { MatrixError } from './matrix-error.ts';
import { serverDb, withDb } from './db.ts';

export interface PresenceRow {
  presence: string;
  statusMsg: string | null;
  lastActiveMs: number;
  seq: number;
}

const PRESENCES = new Set(['online', 'offline', 'unavailable']);

// The register/login-time default row (offline) — a never-synced joiner
// still has one to fan out.
export async function ensurePresenceRow(userId: string): Promise<void> {
  await withDb(serverDb(), async (c) => {
    await c.query(
      `INSERT INTO presence (user_id, presence, status_msg, last_active_ms, seq)
       VALUES ($1, 'offline', NULL, $2, nextval('presence_seq'))
       ON CONFLICT (user_id) DO NOTHING;`,
      [userId, Date.now()],
    );
  });
}

// PUT /presence/:id/status and /sync's set_presence share this: a full
// status set (an omitted status_msg clears), bumping presence_seq.
export async function setPresence(
  userId: string,
  presence: string,
  statusMsg?: string,
): Promise<void> {
  if (!PRESENCES.has(presence)) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'bad presence: ' + presence);
  }
  await withDb(serverDb(), async (c) => {
    await c.query(
      `INSERT INTO presence (user_id, presence, status_msg, last_active_ms, seq)
       VALUES ($1, $2, $3, $4, nextval('presence_seq'))
       ON CONFLICT (user_id) DO UPDATE SET presence = EXCLUDED.presence, status_msg = EXCLUDED.status_msg, last_active_ms = EXCLUDED.last_active_ms, seq = EXCLUDED.seq;`,
      [userId, presence, statusMsg ?? null, Date.now()],
    );
  });
}

// The user's row, or the spec's default (offline) when none exists.
export async function getPresence(userId: string): Promise<PresenceRow> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT presence, status_msg, last_active_ms, seq FROM presence WHERE user_id = $1;',
      [userId],
    );
    if (r.rows.length === 0) {
      return { presence: 'offline', statusMsg: null, lastActiveMs: 0, seq: 0 };
    }
    return {
      presence: String(r.rows[0].presence),
      statusMsg: r.rows[0].status_msg == null
        ? null
        : String(r.rows[0].status_msg),
      lastActiveMs: Number(r.rows[0].last_active_ms),
      seq: Number(r.rows[0].seq),
    };
  });
}

// The latest rows for the given users with seq > sincePseq (incremental
// /sync's presence fan-out), one row per user.
export async function presenceFor(
  userIds: string[],
  sincePseq: number,
): Promise<(PresenceRow & { userId: string })[]> {
  if (userIds.length === 0) return [];
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT user_id, presence, status_msg, last_active_ms, seq FROM presence WHERE user_id = ANY($1) AND seq > $2;',
      [userIds, sincePseq],
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => ({
      userId: String(row.user_id),
      presence: String(row.presence),
      statusMsg: row.status_msg == null ? null : String(row.status_msg),
      lastActiveMs: Number(row.last_active_ms),
      seq: Number(row.seq),
    }));
  });
}
