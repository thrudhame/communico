// api/engine/federation/peers.ts — the roster, the blocks, and the door
// log (federation_pending). Runtime data: who we know / refuse / what
// knocks — the operator reviews through the tools. The witness set for
// key acquisition is operator/approval rows only (never rows created by a
// user's invite — design, concilium round 2).
import { config } from '#engine/config.ts';
import { serverDb, withDb } from '#engine/db.ts';

export type PeerRow = {
  name: string;
  host: string | null;
  port: number | null;
  trust: 'ca' | 'pinned' | 'keyname';
  pin_spki_sha256: string | null;
  added_ms: number;
  added_by: string;
  note: string | null;
};

export type PendingRow = {
  name: string;
  kind: 'inbound' | 'outbound' | 'disagreement';
  verified: boolean;
  first_ms: number;
  last_ms: number;
  count: number;
  detail: string | null;
};

export type BlockRow = {
  pattern: string;
  added_ms: number;
  note: string | null;
};

function peerOf(row: Record<string, unknown>): PeerRow {
  return {
    name: String(row.name),
    host: row.host === null ? null : String(row.host),
    port: row.port === null ? null : Number(row.port),
    trust: String(row.trust) as PeerRow['trust'],
    pin_spki_sha256: row.pin_spki_sha256 === null
      ? null
      : String(row.pin_spki_sha256),
    added_ms: Number(row.added_ms),
    added_by: String(row.added_by),
    note: row.note === null ? null : String(row.note),
  };
}

export async function lookupPeer(name: string): Promise<PeerRow | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT name, host, port, trust, pin_spki_sha256, added_ms, added_by, note FROM federation_peers WHERE name = $1;',
      [name],
    );
    return r.rows.length === 0
      ? null
      : peerOf(r.rows[0] as Record<string, unknown>);
  });
}

export async function addPeer(opts: {
  name: string;
  host: string | null;
  port: number | null;
  trust: 'ca' | 'pinned' | 'keyname';
  pin?: string | null;
  addedBy: string;
  note?: string | null;
}): Promise<void> {
  const pin = opts.pin !== undefined ? opts.pin : null;
  const note = opts.note !== undefined ? opts.note : null;
  await withDb(serverDb(), async (c) => {
    await c.query(
      'INSERT INTO federation_peers (name, host, port, trust, pin_spki_sha256, added_ms, added_by, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (name) DO UPDATE SET host = $2, port = $3, trust = $4, pin_spki_sha256 = $5, added_ms = $6, added_by = $7, note = $8;',
      [
        opts.name,
        opts.host,
        opts.port,
        opts.trust,
        pin,
        Date.now(),
        opts.addedBy,
        note,
      ],
    );
    // a roster row kills any pending claim for the name
    await c.query(
      "DELETE FROM federation_pending WHERE name = $1 AND kind IN ('inbound', 'outbound');",
      [opts.name],
    );
  });
}

export async function removePeer(name: string): Promise<boolean> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query('DELETE FROM federation_peers WHERE name = $1;', [
      name,
    ]);
    return (r.rowCount !== undefined ? r.rowCount : 0) > 0;
  });
}

export async function listPeers(): Promise<PeerRow[]> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT name, host, port, trust, pin_spki_sha256, added_ms, added_by, note FROM federation_peers ORDER BY added_ms;',
    );
    return r.rows.map((row: unknown) => peerOf(row as Record<string, unknown>));
  });
}

// seniority: oldest first. Operator/approval rows only, keyname rows are
// not notaries for others (their own document is unreachable by nature).
// M5b (§3.2, trust-ladder rung 5): the event's ROOM'S servers join the
// witness set after the roster witnesses — only while we are in the room
// (a room we left nominates nobody), ordered by the seq of each server's
// earliest joined member event (seniority in the room), minus ourselves
// and the name being looked up.
export async function listWitnesses(
  ctx?: { roomId?: string; excludeName?: string },
): Promise<string[]> {
  const peers = await listPeers();
  const roster = peers
    .filter((p) =>
      (p.added_by === 'operator' || p.added_by === 'approval') &&
      p.trust !== 'keyname'
    )
    .map((p) => p.name);
  if (ctx?.roomId === undefined) return roster;
  const ours = config().server.name;
  const seniority = new Map<string, number>();
  await withDb(serverDb(), async (c) => {
    const r = await c.query(
      `SELECT user_id, seq FROM room_membership WHERE room_id = $1 AND membership = 'join' ORDER BY seq ASC;`,
      [ctx.roomId!],
    );
    // deno-lint-ignore no-explicit-any
    for (const row of r.rows as any[]) {
      const uid = String(row.user_id);
      const at = uid.indexOf(':');
      if (at < 0) continue;
      const domain = uid.slice(at + 1);
      if (!seniority.has(domain)) seniority.set(domain, Number(row.seq));
    }
  });
  if (!seniority.has(ours)) return roster; // we are not in the room
  const roomServers = [...seniority.entries()]
    .filter(([d]) => d !== ours && d !== ctx.excludeName && !roster.includes(d))
    .sort((a, b) => a[1] - b[1])
    .map(([d]) => d);
  return [...roster, ...roomServers];
}

// --- blocks (server-name globs) ------------------------------------------

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*');
  return new RegExp('^' + escaped + '$');
}

export async function isBlocked(name: string): Promise<boolean> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query('SELECT pattern FROM federation_blocks;');
    return r.rows.some((row: unknown) =>
      globToRegex(String((row as Record<string, unknown>).pattern)).test(name)
    );
  });
}

export async function addBlock(
  pattern: string,
  note: string | null,
): Promise<void> {
  await withDb(serverDb(), async (c) => {
    await c.query(
      'INSERT INTO federation_blocks (pattern, added_ms, note) VALUES ($1, $2, $3) ON CONFLICT (pattern) DO UPDATE SET added_ms = $2, note = $3;',
      [pattern, Date.now(), note],
    );
  });
}

export async function removeBlock(pattern: string): Promise<boolean> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'DELETE FROM federation_blocks WHERE pattern = $1;',
      [pattern],
    );
    return (r.rowCount !== undefined ? r.rowCount : 0) > 0;
  });
}

export async function listBlocks(): Promise<BlockRow[]> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT pattern, added_ms, note FROM federation_blocks ORDER BY added_ms;',
    );
    return r.rows.map((row: unknown) => {
      const o = row as Record<string, unknown>;
      return {
        pattern: String(o.pattern),
        added_ms: Number(o.added_ms),
        note: o.note === null ? null : String(o.note),
      };
    });
  });
}

// --- the door log -----------------------------------------------------------

/**
 * recordPending — one row per (name, kind). Writes for one name coalesce
 * within federation.keyfailminutes (count/last_ms updated in place).
 * verified = FALSE rows (unverified claims) are hard-capped at
 * federation.pendingmax — the oldest last_ms is evicted on insert — and
 * pruned after federation.pendingdays.
 */
export async function recordPending(
  name: string,
  kind: 'inbound' | 'outbound' | 'disagreement',
  verified: boolean,
  detail: string | null,
): Promise<void> {
  const fed = config().federation;
  const now = Date.now();
  const coalesceMs = fed.keyfailminutes * 60_000;
  await withDb(serverDb(), async (c) => {
    const existing = await c.query(
      'SELECT first_ms, last_ms, count FROM federation_pending WHERE name = $1 AND kind = $2;',
      [name, kind],
    );
    if (
      existing.rows.length > 0 &&
      now - Number((existing.rows[0] as Record<string, unknown>).last_ms) <
        coalesceMs
    ) {
      await c.query(
        'UPDATE federation_pending SET last_ms = $3, count = count + 1, detail = $4, verified = federation_pending.verified OR $5 WHERE name = $1 AND kind = $2;',
        [name, kind, now, detail, verified],
      );
    } else {
      await c.query(
        'INSERT INTO federation_pending (name, kind, verified, first_ms, last_ms, count, detail) VALUES ($1, $2, $3, $4, $5, 1, $6) ON CONFLICT (name, kind) DO UPDATE SET first_ms = $4, last_ms = $5, count = 1, detail = $6, verified = $3;',
        [name, kind, verified, now, now, detail],
      );
    }
    if (!verified) {
      // hard cap on unverified rows: rows beyond pendingmax (oldest
      // last_ms) are deleted by PK, two passes — Doltgres rejects the
      // tuple-IN subquery form
      const surplus = await c.query(
        'SELECT name, kind FROM federation_pending WHERE verified = FALSE ORDER BY last_ms DESC OFFSET $1;',
        [fed.pendingmax],
      );
      for (const row of surplus.rows) {
        const o = row as Record<string, unknown>;
        await c.query(
          'DELETE FROM federation_pending WHERE name = $1 AND kind = $2;',
          [String(o.name), String(o.kind)],
        );
      }
      // expiry
      await c.query(
        'DELETE FROM federation_pending WHERE verified = FALSE AND last_ms < $1;',
        [now - fed.pendingdays * 86_400_000],
      );
    }
  });
}

export async function listPending(): Promise<PendingRow[]> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT name, kind, verified, first_ms, last_ms, count, detail FROM federation_pending ORDER BY last_ms DESC;',
    );
    return r.rows.map((row: unknown) => {
      const o = row as Record<string, unknown>;
      return {
        name: String(o.name),
        kind: String(o.kind) as PendingRow['kind'],
        verified: Boolean(o.verified),
        first_ms: Number(o.first_ms),
        last_ms: Number(o.last_ms),
        count: Number(o.count),
        detail: o.detail === null ? null : String(o.detail),
      };
    });
  });
}

/** approve → move the pending claim onto the roster. */
export async function approvePending(
  name: string,
  host: string | null,
  port: number | null,
): Promise<void> {
  const existing = await lookupPeer(name);
  if (existing !== null) return;
  await addPeer({
    name,
    host,
    port,
    trust: 'ca',
    addedBy: 'approval',
  });
}

/** reject → drop the claim; with block=true also refuse the name forward. */
export async function rejectPending(
  name: string,
  block: boolean,
): Promise<void> {
  await withDb(serverDb(), async (c) => {
    await c.query('DELETE FROM federation_pending WHERE name = $1;', [name]);
  });
  if (block) await addBlock(name, 'rejected at the door');
}
