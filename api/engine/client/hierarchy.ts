// Space traversal owns pagination, not room membership or metadata policy.
import { theApp } from '#engine/app.ts';
import { config } from '#engine/config.ts';
import { domainOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { recoverableUpstream } from '#engine/net/upstream-error.ts';
import type { Store } from '#engine/store/index.ts';
import {
  localDiscoverySummary,
  remoteDiscoveryHierarchy,
} from './discovery.ts';
import { lookupRoom, requireRoom } from './room.ts';
import { renderStateEvent } from './render.ts';
import { admitState } from './state-admission.ts';

type Json = Record<string, unknown>;
type Child = {
  type: 'm.space.child';
  state_key: string;
  content: Json;
  sender: string;
  origin_server_ts: number;
};
type Entry = { id: string; via: string[]; depth: number };
type Walk = {
  user: string;
  root: string;
  suggested: boolean;
  depth: number | null;
  pending: Entry[];
  visited: string[];
  expires: number;
};
const sessions = new WeakMap<Store, Map<string, Walk>>();
function invalid(message: string): never {
  throw new MatrixError(400, 'M_INVALID_PARAM', message);
}
function forbidden(): never {
  throw new MatrixError(403, 'M_FORBIDDEN', 'room not accessible');
}

function validChild(raw: unknown, suggested: boolean): raw is Child {
  if (raw === null || typeof raw !== 'object') return false;
  const e = raw as Child, c = e.content;
  return e.type === 'm.space.child' && typeof e.state_key === 'string' &&
    e.state_key.startsWith('!') &&
    c !== null && typeof c === 'object' && Array.isArray(c.via) &&
    c.via.length > 0 &&
    c.via.every((v) => typeof v === 'string' && v.length > 0) &&
    (!suggested || c.suggested === true) &&
    typeof e.sender === 'string' && Number.isSafeInteger(e.origin_server_ts);
}
function childrenOf(summary: Json, suggested: boolean): Child[] {
  if (
    summary.room_type !== 'm.space' || !Array.isArray(summary.children_state)
  ) return [];
  const order = (e: Child) =>
    typeof e.content.order === 'string' &&
      /^[\x20-\x7e]{0,50}$/.test(e.content.order)
      ? e.content.order
      : null;
  return summary.children_state.filter((e): e is Child =>
    validChild(e, suggested)
  ).sort((a, b) => {
    const x = order(a), y = order(b);
    return Number(x === null) - Number(y === null) ||
      (x !== null && y !== null ? (x < y ? -1 : x > y ? 1 : 0) : 0) ||
      a.origin_server_ts - b.origin_server_ts ||
      (a.state_key < b.state_key ? -1 : a.state_key > b.state_key ? 1 : 0);
  });
}
async function withChildren(summary: Json, suggested: boolean): Promise<Json> {
  const out = { ...summary, children_state: [] as Child[] };
  if (summary.room_type === 'm.space') {
    const room = await requireRoom(String(summary.room_id));
    const admission = await admitState(room, { userId: null, discovery: true });
    for (const row of admission.rows) {
      if (row.type !== 'm.space.child') continue;
      const event = await renderStateEvent(room, row.eventId, undefined, {
        bundleThreads: false,
        admission,
      });
      if (validChild(event, suggested)) {
        out.children_state.push({
          type: 'm.space.child',
          state_key: event.state_key,
          content: event.content,
          sender: event.sender,
          origin_server_ts: event.origin_server_ts,
        });
      }
    }
    out.children_state = childrenOf(out, suggested);
  }
  return out;
}

export function hierarchyQuery(query: URLSearchParams) {
  const number = (key: string, min: number, fallback: number | null) => {
    const raw = query.get(key);
    if (raw === null) return fallback;
    if (
      !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) ||
      Number(raw) < min
    ) invalid('invalid ' + key);
    return Number(raw);
  };
  const suggested = query.get('suggested_only');
  if (suggested !== null && suggested !== 'true' && suggested !== 'false') {
    invalid('invalid suggested_only');
  }
  const limits = config().hierarchy;
  const depth = number('max_depth', 0, null);
  return {
    limit: Math.min(number('limit', 1, limits.pagesize)!, limits.maxpagesize),
    depth: limits.maxdepth > 0
      ? Math.min(depth ?? limits.maxdepth, limits.maxdepth)
      : depth,
    suggested: suggested === 'true',
    from: query.get('from'),
  };
}

async function clientRoom(
  entry: Entry,
  user: string,
  suggested: boolean,
): Promise<{ summary: Json; inaccessible: string[] } | null> {
  const held = await lookupRoom(entry.id);
  if (held !== null) {
    const summary = await localDiscoverySummary(entry.id, { user });
    return summary === null
      ? null
      : { summary: await withChildren(summary, suggested), inaccessible: [] };
  }
  try {
    const remote = await remoteDiscoveryHierarchy(
      entry.id,
      user,
      entry.via,
      suggested,
    );
    return remote === null ? null : {
      summary: {
        ...remote.room,
        children_state: childrenOf(remote.room, suggested),
      },
      inaccessible: remote.inaccessible,
    };
  } catch (error) {
    if (
      !(error instanceof MatrixError && error.status < 500) &&
      !recoverableUpstream(error)
    ) throw error;
    return null;
  }
}

export async function clientHierarchy(
  root: string,
  user: string,
  options: ReturnType<typeof hierarchyQuery>,
) {
  const app = theApp(), limits = config().hierarchy, now = Date.now();
  let cache = sessions.get(app.store);
  if (cache === undefined) {
    cache = new Map();
    sessions.set(app.store, cache);
  }
  for (const [token, session] of cache) {
    if (session.expires <= now) cache.delete(token);
  }
  const rootEntry = {
    id: root,
    via: domainOf(root) === null ? [] : [domainOf(root)!],
    depth: 0,
  };
  let walk: Walk;
  if (options.from !== null) {
    const saved = cache.get(options.from);
    if (
      saved === undefined || saved.user !== user || saved.root !== root ||
      saved.suggested !== options.suggested || saved.depth !== options.depth
    ) invalid('unknown pagination token');
    walk = structuredClone(saved);
  } else {
    walk = {
      user,
      root,
      suggested: options.suggested,
      depth: options.depth,
      pending: [rootEntry],
      visited: [],
      expires: now + limits.sessionseconds * 1000,
    };
  }
  // Continuing a walk does not retain access that was revoked between pages.
  const rootSummary = await clientRoom(rootEntry, user, options.suggested);
  if (rootSummary === null) forbidden();
  const visited = new Set(walk.visited), rooms: Json[] = [];
  let work = 0;
  while (
    walk.pending.length && rooms.length < options.limit &&
    work++ < limits.maxpagesize
  ) {
    const entry = walk.pending.pop()!;
    if (visited.has(entry.id)) continue;
    visited.add(entry.id);
    const result = entry.id === root
      ? rootSummary
      : await clientRoom(entry, user, options.suggested);
    if (result === null) continue;
    const { summary, inaccessible } = result;
    const children = childrenOf(summary, options.suggested);
    rooms.push({ ...summary, children_state: children });
    if (options.depth === null || entry.depth < options.depth) {
      for (const child of [...children].reverse()) {
        if (
          !visited.has(child.state_key) &&
          !inaccessible.includes(child.state_key)
        ) {
          walk.pending.push({
            id: child.state_key,
            via: child.content.via as string[],
            depth: entry.depth + 1,
          });
        }
      }
    }
    if (visited.size + walk.pending.length > limits.maxrooms) {
      throw new MatrixError(
        503,
        'M_UNKNOWN',
        'hierarchy traversal exceeds configured room budget',
      );
    }
  }
  if (!walk.pending.length) return { rooms };
  walk.visited = [...visited];
  // Replaying a continuation must not allocate another retained cursor. Access
  // is still recomputed above, so this reuses state, not an authorization result.
  const serialized = JSON.stringify(walk);
  for (const [token, saved] of cache) {
    if (saved.user === user && JSON.stringify(saved) === serialized) {
      return { rooms, next_batch: token };
    }
  }
  const owned =
    [...cache.values()].filter((saved) => saved.user === user).length;
  if (cache.size >= limits.maxsessions || owned >= limits.maxsessionsperuser) {
    throw new MatrixError(
      503,
      'M_UNKNOWN',
      'hierarchy pagination capacity reached',
    );
  }
  const next = crypto.randomUUID();
  cache.set(next, walk);
  return { rooms, next_batch: next };
}

export async function federationHierarchy(
  root: string,
  origin: string,
  suggested: boolean,
) {
  const summary = await localDiscoverySummary(root, { origin });
  if (summary === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not accessible');
  }
  const room = await withChildren(summary, suggested),
    children: Json[] = [],
    inaccessible: string[] = [];
  const seen = new Set<string>();
  for (const edge of childrenOf(room, suggested)) {
    if (seen.has(edge.state_key)) continue;
    seen.add(edge.state_key);
    if (await lookupRoom(edge.state_key) === null) continue;
    const child = await localDiscoverySummary(edge.state_key, { origin });
    if (child === null) inaccessible.push(edge.state_key);
    else children.push(child);
  }
  return { room, children, inaccessible_children: inaccessible };
}
