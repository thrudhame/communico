// api/engine/stateops.ts — client-level state read/write (M4 commit 5):
// the shared logic of the /state routes (both depths) and the state-row
// → client-event expansion, so the route files stay one-line shims.
import { canonicalJson } from './canonical.ts';
import { authorAndIngest } from './ingest.ts';
import { MatrixError } from './matrix-error.ts';
import {
  eventIndexRow,
  lookupRoom,
  membershipOf,
  stateAtSeq,
  type StateRow,
} from './room.ts';
import { clientEventForRow, pduById } from './timeline.ts';
import { readPositionFor } from './visibility.ts';

// Full client events for a set of state rows (a row whose event is
// missing from the index is skipped — never expected). Redaction is
// applied at read (clientEventForRow).
export async function clientEventsForRows(
  dbName: string,
  roomId: string,
  rows: StateRow[],
  roomVersion: string,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const idx = await eventIndexRow(roomId, r.eventId);
    if (!idx) continue;
    const ev = await clientEventForRow(dbName, roomVersion, idx);
    if (!ev) continue;
    out.push(ev);
  }
  return out;
}

// GET /state/:type/:key — content-only by default, the full client event
// with ?format=event. 404 M_NOT_FOUND when the key is absent. Left users
// read as of their leave (readPositionFor).
export async function readStateKey(
  roomId: string,
  userId: string,
  type: string,
  stateKey: string,
  format: string | null,
): Promise<unknown> {
  const room = await lookupRoom(roomId);
  if (!room) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }
  const at = await readPositionFor(userId, roomId);
  const rows = (await stateAtSeq(roomId, at)) ?? [];
  const row = rows.find((r) => r.type === type && r.stateKey === stateKey);
  if (!row) {
    throw new MatrixError(
      404,
      'M_NOT_FOUND',
      'state key not found: ' + type + '/' + stateKey,
    );
  }
  if (format === 'event') {
    const [ev] = await clientEventsForRows(
      room.dbName,
      roomId,
      [row],
      room.roomVersion,
    );
    return ev;
  }
  return row.content;
}

// PUT /state/:type/:key — idempotent when the content is identical and
// the sender matches the current state event's (return its event_id);
// else author + ingest. Rulebook rejects are 403 M_FORBIDDEN.
export async function writeStateKey(
  roomId: string,
  userId: string,
  type: string,
  stateKey: string,
  content: Record<string, unknown>,
): Promise<{ event_id: string }> {
  const room = await lookupRoom(roomId);
  if (!room) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }
  const m = await membershipOf(roomId, userId);
  if (m?.membership !== 'join') {
    throw new MatrixError(403, 'M_FORBIDDEN', 'not joined to ' + roomId);
  }
  const rows = (await stateAtSeq(roomId, null)) ?? [];
  const cur = rows.find((r) => r.type === type && r.stateKey === stateKey);
  if (cur) {
    const idx = await eventIndexRow(roomId, cur.eventId);
    const pdu = idx
      ? await pduById(room.dbName, idx.commit_hash, cur.eventId)
      : null;
    if (
      pdu && pdu.sender === userId &&
      canonicalJson(pdu.content ?? {}) === canonicalJson(content)
    ) {
      return { event_id: cur.eventId };
    }
  }
  try {
    const res = await authorAndIngest(roomId, {
      type,
      state_key: stateKey,
      sender: userId,
      content,
      origin_server_ts: Date.now(),
    });
    return { event_id: res.event_id };
  } catch (e) {
    const msg = String(e);
    if (msg.includes('M_STATE_REJECT') || msg.includes('M_AUTHCHAIN_REJECT')) {
      throw new MatrixError(403, 'M_FORBIDDEN', msg);
    }
    throw e;
  }
}
