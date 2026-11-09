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
// the feed, live relation listings and search. Accepted historical relation
// edges remain available to the shared classifier without publishing news.
import type { Change } from '#engine/room/changes.ts';
import { openRoom, type Room } from '#engine/room/index.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Conn } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import { advance, get } from '#engine/store/watermark.ts';
import { eventStreamTx, nextEventSeq } from '#engine/server/stream.ts';
import { finishRoomRemoval, type Removal } from '#engine/server/removal.ts';
import { reconcileDeviceRoom } from '#engine/server/e2ee.ts';
import {
  preparePush,
  type PushPublication,
} from '#engine/server/push-project.ts';
import {
  applyPushPublication,
  reconcileNotificationEvent,
} from '#engine/server/notifications.ts';

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

export async function project(store: Store, roomId: string): Promise<void> {
  // Recovery remains synchronous for the caller (including startup), but each
  // durable upgrade page rejoins the queue so another room can publish between
  // pages. A same-room caller helps recovery before publishing any new changes.
  for (;;) {
    const complete = await withProjectionLock(async () => {
      if (!await projectNow(store, roomId)) return false;
      for (const fn of projectedListeners) {
        try {
          await fn(store, roomId);
        } catch (error) {
          console.error(`projection listener failed for ${roomId}:`, error);
        }
      }
      return true;
    });
    if (complete) return;
  }
}

/** Room lifecycle operations use the same serialization as projection. */
export function withProjectionLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function projectNow(store: Store, roomId: string): Promise<boolean> {
  const server = await store.server();
  const room = await openRoom(store, roomId);
  const source = sourceOf(roomId);
  const localServers = await store.tenants();
  // Never advance the normal room/context watermark past an incomplete seed:
  // live decisions must see the complete already-published relation context.
  if (!await seedHistoricalRelations(store, room)) return false;
  for (;;) {
    const mark = await get(server, source);
    // A supported schema upgrade seeds at the already projected publication,
    // not at a newer room head and not by replaying history as news.
    if (
      mark > 0 &&
      !(await server.query('SELECT 1 FROM e2ee_rooms WHERE room=?', [roomId]))
        .length
    ) {
      const cut = await server.query(
        'SELECT stay,pos FROM feed WHERE room=? AND pos<=? ORDER BY pos DESC LIMIT 1',
        [roomId, mark],
      );
      if (cut.length) {
        const ids = await memberIdsAt(
          room,
          Number(cut[0].stay),
          Number(cut[0].pos),
          true,
        );
        if (ids !== null) {
          const members = await membersAt(room, ids.members, new Map());
          await server.tx((tx) =>
            applyDevicePublication(
              tx,
              roomId,
              { ...ids, members },
              Number(cut[0].pos),
              localServers,
            )
          );
        }
      }
    }
    let batch = await room.tx((tx) => tx.changes.after(mark, BATCH));
    if (batch.length === 0) return true;
    const drop = batch.findIndex((change) => change.kind === 'drop');
    if (drop === 0) {
      await finishRoomRemoval(
        store,
        roomId,
        JSON.parse(batch[0].data) as Removal,
        batch[0].pos,
      );
      return true;
    }
    if (drop > 0) batch = batch.slice(0, drop);
    const prepared = await prepare(room, store, roomId, batch, localServers);
    const addedMs = Date.now();
    await eventStreamTx(server, async (tx) => {
      for (const item of prepared) {
        await apply(tx, roomId, item, addedMs, localServers);
      }
      await advance(tx, source, batch[batch.length - 1].pos);
      await advance(tx, 'push-context:' + roomId, batch[batch.length - 1].pos);
    });
  }
}

// --- the change payloads ---------------------------------------------------

// Older schemas lacked history edges and implicit-read event identity. Recover
// those facts from immutable PDUs, then reconcile saved decisions. This never
// re-evaluates rules or replays live publication/delivery intent.
async function seedHistoricalRelations(
  store: Store,
  room: Room,
): Promise<boolean> {
  const server = await store.server();
  const source = 'push-context:' + room.id;
  const mark = await get(server, sourceOf(room.id));
  if (mark === 0 || await get(server, source) >= mark) return true;
  let cursor = await get(server, source);
  const page = await server.query(
    `SELECT event,pos,seq FROM event_index WHERE room=? AND pos>? AND pos<=?
      AND standing='accepted' AND grounding='grounded' ORDER BY pos LIMIT ?`,
    [room.id, cursor, mark, BATCH],
  );
  const edges = await room.tx(async (tx) => {
    const out = [];
    for (const row of page) {
      const event = String(row.event);
      const pdu = await tx.events.get(event);
      if (pdu === null) throw new Error('projected event missing: ' + event);
      const data = JSON.parse(pdu.pdu) as Record<string, unknown>;
      out.push({
        event,
        relation: relationOf(data),
        sender: String(data.sender),
        seq: row.seq === null ? null : Number(row.seq),
      });
    }
    return out;
  });
  cursor = page.length < BATCH ? mark : Number(page.at(-1)!.pos);
  const now = Date.now();
  await server.tx(async (tx) => {
    for (const { event, relation, sender, seq } of edges) {
      if (relation !== null) {
        await tx.execute(
          'INSERT INTO relations(event,relates_to,rel_type,room,seq) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',
          [event, relation.relatesTo, relation.relType, room.id, seq],
        );
      }
      if (seq !== null) {
        await tx.execute(
          'INSERT INTO notification_own_events(room,event,user,event_seq) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
          [room.id, event, sender, seq],
        );
      }
      await reconcileNotificationEvent(tx, room.id, event, now);
    }
    await advance(tx, source, cursor);
  });
  return cursor === mark;
}

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
      // A live cut's complete published membership. Reconciliation uses
      // the server rows inside apply's transaction, including earlier
      // changes in the same batch. Evidence/history carry no publication.
      publication: Publication | null;
      push: PushPublication | null;
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

type PublishedMember = { user: string; to: string; toId: string };
type Publication = {
  members: PublishedMember[];
  encryption: string | null;
  encrypted: boolean;
};

// A plain message with unchanged publication does no membership work.
// Offset zero is the stay's first live position, whose opening boundary
// still needs projection even if the room read fallback has the same group.
async function memberIdsAt(
  room: Room,
  stay: number | null,
  pos: number,
  first: boolean,
): Promise<
  {
    members: Map<string, string>;
    encryption: string | null;
    encrypted: boolean;
  } | null
> {
  if (stay === null) return null;
  return await room.tx(async (tx) => {
    const group = await tx.state.publishedAt(stay, pos);
    if (group === null) return null;
    if (!first && group === await tx.state.publishedAt(stay, pos - 1)) {
      return null;
    }
    const map = await tx.state.groupMap(group);
    const prefix = 'm.room.member\0';
    const encryption = map.get('m.room.encryption\0') ?? null;
    const key = encryption === null ? null : await tx.events.get(encryption);
    const algorithm = key === null
      ? null
      : (JSON.parse(key.pdu) as Pdu).content?.algorithm;
    return {
      encryption,
      encrypted: typeof algorithm === 'string' && algorithm.length > 0,
      members: new Map(
        [...map].filter(([key]) => key.startsWith(prefix)).map(
          ([key, event]) => [key.slice(prefix.length), event],
        ),
      ),
    };
  });
}

// The baseline is the actual projected rows plus prior publications in
// this batch. Immutable member events only need reading when their id moved.
async function membersAt(
  room: Room,
  ids: Map<string, string>,
  projected: Map<string, PublishedMember>,
): Promise<PublishedMember[]> {
  return await room.tx(async (tx) => {
    const out: PublishedMember[] = [];
    for (const [user, toId] of ids) {
      const prior = projected.get(user);
      if (prior?.toId === toId) {
        out.push(prior);
        continue;
      }
      const row = await tx.events.get(toId);
      if (row === null) {
        throw new Error(`published member event missing: ${toId}`);
      }
      const membership = (JSON.parse(row.pdu) as Pdu).content?.membership;
      const to = typeof membership === 'string' ? membership : 'leave';
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
  localServers: string[],
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
  // Loaded only when a cut needs reconciliation. Advancing this baseline
  // keeps selective event reads correct across multiple cuts in one batch.
  let projected: Map<string, PublishedMember> | null = null;
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
        if (
          payload.standing === 'accepted' && payload.grounding === 'grounded'
        ) {
          const pdu = await room.tx(async (tx) => {
            const row = await tx.events.get(change.event!);
            return row === null
              ? null
              : (JSON.parse(row.pdu) as Record<string, unknown>);
          });
          if (pdu !== null) {
            relation = relationOf(pdu);
            if (change.kind !== 'history' && isLive(payload)) {
              search = searchTextOf(payload, pdu);
            }
          }
        }
        const ids = change.kind !== 'history' && isLive(payload)
          ? await memberIdsAt(
            room,
            payload.stay,
            change.pos,
            payload.offset === 0,
          )
          : null;
        let publication: Publication | null = null;
        if (ids !== null) {
          if (projected === null) {
            const server = await store.server();
            const rows = await server.query(
              'SELECT user, membership, event FROM memberships WHERE room = ?',
              [roomId],
            );
            projected = new Map(rows.map((row) => [String(row.user), {
              user: String(row.user),
              to: String(row.membership),
              toId: String(row.event),
            }]));
          }
          publication = {
            ...ids,
            members: await membersAt(room, ids.members, projected),
          };
          projected = new Map(
            publication.members.map((member) => [member.user, member]),
          );
        }
        out.push({
          change,
          kind: change.kind,
          payload,
          relation,
          search,
          publication,
          push: localServers.length > 0 && change.kind !== 'history' &&
              isLive(payload)
            ? await preparePush(
              room,
              store,
              change.event,
              payload.stay!,
              change.pos,
              localServers,
            )
            : null,
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
  return { key, text: raw.replaceAll('\u0000', ' ').toLowerCase() };
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
  localServers: string[],
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
      if (isLive(item.payload)) await applyLive(tx, roomId, item, addedMs);
      else await reconcileNotificationEvent(tx, roomId, change.event!, addedMs);
      await applyPublication(
        tx,
        roomId,
        item.payload.stay,
        change.pos,
        item.publication,
        localServers,
      );
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
      if (isLive(item.payload)) await applyLive(tx, roomId, item, addedMs);
      else await reconcileNotificationEvent(tx, roomId, change.event!, addedMs);
      await applyPublication(
        tx,
        roomId,
        item.payload.stay,
        change.pos,
        item.publication,
        localServers,
      );
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
      await applyRelation(tx, roomId, item);
      await reconcileNotificationEvent(tx, roomId, change.event!, addedMs);
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
      await applyMember(tx, roomId, item.user, item.to, eventId, seq);
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
      await reconcileNotificationEvent(tx, roomId, item.target, addedMs);
      if (
        (await tx.query(
          'SELECT 1 FROM e2ee_rooms WHERE room=? AND encryption_event=? AND encrypted=1',
          [roomId, item.target],
        )).length
      ) {
        const members =
          (await tx.query('SELECT user FROM e2ee_room_members WHERE room=?', [
            roomId,
          ])).map((r) => String(r.user));
        await reconcileDeviceRoom(
          tx,
          roomId,
          members,
          false,
          item.target,
          change.pos,
          localServers,
        );
      }
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

// Reconcile against what the server has actually projected, in the same
// transaction as the live feed cut. This also sees earlier batch writes.
// Imported opening changes take the new stay's first live seq; ordinary
// publication changes retain the existing own-event/trigger seq contract.
async function applyPublication(
  tx: Conn,
  roomId: string,
  stay: number | null,
  pos: number,
  publication: Publication | null,
  localServers: string[],
): Promise<void> {
  if (publication === null || stay === null) return;
  const members = publication.members;
  const current = new Map((await tx.query(
    'SELECT user, membership, event FROM memberships WHERE room = ?',
    [roomId],
  )).map((row) => [String(row.user), row]));
  const target = new Set(members.map((m) => m.user));
  for (const user of current.keys()) {
    if (!target.has(user)) {
      await tx.execute(
        'DELETE FROM memberships WHERE user = ? AND room = ?',
        [user, roomId],
      );
    }
  }
  const cut = await feedSeqAtPos(tx, roomId, pos);
  if (cut === null) {
    throw new Error(`publication at pos ${pos} without a feed row`);
  }
  const first = (await tx.query(
    'SELECT 1 FROM feed WHERE room = ? AND stay = ? AND pos < ? LIMIT 1',
    [roomId, stay, pos],
  )).length === 0;
  for (const member of members) {
    const prior = current.get(member.user);
    if (prior?.event === member.toId && prior.membership === member.to) {
      continue;
    }
    const seq = first ? cut : (await seqOf(tx, roomId, member.toId)) ?? cut;
    await applyMember(tx, roomId, member.user, member.to, member.toId, seq);
  }
  await applyDevicePublication(tx, roomId, publication, pos, localServers);
}

async function applyDevicePublication(
  tx: Conn,
  roomId: string,
  publication: Publication,
  pos: number,
  localServers: string[],
): Promise<void> {
  const redacted = publication.encryption !== null &&
    (await tx.query('SELECT 1 FROM redactions WHERE target=?', [
        publication.encryption,
      ])).length > 0;
  await reconcileDeviceRoom(
    tx,
    roomId,
    publication.members.filter((m) => m.to === 'join').map((m) => m.user),
    publication.encrypted && !redacted,
    publication.encryption,
    pos,
    localServers,
  );
}

// Both the full-publication and explicit membership-change paths preserve
// an unchanged row's seq, including the redundant change after a join cut.
async function applyMember(
  tx: Conn,
  roomId: string,
  user: string,
  membership: string,
  eventId: string,
  seq: number | null,
): Promise<void> {
  await tx.execute(
    `INSERT INTO memberships(user, room, membership, event, seq)
     VALUES(?,?,?,?,?)
     ON CONFLICT(user, room) DO UPDATE SET
       membership = excluded.membership, event = excluded.event, seq = excluded.seq
     WHERE memberships.event != excluded.event OR memberships.membership != excluded.membership`,
    [user, roomId, membership, eventId, seq],
  );
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
  addedMs: number,
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
  await applyRelation(tx, roomId, item);
  await reconcileNotificationEvent(tx, roomId, item.change.event!, addedMs);
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
  if (existing === null && item.push !== null) {
    await applyPushPublication(
      tx,
      roomId,
      item.change.event!,
      (await feedSeqAtPos(tx, roomId, item.change.pos))!,
      item.change.pos,
      item.push,
      addedMs,
    );
  }
}

async function applyRelation(
  tx: Conn,
  roomId: string,
  item: Prepared & { kind: 'event' | 'transition' | 'history' },
): Promise<void> {
  if (item.relation !== null) {
    await tx.execute(
      `INSERT INTO relations(event, relates_to, rel_type, room, seq)
       VALUES(?,?,?,?,(SELECT seq FROM feed WHERE room = ? AND event = ?))
        ON CONFLICT(event) DO UPDATE SET seq=COALESCE(relations.seq,excluded.seq)`,
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
