// api/engine/adopt.ts — dispute-path re-resolution from the DAG (F0).
// Recomputes room state by folding every known event in depth order
// (parents always have smaller depth), checking authorized() per event,
// and calling the shared resolveState at merges and across the frontier.
// The image/DAG is the authority; any `state` row without a validated
// event behind it (e.g. a forged conflict-free row from a peer image) is
// dropped by construction — state is rewritten from the replay only.
// Computes everything BEFORE writing: on M_UNRESOLVED_CONFLICT nothing
// is stored and the error surfaces (refusal rolls back before adopted
// state is visible).
import { ident, withDb } from './db.ts';
import { lookupRoom } from './room.ts';
import { eventIdFor } from './eventid.ts';
import { getRulebook, stateKeyOf, type AuthContext, type StateMap } from './policy.ts';
import { materialize, type StateRowInput } from './materialize.ts';
import type { Pdu } from './pdu.ts';

function parseStoredPdu(v: unknown): Pdu {
  if (typeof v === 'string') return JSON.parse(v) as Pdu;
  return v as Pdu;
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

export interface ReresolveResult {
  eventCount: number;
  stateRows: number;
}

// Re-resolve room state from the DAG on the newest extremity tip. Validates
// every event (id recompute + declared auth_events + authorized()); skips
// rejected events (in DAG, out of state); rewrites `state` via
// materialize() and commits. Throws M_UNRESOLVED_CONFLICT (writing
// nothing) when the frontier is contested.
export async function reresolveFromDag(roomId: string): Promise<ReresolveResult> {
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  const rulebook = getRulebook(room.roomVersion);

  // union across alive extremity tips
  const tips: { branch: string; hash: string }[] = await withDb(
    room.dbName,
    async (c) => {
      const b = await c.query('SELECT name FROM dolt.branches;');
      // deno-lint-ignore no-explicit-any
      const xb = (b.rows as any[]).map((r) => String(r.name)).filter((n: string) =>
        n.startsWith('x')
      );
      const out: { branch: string; hash: string }[] = [];
      for (const name of xb) {
        const h = await c.query(
          `SELECT (SELECT HASHOF('${ident(name)}')) AS h;`,
        );
        out.push({ branch: name, hash: String(h.rows[0].h) });
      }
      return out;
    },
  );
  if (tips.length === 0) throw new Error('M_NO_EXTREMITIES: ' + roomId);

  const byId = new Map<string, Pdu>();
  await withDb(room.dbName, async (c) => {
    for (const t of tips) {
      const r = await c.query(
        `SELECT canonical_json FROM events AS OF '${t.hash}';`,
      );
      // deno-lint-ignore no-explicit-any
      for (const row of r.rows as any[]) {
        const pdu = parseStoredPdu(row.canonical_json);
        if (pdu.event_id && !byId.has(pdu.event_id)) byId.set(pdu.event_id, pdu);
      }
    }
  });
  const all = [...byId.values()];

  // validate ids (forgery check — forged events abort before anything)
  for (const pdu of all) {
    const expect = await eventIdFor(
      pdu as unknown as Record<string, unknown>,
      room.roomVersion,
    );
    if (expect !== pdu.event_id) {
      throw new Error('M_BAD_IMAGE: event id does not recompute');
    }
  }

  const createEvt = all.find((e) =>
    e.type === 'm.room.create' && (e.prev_events ?? []).length === 0
  );
  if (!createEvt?.event_id) throw new Error('M_NO_CREATE: DAG has no create');
  const createEventId = createEvt.event_id;
  const getEvent = (id: string) => byId.get(id);
  const ordered = [...all].sort((a, b) =>
    a.depth - b.depth || (a.event_id! < b.event_id! ? -1 : 1)
  );
  const stateAt = new Map<string, StateMap>();
  for (const pdu of ordered) {
    const prevs = pdu.prev_events ?? [];
    for (const p of prevs) {
      if (!byId.has(p)) throw new Error('M_UNKNOWN_PREV: ' + p);
    }
    const parents = prevs.map((p) => stateAt.get(p) ?? new Map());
    const resolved = rulebook.resolveState(parents); // throws on conflict
    const ctx: AuthContext = { stateAtPrevs: resolved, getEvent, createEventId };
    const next = new Map(resolved);
    // Rejected events stay in the DAG but out of state — and their
    // pass-through state MUST still be tracked, or descendants (and a
    // refused frontier tip) would resolve against an empty map and wipe
    // real state (every event gets a stateAt entry, always).
    let admitted = pdu.type === 'm.room.create';
    if (!admitted) {
      const selected = rulebook.selectAuthEvents(pdu, ctx);
      admitted = sameIdSet(pdu.auth_events ?? [], selected) &&
        rulebook.authorized(pdu, ctx) === 'ok';
    }
    if (admitted && pdu.state_key != null) {
      next.set(stateKeyOf(pdu.type, pdu.state_key), pdu.event_id!);
    }
    stateAt.set(pdu.event_id!, next);
  }
  // frontier resolve across tips with no children
  const hasChild = new Set<string>();
  for (const e of all) for (const p of e.prev_events ?? []) hasChild.add(p);
  const frontier = all.filter((e) => !hasChild.has(e.event_id!));
  const final = rulebook.resolveState(
    frontier.map((t) => stateAt.get(t.event_id!) ?? new Map()),
  );
  const rows: StateRowInput[] = [];
  for (const [k, eid] of final) {
    const ep = byId.get(eid);
    if (!ep) throw new Error('E_STATE_EVENT_MISSING: ' + eid);
    const sep = k.indexOf('\0');
    rows.push({
      type: k.slice(0, sep),
      stateKey: k.slice(sep + 1),
      eventId: eid,
      content: ep.content ?? {},
    });
  }

  // newest tip first (S2 ordering)
  tips.sort((a, b) => (a.branch < b.branch ? 1 : -1));
  const newest = tips[0];
  await withDb(room.dbName, async (c) => {
    await c.query(`SELECT DOLT_CHECKOUT('${ident(newest.branch)}');`);
    await materialize(c, rows);
    await c.query(`SELECT DOLT_COMMIT('-Am', 'reresolve: ${rows.length} state rows from ${all.length} events');`);
  });
  return { eventCount: all.length, stateRows: rows.length };
}
