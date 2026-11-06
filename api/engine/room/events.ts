// api/engine/room/events.ts — R1–R3: immutable events, their edges and
// mutable status. `events` rows are plain INSERTs (never updated or
// deleted; a duplicate id is a constraint error — redelivery idempotency
// is the ingest layer's composition). Edge order preserves PDU list order.
import type { Conn } from '#engine/store/db.ts';
import type { Row } from '#engine/store/ffi.ts';
import type { EdgeKind, EdgeOverlay } from '#engine/room/edges.ts';

export type EventRow = {
  id: string;
  pdu: string;
  type: string;
  state_key: string | null;
  sender: string;
  depth: number;
  origin_ts: number;
};

export type Standing = 'accepted' | 'rejected' | 'soft_failed';
export type Grounding = 'grounded' | 'evidence' | 'pending';

export type Status = {
  standing: Standing;
  grounding: Grounding;
  origin: string | null;
  received_ts: number;
};

const STANDINGS: ReadonlySet<string> = new Set([
  'accepted',
  'rejected',
  'soft_failed',
]);
const GROUNDINGS: ReadonlySet<string> = new Set([
  'grounded',
  'evidence',
  'pending',
]);

// Edge ids come from the stored PDU: prev_events/auth_events as string
// arrays, tolerating the legacy [id, {hashes}] pairs of old event formats.
export function edgeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) =>
    typeof entry === 'string' ? entry : String((entry as unknown[])[0])
  );
}

function remember(cache: EdgeOverlay | undefined, id: string, pdu: string) {
  if (cache === undefined) return;
  const parsed = JSON.parse(pdu);
  cache.set(id, 'prev', edgeIds(parsed.prev_events));
  cache.set(id, 'auth', edgeIds(parsed.auth_events));
}

export async function insertEvent(
  conn: Conn,
  id: string,
  pdu: string,
  cache?: EdgeOverlay,
): Promise<void> {
  const parsed: Record<string, unknown> = JSON.parse(pdu);
  const { type, sender, depth, origin_server_ts: originTs } = parsed;
  if (
    typeof type !== 'string' || typeof sender !== 'string' ||
    typeof depth !== 'number' || !Number.isSafeInteger(depth) ||
    typeof originTs !== 'number' || !Number.isSafeInteger(originTs)
  ) {
    throw new TypeError('event PDU lacks type/sender/depth/origin_server_ts');
  }
  const stateKey = 'state_key' in parsed ? parsed.state_key : null;
  if (stateKey !== null && typeof stateKey !== 'string') {
    throw new TypeError('event state_key must be a string when present');
  }
  await conn.execute(
    'INSERT INTO events(id, pdu, type, state_key, sender, depth, origin_ts) VALUES(?,?,?,?,?,?,?)',
    [id, pdu, type, stateKey, sender, depth, originTs],
  );
  for (const [ord, prev] of edgeIds(parsed.prev_events).entries()) {
    await conn.execute(
      'INSERT INTO prev_edges(event, prev, ord) VALUES(?,?,?)',
      [id, prev, ord],
    );
  }
  for (const [ord, auth] of edgeIds(parsed.auth_events).entries()) {
    await conn.execute(
      'INSERT INTO auth_edges(event, auth, ord) VALUES(?,?,?)',
      [id, auth, ord],
    );
  }
  remember(cache, id, pdu);
}

function eventOf(row: Row): EventRow {
  return {
    id: String(row.id),
    pdu: String(row.pdu),
    type: String(row.type),
    state_key: row.state_key === null ? null : String(row.state_key),
    sender: String(row.sender),
    depth: Number(row.depth),
    origin_ts: Number(row.origin_ts),
  };
}

export async function getEvent(
  conn: Conn,
  id: string,
  cache?: EdgeOverlay,
): Promise<EventRow | null> {
  const rows = await conn.query('SELECT * FROM events WHERE id = ?', [id]);
  if (rows.length === 0) return null;
  const event = eventOf(rows[0]);
  remember(cache, event.id, event.pdu);
  return event;
}

function* chunks(ids: readonly string[]): Generator<string[]> {
  for (let index = 0; index < ids.length; index += 500) {
    yield ids.slice(index, index + 500);
  }
}

export async function getEvents(
  conn: Conn,
  ids: readonly string[],
  cache?: EdgeOverlay,
): Promise<Map<string, EventRow>> {
  const found = new Map<string, EventRow>();
  for (const chunk of chunks(ids)) {
    const marks = chunk.map(() => '?').join(',');
    const rows = await conn.query(
      `SELECT * FROM events WHERE id IN (${marks})`,
      chunk,
    );
    for (const row of rows) {
      const event = eventOf(row);
      remember(cache, event.id, event.pdu);
      found.set(event.id, event);
    }
  }
  return found;
}

export async function prevsOf(
  conn: Conn,
  event: string,
  cache?: EdgeOverlay,
): Promise<string[]> {
  if (cache !== undefined) {
    return [...(await forwardEdges(conn, [event], 'prev', cache)).get(event)!];
  }
  const rows = await conn.query(
    'SELECT prev FROM prev_edges WHERE event = ? ORDER BY ord',
    [event],
  );
  return rows.map((row) => String(row.prev));
}

export async function authsOf(
  conn: Conn,
  event: string,
  cache?: EdgeOverlay,
): Promise<string[]> {
  if (cache !== undefined) {
    return [...(await forwardEdges(conn, [event], 'auth', cache)).get(event)!];
  }
  const rows = await conn.query(
    'SELECT auth FROM auth_edges WHERE event = ? ORDER BY ord',
    [event],
  );
  return rows.map((row) => String(row.auth));
}

export async function childrenOf(conn: Conn, prev: string): Promise<string[]> {
  const rows = await conn.query(
    'SELECT event FROM prev_edges WHERE prev = ? ORDER BY event',
    [prev],
  );
  return rows.map((row) => String(row.event));
}

export async function authChildrenOf(
  conn: Conn,
  auth: string,
): Promise<string[]> {
  const rows = await conn.query(
    'SELECT event FROM auth_edges WHERE auth = ? ORDER BY event',
    [auth],
  );
  return rows.map((row) => String(row.event));
}

export async function setStatus(
  conn: Conn,
  event: string,
  status: Status,
): Promise<void> {
  if (!STANDINGS.has(status.standing) || !GROUNDINGS.has(status.grounding)) {
    throw new TypeError(
      `unknown standing/grounding: ${status.standing}/${status.grounding}`,
    );
  }
  await conn.execute(
    `INSERT INTO event_status(event, standing, grounding, origin, received_ts) VALUES(?,?,?,?,?)
     ON CONFLICT(event) DO UPDATE SET standing = excluded.standing,
       grounding = excluded.grounding, origin = excluded.origin,
       received_ts = excluded.received_ts`,
    [
      event,
      status.standing,
      status.grounding,
      status.origin,
      status.received_ts,
    ],
  );
}

function statusOf(row: Row): Status {
  return {
    standing: String(row.standing) as Standing,
    grounding: String(row.grounding) as Grounding,
    origin: row.origin === null ? null : String(row.origin),
    received_ts: Number(row.received_ts),
  };
}

export async function getStatus(
  conn: Conn,
  event: string,
): Promise<Status | null> {
  const rows = await conn.query(
    'SELECT * FROM event_status WHERE event = ?',
    [event],
  );
  return rows.length === 0 ? null : statusOf(rows[0]);
}

export async function statuses(
  conn: Conn,
  events: readonly string[],
): Promise<Map<string, Status>> {
  const found = new Map<string, Status>();
  for (const chunk of chunks(events)) {
    const marks = chunk.map(() => '?').join(',');
    const rows = await conn.query(
      `SELECT * FROM event_status WHERE event IN (${marks})`,
      chunk,
    );
    for (const row of rows) found.set(String(row.event), statusOf(row));
  }
  return found;
}

// A bounded indexed walk over one edge table: BFS with a sorted frontier
// per level (deterministic); seeds count toward the limit; ids in `stops`
// are visited but never expanded; `truncated` marks an unfinished walk.
export type Walk = { ids: string[]; truncated: boolean };

async function forwardEdges(
  conn: Conn,
  ids: readonly string[],
  kind: EdgeKind,
  cache: EdgeOverlay,
) {
  const found = new Map<string, readonly string[]>();
  const missing: string[] = [];
  for (const id of ids) {
    const edges = cache.get(id, kind);
    if (edges === undefined) missing.push(id);
    else found.set(id, edges);
  }
  for (const chunk of chunks(missing)) {
    const marks = chunk.map(() => '?').join(',');
    // LEFT JOIN distinguishes an existing zero-edge event from an unknown id.
    // Cache only the former: later evidence may supply the unknown event.
    const rows = await conn.query(
      `SELECT e.id AS event, edges.${kind} AS target FROM events e LEFT JOIN ${kind}_edges edges ON edges.event = e.id WHERE e.id IN (${marks}) ORDER BY e.id, edges.ord`,
      chunk,
    );
    const held = new Map<string, string[]>();
    for (const row of rows) {
      const id = String(row.event);
      let edges = held.get(id);
      if (edges === undefined) {
        edges = [];
        held.set(id, edges);
      }
      if (row.target !== null) edges.push(String(row.target));
    }
    for (const id of chunk) {
      const edges = held.get(id);
      found.set(id, edges ?? []);
      if (edges !== undefined) cache.set(id, kind, edges);
    }
  }
  return found;
}

async function walk(
  conn: Conn,
  seeds: readonly string[],
  stops: ReadonlySet<string>,
  limit: number,
  table: 'prev_edges' | 'auth_edges',
  column: 'prev' | 'auth',
  cache?: EdgeOverlay,
): Promise<Walk> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('walk limit must be a positive safe integer');
  }
  const visited = new Set<string>();
  const ids: string[] = [];
  let frontier = [...new Set(seeds)].sort();
  let truncated = false;
  while (frontier.length > 0) {
    const fresh = frontier.filter((id) => !visited.has(id));
    for (const id of fresh) {
      if (visited.size >= limit) {
        truncated = true;
        break;
      }
      visited.add(id);
      ids.push(id);
    }
    if (truncated) break;
    const expandable = fresh.filter((id) => !stops.has(id));
    const next = new Set<string>();
    if (cache !== undefined) {
      for (
        const edges of (await forwardEdges(conn, expandable, column, cache))
          .values()
      ) {
        for (const target of edges) if (!visited.has(target)) next.add(target);
      }
    } else {
      for (const chunk of chunks(expandable)) {
        const marks = chunk.map(() => '?').join(',');
        const rows = await conn.query(
          `SELECT ${column} AS target FROM ${table} WHERE event IN (${marks})`,
          chunk,
        );
        for (const row of rows) {
          const target = String(row.target);
          if (!visited.has(target)) next.add(target);
        }
      }
    }
    frontier = [...next].sort();
  }
  return { ids, truncated };
}

export function authClosure(
  conn: Conn,
  seeds: readonly string[],
  limit: number,
  cache?: EdgeOverlay,
): Promise<Walk> {
  return walk(conn, seeds, new Set(), limit, 'auth_edges', 'auth', cache);
}

export function ancestors(
  conn: Conn,
  seeds: readonly string[],
  stopAt: readonly string[],
  limit: number,
  cache?: EdgeOverlay,
): Promise<Walk> {
  return walk(conn, seeds, new Set(stopAt), limit, 'prev_edges', 'prev', cache);
}
