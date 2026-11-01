// api/engine/federation/peers.ts — the roster, the blocks, and the door
// log (federation_pending). Runtime data: who we know / refuse / what
// knocks — the operator reviews through the tools. The witness set for
// key acquisition is operator/approval rows only (never rows created by
// a user's invite). Every function takes the server file's Db explicitly
// (the Turso core has no global database); approve/reject belong to the
// admission gate (4c-2). Ported from doltgres, Postgres idioms left
// behind (booleans are INTEGER 0/1; the tuple-IN workaround becomes one
// rowid pass).
import { config } from '#engine/config.ts';
import type { Database as Db } from '#engine/store/db.ts';

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
  // 'refused' is a delivery record (refusals, expired rows), NOT a knock;
  // approve refuses it (nothing to admit) — the gate's call in 4c-2
  kind: 'inbound' | 'outbound' | 'disagreement' | 'refused';
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

export async function lookupPeer(
  server: Db,
  name: string,
): Promise<PeerRow | null> {
  const rows = await server.query(
    'SELECT name, host, port, trust, pin_spki_sha256, added_ms, added_by, note FROM federation_peers WHERE name = ?',
    [name],
  );
  return rows.length === 0 ? null : peerOf(rows[0]);
}

export async function addPeer(
  server: Db,
  opts: {
    name: string;
    host: string | null;
    port: number | null;
    trust: 'ca' | 'pinned' | 'keyname';
    pin?: string | null;
    addedBy: string;
    note?: string | null;
  },
): Promise<void> {
  const pin = opts.pin !== undefined ? opts.pin : null;
  const note = opts.note !== undefined ? opts.note : null;
  await server.tx(async (tx) => {
    await tx.execute(
      'INSERT INTO federation_peers(name, host, port, trust, pin_spki_sha256, added_ms, added_by, note) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET host = excluded.host, port = excluded.port, trust = excluded.trust, pin_spki_sha256 = excluded.pin_spki_sha256, added_ms = excluded.added_ms, added_by = excluded.added_by, note = excluded.note',
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
    await tx.execute(
      "DELETE FROM federation_pending WHERE name = ? AND kind IN ('inbound', 'outbound')",
      [opts.name],
    );
  });
}

export async function removePeer(server: Db, name: string): Promise<boolean> {
  const n = await server.execute(
    'DELETE FROM federation_peers WHERE name = ?',
    [name],
  );
  return n > 0;
}

export async function listPeers(server: Db): Promise<PeerRow[]> {
  const rows = await server.query(
    'SELECT name, host, port, trust, pin_spki_sha256, added_ms, added_by, note FROM federation_peers ORDER BY added_ms',
  );
  return rows.map(peerOf);
}

// seniority: oldest first. Operator/approval rows only, keyname rows are
// not notaries for others (their own document is unreachable by nature).
// The event's ROOM'S servers join the witness set after the roster
// witnesses — only while we are in the room (a room we left nominates
// nobody), ordered by the seq of each server's earliest joined member
// event (seniority in the room), minus ourselves and the name being
// looked up.
export async function listWitnesses(
  server: Db,
  ctx?: { roomId?: string; excludeName?: string },
): Promise<string[]> {
  const peers = await listPeers(server);
  const roster = peers
    .filter((p) =>
      (p.added_by === 'operator' || p.added_by === 'approval') &&
      p.trust !== 'keyname'
    )
    .map((p) => p.name);
  if (ctx?.roomId === undefined) return roster;
  const ours = config().server.name;
  const seniority = new Map<string, number>();
  const rows = await server.query(
    "SELECT user, seq FROM memberships WHERE room = ? AND membership = 'join' ORDER BY seq ASC",
    [ctx.roomId],
  );
  for (const row of rows) {
    const uid = String(row.user);
    const at = uid.indexOf(':');
    if (at < 0) continue;
    const domain = uid.slice(at + 1);
    if (!seniority.has(domain)) seniority.set(domain, Number(row.seq));
  }
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

export async function isBlocked(server: Db, name: string): Promise<boolean> {
  const rows = await server.query('SELECT pattern FROM federation_blocks');
  return rows.some((row) => globToRegex(String(row.pattern)).test(name));
}

export async function addBlock(
  server: Db,
  pattern: string,
  note: string | null,
): Promise<void> {
  await server.execute(
    'INSERT INTO federation_blocks(pattern, added_ms, note) VALUES(?,?,?) ON CONFLICT(pattern) DO UPDATE SET added_ms = excluded.added_ms, note = excluded.note',
    [pattern, Date.now(), note],
  );
}

export async function removeBlock(
  server: Db,
  pattern: string,
): Promise<boolean> {
  const n = await server.execute(
    'DELETE FROM federation_blocks WHERE pattern = ?',
    [pattern],
  );
  return n > 0;
}

export async function listBlocks(server: Db): Promise<BlockRow[]> {
  const rows = await server.query(
    'SELECT pattern, added_ms, note FROM federation_blocks ORDER BY added_ms',
  );
  return rows.map((row) => ({
    pattern: String(row.pattern),
    added_ms: Number(row.added_ms),
    note: row.note === null ? null : String(row.note),
  }));
}

// --- the door log -----------------------------------------------------------

// one row per (name, kind). Writes for one name coalesce within
// federation.keyfailminutes (count/last_ms updated in place). Unverified
// rows (verified = 0) are hard-capped at federation.pendingmax — the
// oldest last_ms is evicted on insert — and pruned after
// federation.pendingdays.
export async function recordPending(
  server: Db,
  name: string,
  kind: 'inbound' | 'outbound' | 'disagreement' | 'refused',
  verified: boolean,
  detail: string | null,
): Promise<void> {
  const fed = config().federation;
  const now = Date.now();
  const coalesceMs = fed.keyfailminutes * 60_000;
  await server.tx(async (tx) => {
    const existing = await tx.query(
      'SELECT first_ms, last_ms, count FROM federation_pending WHERE name = ? AND kind = ?',
      [name, kind],
    );
    if (
      existing.length > 0 && now - Number(existing[0].last_ms) < coalesceMs
    ) {
      await tx.execute(
        'UPDATE federation_pending SET last_ms = ?, count = count + 1, detail = ?, verified = verified OR ? WHERE name = ? AND kind = ?',
        [now, detail, verified ? 1 : 0, name, kind],
      );
    } else {
      await tx.execute(
        'INSERT INTO federation_pending(name, kind, verified, first_ms, last_ms, count, detail) VALUES(?,?,?,?,?,1,?) ON CONFLICT(name, kind) DO UPDATE SET first_ms = excluded.first_ms, last_ms = excluded.last_ms, count = 1, detail = excluded.detail, verified = excluded.verified',
        [name, kind, verified ? 1 : 0, now, now, detail],
      );
    }
    if (!verified) {
      // hard cap on unverified rows: rows beyond pendingmax (oldest
      // last_ms) are deleted, one rowid pass
      await tx.execute(
        'DELETE FROM federation_pending WHERE verified = 0 AND rowid NOT IN (SELECT rowid FROM federation_pending WHERE verified = 0 ORDER BY last_ms DESC LIMIT ?)',
        [fed.pendingmax],
      );
      // expiry
      await tx.execute(
        'DELETE FROM federation_pending WHERE verified = 0 AND last_ms < ?',
        [now - fed.pendingdays * 86_400_000],
      );
    }
  });
}

export async function listPending(server: Db): Promise<PendingRow[]> {
  const rows = await server.query(
    'SELECT name, kind, verified, first_ms, last_ms, count, detail FROM federation_pending ORDER BY last_ms DESC',
  );
  return rows.map((row) => ({
    name: String(row.name),
    kind: String(row.kind) as PendingRow['kind'],
    verified: Number(row.verified) !== 0,
    first_ms: Number(row.first_ms),
    last_ms: Number(row.last_ms),
    count: Number(row.count),
    detail: row.detail === null ? null : String(row.detail),
  }));
}
