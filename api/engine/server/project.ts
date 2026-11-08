// api/engine/server/project.ts — R12: project a room's change log into the
// server file. Every change kind applies idempotently, keyed by (room, pos)
// for the derived rows and (room, pos, destination) for the outbox; the
// feed's seq is assigned here, in projection order, following each room's
// pos. The room's watermark advances in the same server transaction as the
// derived writes, so a crash replays the batch and changes nothing — and
// truth columns (outbox state, receipts, presence, forgotten) are never
// touched. The server file is durable truth for seq, delivery progress and
// user intent; it is never rebuilt from scratch.
//
// History is never news: history/evidence/pending events are indexed
// without a seq. Only live accepted events (positioned on a stay) enter
// the feed, relations and search — the old ingest's "seq IS NOT NULL"
// rule (requirements §4.3 I12), now structurally: the room positions
// exactly those events.
import type { Change } from '#engine/room/changes.ts';
import { openRoom, type Room } from '#engine/room/index.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Conn } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import { advance, get } from '#engine/store/watermark.ts';
import { eventStreamTx, nextEventSeq } from '#engine/server/stream.ts';

// The watermark source naming a room's change log (storage plan's
// sources() enumerates these; tests already use this shape).
export function sourceOf(roomId: string): string {
  return 'room:' + roomId;
}

// The batch cap (plan §2): one server transaction per ≤ 500 changes.
const BATCH = 500;

// One projection at a time process-wide: the server file has one writer,
// and a queued call collapses into a cheap no-op once the watermark is
// caught up. A failed run must not jam the queue — the next write or the
// startup roll-forward retries.
let queue: Promise<void> = Promise.resolve();

// Projection listeners (the federation sender's wake, 4c-2): registered
// like the room hooks, fired after each completed projection. A listener
// never breaks the projection — errors are logged.
const projectedListeners:
  ((store: Store, roomId: string) => void | Promise<void>)[] = [];

export function onProjected(
  fn: (store: Store, roomId: string) => void | Promise<void>,
): () => void {
  projectedListeners.push(fn);
  return () => {
    const at = projectedListeners.indexOf(fn);
    if (at !== -1) projectedListeners.splice(at, 1);
  };
}

export function project(store: Store, roomId: string): Promise<void> {
  const run = queue.then(() => projectNow(store, roomId)).then(async () => {
    for (const fn of projectedListeners) {
      try {
        await fn(store, roomId);
      } catch (error) {
        console.error(`projection listener failed for ${roomId}:`, error);
      }
    }
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function projectNow(store: Store, roomId: string): Promise<void> {
  const server = await store.server();
  const room = await openRoom(store, roomId);
  const source = sourceOf(roomId);
  for (;;) {
    const mark = await get(server, source);
    const batch = await room.tx((tx) => tx.changes.after(mark, BATCH));
    if (batch.length === 0) return;
    const prepared = await prepare(room, store, roomId, batch);
    const addedMs = Date.now();
    await eventStreamTx(server, async (tx) => {
      for (const item of prepared) await apply(tx, roomId, item, addedMs);
      await advance(tx, source, batch[batch.length - 1].pos);
    });
  }
}

// --- the change payloads ---------------------------------------------------

// The 'event'/'transition'/'history' payloads share one shape (the room's
// change log writes it verbatim; a 'transition' adds `from`, a 'history'
// names its segment instead of the stay).
type EventPayload = {
  standing: string;
  reason: string | null;
  rule: string | null;
  type: string;
  state_key: string | null;
  sender: string;
  depth: number;
  origin_server_ts: number;
  stay: number | null;
  segment?: number | null;
  offset: number | null;
  grounding: string;
  origin: string | null;
};

type Prepared =
  & { change: Change }
  & (
    | {
      kind: 'event' | 'transition' | 'history';
      payload: EventPayload;
      relation: { relatesTo: string; relType: string | null } | null;
      search: { key: string; text: string } | null;
      // The publication this change carries (when it moves the stay's
      // published state): the m.room.member diff against the previous
      // published group — memberships follow the published state, not
      // only membership events (a fork resolution can flip a member
      // without a new membership event; the old fold caught it by
      // walking every published member row on every publish).
      publication: { user: string; to: string | null; toId: string | null }[];
    }
    | {
      kind: 'membership';
      user: string;
      to: string | null;
      toId: string | null;
    }
    | { kind: 'redaction'; target: string }
    | { kind: 'delivery'; destinations: string[] }
  );

function eventPayloadOf(change: Change): EventPayload {
  const data = JSON.parse(change.data) as EventPayload;
  if (typeof data.standing !== 'string' || typeof data.type !== 'string') {
    throw new Error(
      `malformed ${change.kind} change at pos ${change.pos}: ${change.data}`,
    );
  }
  return data;
}

// Live and positioned: the events that enter the feed, relations and
// search. Exactly the accepted events (the room positions no other).
function isLive(payload: EventPayload): boolean {
  return payload.standing === 'accepted' && payload.stay !== null;
}

// The publication diff at a change position: when the stay's published
// state moved at this change (a publication hangs off the event's change
// pos), the m.room.member keys that changed between the previous
// published group and the new one — added, removed, value- or
// event-flipped. An unchanged key is never re-stamped: the old fold's
// keep-its-seq rule falls out of the diff (it re-stamped every row whose
// event id moved and kept the rest). `to`/`toId` null means the key left
// the published state — the same 'leave' the reads default to without a
// row (MSC4115), mirrored by the membership path's delete.
async function memberDiff(
  room: Room,
  stay: number | null,
  pos: number,
): Promise<{ user: string; to: string | null; toId: string | null }[]> {
  if (stay === null) return [];
  return await room.tx(async (tx) => {
    const groupNow = await tx.state.publishedAt(stay, pos);
    const groupPrev = await tx.state.publishedAt(stay, pos - 1);
    if (groupNow === null || groupNow === groupPrev) return [];
    const nowMap = await tx.state.groupMap(groupNow);
    const prevMap = groupPrev === null
      ? new Map<string, string>()
      : await tx.state.groupMap(groupPrev);
    const prefix = 'm.room.member\0';
    const users = new Set<string>();
    for (const key of nowMap.keys()) {
      if (key.startsWith(prefix)) users.add(key.slice(prefix.length));
    }
    for (const key of prevMap.keys()) {
      if (key.startsWith(prefix)) users.add(key.slice(prefix.length));
    }
    const out: { user: string; to: string | null; toId: string | null }[] = [];
    for (const user of users) {
      const fromId = prevMap.get(prefix + user) ?? null;
      const toId = nowMap.get(prefix + user) ?? null;
      if (fromId === toId) continue;
      let to: string | null = null;
      if (toId !== null) {
        const row = await tx.events.get(toId);
        if (row === null) {
          throw new Error(`published member event missing: ${toId}`);
        }
        const membership = (JSON.parse(row.pdu) as Pdu).content?.membership;
        to = typeof membership === 'string' ? membership : 'leave';
      }
      out.push({ user, to, toId });
    }
    return out;
  });
}

// The read phase on the room file: every fact the server transaction
// needs, resolved against the (immutable) change positions of this batch.
async function prepare(
  room: Room,
  store: Store,
  roomId: string,
  batch: Change[],
): Promise<Prepared[]> {
  // The triggers of membership changes whose own event change sits in an
  // earlier batch: their feed rows are already committed in the server
  // file. The batch's own event changes resolve from the batch itself.
  const inBatch = new Map<string, { pos: number; stay: number }>();
  for (const change of batch) {
    if (
      (change.kind === 'event' || change.kind === 'transition') &&
      change.event !== null
    ) {
      const payload = eventPayloadOf(change);
      if (payload.stay !== null) {
        inBatch.set(change.event, { pos: change.pos, stay: payload.stay });
      }
    }
  }
  const out: Prepared[] = [];
  for (const change of batch) {
    switch (change.kind) {
      case 'event':
      case 'transition':
      case 'history': {
        if (change.event === null) {
          throw new Error(`${change.kind} change without an event id`);
        }
        const payload = eventPayloadOf(change);
        let relation: { relatesTo: string; relType: string | null } | null =
          null;
        let search: { key: string; text: string } | null = null;
        if (change.kind !== 'history' && isLive(payload)) {
          const pdu = await room.tx(async (tx) => {
            const row = await tx.events.get(change.event!);
            return row === null
              ? null
              : (JSON.parse(row.pdu) as Record<string, unknown>);
          });
          if (pdu !== null) {
            relation = relationOf(pdu);
            search = searchTextOf(payload, pdu);
          }
        }
        const publication = change.kind === 'history'
          ? []
          : await memberDiff(room, payload.stay, change.pos);
        out.push({
          change,
          kind: change.kind,
          payload,
          relation,
          search,
          publication,
        });
        break;
      }
      case 'membership': {
        if (change.event === null) {
          throw new Error('membership change without an event id');
        }
        const data = JSON.parse(change.data) as {
          user?: unknown;
          to?: unknown;
        };
        if (typeof data.user !== 'string') {
          throw new Error(
            `malformed membership change at pos ${change.pos}: ${change.data}`,
          );
        }
        const to = typeof data.to === 'string' ? data.to : null;
        // The published member event of `to` (the old fold's own event):
        // the publication at the trigger's event-change position. The
        // trigger's (stay, pos) comes from this batch or — already
        // projected — from its feed row.
        let toId: string | null = null;
        if (to !== null) {
          let at = inBatch.get(change.event) ?? null;
          if (at === null) {
            const server = await store.server();
            const rows = await server.query(
              'SELECT pos, stay FROM feed WHERE room = ? AND event = ?',
              [roomId, change.event],
            );
            if (rows.length > 0) {
              at = { pos: Number(rows[0].pos), stay: Number(rows[0].stay) };
            }
          }
          if (at !== null) {
            toId = await room.tx(async (tx) => {
              const group = await tx.state.publishedAt(at!.stay, at!.pos);
              if (group === null) return null;
              return await tx.state.groupKey(
                group,
                'm.room.member',
                data.user as string,
              );
            });
          }
        }
        out.push({ change, kind: 'membership', user: data.user, to, toId });
        break;
      }
      case 'redaction': {
        const data = JSON.parse(change.data) as { target?: unknown };
        if (typeof data.target !== 'string') {
          throw new Error(
            `malformed redaction change at pos ${change.pos}: ${change.data}`,
          );
        }
        out.push({ change, kind: 'redaction', target: data.target });
        break;
      }
      case 'delivery': {
        const data = JSON.parse(change.data) as { destinations?: unknown };
        if (!Array.isArray(data.destinations)) {
          throw new Error(
            `malformed delivery change at pos ${change.pos}: ${change.data}`,
          );
        }
        out.push({
          change,
          kind: 'delivery',
          destinations: data.destinations.map((d) => String(d)),
        });
        break;
      }
      default:
        throw new Error(
          `unknown change kind ${
            JSON.stringify(change.kind)
          } at pos ${change.pos}`,
        );
    }
  }
  return out;
}

// D7: the relations index takes content['m.relates_to'] with a direct
// event_id; rich replies carry theirs under m.in_reply_to instead and are
// NOT relations rows (the old condition, ported verbatim).
function relationOf(
  pdu: Record<string, unknown>,
): { relatesTo: string; relType: string | null } | null {
  const content = pdu.content;
  if (
    content === null || typeof content !== 'object' || Array.isArray(content)
  ) {
    return null;
  }
  const relatesTo = (content as Record<string, unknown>)['m.relates_to'];
  if (
    relatesTo === null || typeof relatesTo !== 'object' ||
    Array.isArray(relatesTo)
  ) {
    return null;
  }
  const target = (relatesTo as Record<string, unknown>).event_id;
  if (typeof target !== 'string') return null;
  const relType = (relatesTo as Record<string, unknown>).rel_type;
  return {
    relatesTo: target,
    relType: typeof relType === 'string' ? relType : null,
  };
}

// D1: the indexed search text — body/name/topic only, lower-cased with
// NUL → space (the old ingest's searchTextOf, ported verbatim).
function searchTextOf(
  payload: EventPayload,
  pdu: Record<string, unknown>,
): { key: string; text: string } | null {
  const content = pdu.content;
  if (
    content === null || typeof content !== 'object' || Array.isArray(content)
  ) {
    return null;
  }
  const record = content as Record<string, unknown>;
  let key: string | null = null;
  let raw: string | null = null;
  if (payload.type === 'm.room.message' && typeof record.body === 'string') {
    key = 'content.body';
    raw = record.body;
  } else if (
    payload.type === 'm.room.name' && typeof record.name === 'string'
  ) {
    key = 'content.name';
    raw = record.name;
  } else if (payload.type === 'm.room.topic') {
    raw = topicTextOf(record);
    if (raw !== null) key = 'content.topic';
  }
  if (key === null || raw === null) return null;
  return { key, text: raw.replaceAll(' ', ' ').toLowerCase() };
}

function topicTextOf(content: Record<string, unknown>): string | null {
  const mTopic = content['m.topic'];
  if (mTopic !== null && typeof mTopic === 'object' && !Array.isArray(mTopic)) {
    const mText = (mTopic as Record<string, unknown>)['m.text'];
    if (Array.isArray(mText)) {
      for (const entry of mText) {
        if (
          entry === null || typeof entry !== 'object' || Array.isArray(entry)
        ) continue;
        const rec = entry as Record<string, unknown>;
        if (typeof rec.body !== 'string') continue;
        if (rec.mimetype === undefined || rec.mimetype === 'text/plain') {
          return rec.body;
        }
      }
    }
  }
  return typeof content.topic === 'string' ? content.topic : null;
}

// --- the application -------------------------------------------------------

async function apply(
  tx: Conn,
  roomId: string,
  item: Prepared,
  addedMs: number,
): Promise<void> {
  const { change } = item;
  switch (item.kind) {
    case 'event': {
      await tx.execute(
        `INSERT INTO event_index(event, room, pos, standing, grounding, reason, rule, origin, seq)
         VALUES(?,?,?,?,?,?,?,?,NULL) ON CONFLICT(event) DO NOTHING`,
        [
          change.event,
          roomId,
          change.pos,
          item.payload.standing,
          item.payload.grounding,
          item.payload.reason,
          item.payload.rule,
          item.payload.origin,
        ],
      );
      if (isLive(item.payload)) await applyLive(tx, roomId, item);
      await applyPublication(tx, roomId, change.pos, item.publication);
      return;
    }
    case 'transition': {
      // the pending event's row exists; the transition lands its verdict.
      // First position wins (the row keeps its original change pos).
      await tx.execute(
        `INSERT INTO event_index(event, room, pos, standing, grounding, reason, rule, origin, seq)
         VALUES(?,?,?,?,?,?,?,?,NULL)
         ON CONFLICT(event) DO UPDATE SET
           standing = excluded.standing, grounding = excluded.grounding,
           reason = excluded.reason, rule = excluded.rule`,
        [
          change.event,
          roomId,
          change.pos,
          item.payload.standing,
          item.payload.grounding,
          item.payload.reason,
          item.payload.rule,
          item.payload.origin,
        ],
      );
      if (isLive(item.payload)) await applyLive(tx, roomId, item);
      await applyPublication(tx, roomId, change.pos, item.publication);
      return;
    }
    case 'history': {
      // History is never news: indexed without a seq, never a feed row.
      // The upsert promotes a held evidence row to grounded (first-owner).
      await tx.execute(
        `INSERT INTO event_index(event, room, pos, standing, grounding, reason, rule, origin, seq)
         VALUES(?,?,?,?,?,?,?,?,NULL)
         ON CONFLICT(event) DO UPDATE SET
           standing = excluded.standing, grounding = excluded.grounding,
           reason = excluded.reason, rule = excluded.rule,
           origin = excluded.origin`,
        [
          change.event,
          roomId,
          change.pos,
          item.payload.standing,
          item.payload.grounding,
          item.payload.reason,
          item.payload.rule,
          item.payload.origin,
        ],
      );
      return;
    }
    case 'membership': {
      if (item.to === null) {
        // no member event in the published state — the same 'leave' the
        // reads default to without a row (MSC4115)
        await tx.execute(
          'DELETE FROM memberships WHERE user = ? AND room = ?',
          [item.user, roomId],
        );
        return;
      }
      // The old fold's own-event seq, else the triggering seq: the member
      // event's own feed position when it has one (a live event), else the
      // trigger's. (change.event is guaranteed — prepare rejects a
      // membership change without it.)
      const eventId = item.toId ?? change.event!;
      const seq = (await seqOf(tx, roomId, eventId)) ??
        (await feedSeqOf(tx, roomId, change.event!));
      await tx.execute(
        `INSERT INTO memberships(user, room, membership, event, seq)
         VALUES(?,?,?,?,?)
         ON CONFLICT(user, room) DO UPDATE SET
           membership = excluded.membership,
           event = excluded.event, seq = excluded.seq`,
        [item.user, roomId, item.to, eventId, seq],
      );
      return;
    }
    case 'redaction': {
      // the applied effect (the old redacted_by, last writer wins)
      await tx.execute(
        `INSERT INTO redactions(target, room, event, pos)
         VALUES(?,?,?,?)
         ON CONFLICT(target) DO UPDATE SET
           event = excluded.event, pos = excluded.pos`,
        [item.target, roomId, change.event, change.pos],
      );
      return;
    }
    case 'delivery': {
      for (const destination of item.destinations) {
        await tx.execute(
          `INSERT INTO outbox(room, pos, destination, event, state, attempts, next_attempt_ms, added_ms)
           VALUES(?,?,?,?,'pending',0,0,?) ON CONFLICT DO NOTHING`,
          [roomId, change.pos, destination, change.event, addedMs],
        );
      }
      return;
    }
  }
}

// The membership writes of a publication diff, in the same projection tx
// as the feed row the publication hangs off (applied after it). Removed
// keys delete the row; the others upsert with the member event's own seq
// — or the triggering change's feed position when the member event has
// no seq of its own (history/evidence) — exactly the old fold's
// ownSeq ?? triggeringSeq. Deterministic on replay: the diff, the seq
// lookups and the upsert all recompute from unchanged inputs.
async function applyPublication(
  tx: Conn,
  roomId: string,
  pos: number,
  diff: { user: string; to: string | null; toId: string | null }[],
): Promise<void> {
  for (const d of diff) {
    if (d.to === null) {
      await tx.execute(
        'DELETE FROM memberships WHERE user = ? AND room = ?',
        [d.user, roomId],
      );
      continue;
    }
    const seq = (await seqOf(tx, roomId, d.toId!)) ??
      (await feedSeqAtPos(tx, roomId, pos));
    if (seq === null) {
      // a publication hangs off an accepted (positioned, feed-rowed)
      // change — never null
      throw new Error(`publication at pos ${pos} without a feed row`);
    }
    await tx.execute(
      `INSERT INTO memberships(user, room, membership, event, seq)
       VALUES(?,?,?,?,?)
       ON CONFLICT(user, room) DO UPDATE SET
         membership = excluded.membership,
         event = excluded.event, seq = excluded.seq`,
      [d.user, roomId, d.to, d.toId, seq],
    );
  }
}

async function feedSeqAtPos(
  tx: Conn,
  roomId: string,
  pos: number,
): Promise<number | null> {
  const rows = await tx.query(
    'SELECT seq FROM feed WHERE room = ? AND pos = ?',
    [roomId, pos],
  );
  if (rows.length === 0) return null;
  return Number(rows[0].seq);
}

// The feed write shared by 'event' and 'transition': the row is idempotent
// on (room, pos); the seq auto-assigns in projection order and mirrors back
// into event_index (deterministic on replay). Relations and search take
// the event's own seq, exactly the old "seq IS NOT NULL" rule.
async function applyLive(
  tx: Conn,
  roomId: string,
  item: Prepared & { kind: 'event' | 'transition' | 'history' },
): Promise<void> {
  const existing = await feedSeqAtPos(tx, roomId, item.change.pos);
  if (existing === null) {
    const seq = await nextEventSeq(tx);
    await tx.execute(
      'INSERT INTO feed(seq, room, pos, event, stay) VALUES(?,?,?,?,?)',
      [seq, roomId, item.change.pos, item.change.event, item.payload.stay],
    );
  }
  await tx.execute(
    `UPDATE event_index SET seq = (
       SELECT seq FROM feed WHERE room = ? AND pos = ?
     ) WHERE event = ?`,
    [roomId, item.change.pos, item.change.event],
  );
  if (item.relation !== null) {
    await tx.execute(
      `INSERT INTO relations(event, relates_to, rel_type, room, seq)
       VALUES(?,?,?,?,(SELECT seq FROM feed WHERE room = ? AND event = ?))
       ON CONFLICT(event) DO NOTHING`,
      [
        item.change.event,
        item.relation.relatesTo,
        item.relation.relType,
        roomId,
        roomId,
        item.change.event,
      ],
    );
  }
  if (item.search !== null) {
    await tx.execute(
      `INSERT INTO search(event, room, seq, key, sender, origin_ts, body_lower)
       VALUES(?,?,(SELECT seq FROM feed WHERE room = ? AND event = ?),?,?,?,?)
       ON CONFLICT(event) DO NOTHING`,
      [
        item.change.event,
        roomId,
        roomId,
        item.change.event,
        item.search.key,
        item.payload.sender,
        item.payload.origin_server_ts,
        item.search.text,
      ],
    );
  }
}

async function seqOf(
  tx: Conn,
  roomId: string,
  event: string,
): Promise<number | null> {
  const rows = await tx.query(
    'SELECT seq FROM event_index WHERE room = ? AND event = ?',
    [roomId, event],
  );
  if (rows.length === 0 || rows[0].seq === null) return null;
  return Number(rows[0].seq);
}

async function feedSeqOf(
  tx: Conn,
  roomId: string,
  event: string,
): Promise<number | null> {
  const rows = await tx.query(
    'SELECT seq FROM feed WHERE room = ? AND event = ?',
    [roomId, event],
  );
  if (rows.length === 0) return null;
  return Number(rows[0].seq);
}
