// api/engine/redaction.ts — M4 redactions (plan §3f). Authorization per
// the spec's redactions section (content/client-server-api/_index.md
// "Redactions" + data/api/client-server/redaction.yaml at v1.16): one's
// OWN event needs the m.room.redaction event level (rule 7 at ingest
// enforces it too); OTHERS' events need >= the `redact` level as well.
// The m.room.redaction event is authored + ingested, then the target's
// event_index row is marked redacted_by. The stored PDU stays verbatim —
// readers apply the redaction at read time (event-format.ts).
import { authorAndIngest } from './ingest.ts';
import { MatrixError } from './matrix-error.ts';
import { serverDb, withDb } from './db.ts';
import { eventIndexRow, lookupRoom, stateAtSeq } from './room.ts';
import { pduById } from './timeline.ts';
import { getRulebook } from './policy.ts';
import {
  namedLevel,
  parsePowerLevels,
  requiredLevel,
  userPowerLevel,
} from './rulebook/power-levels.ts';
import type { Pdu } from './pdu.ts';

export async function redactEvent(
  roomId: string,
  sender: string,
  targetEventId: string,
  reason?: string,
  txn?: { deviceId: string; txnId: string },
): Promise<{ eventId: string }> {
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  const targetIdx = await eventIndexRow(roomId, targetEventId);
  const targetPdu = targetIdx
    ? await pduById(room.dbName, targetIdx.commit_hash, targetEventId)
    : null;
  if (!targetPdu) {
    throw new MatrixError(
      404,
      'M_NOT_FOUND',
      'event not found: ' + targetEventId,
    );
  }

  // Authorization at the CURRENT state (spec: the check is against the
  // power levels as they are now — "from PL at now", plan §3f).
  const state = (await stateAtSeq(roomId, null)) ?? [];
  const plRow = state.find((r) => r.type === 'm.room.power_levels');
  const createRow = state.find((r) => r.type === 'm.room.create');
  const plPdu = plRow
    ? await pduById(
      room.dbName,
      (await eventIndexRow(roomId, plRow.eventId))!.commit_hash,
      plRow.eventId,
    )
    : null;
  const createPdu = createRow
    ? await pduById(
      room.dbName,
      (await eventIndexRow(roomId, createRow.eventId))!.commit_hash,
      createRow.eventId,
    )
    : null;
  const rulebook = getRulebook(room.roomVersion);
  const parsed = plPdu
    ? parsePowerLevels(plPdu.content, { enforceIntPowerLevels: false })
    : null;
  const pl = parsed?.ok ? parsed.pl : null;
  const senderLevel = userPowerLevel(
    sender,
    plPdu as Pdu | null,
    createPdu as Pdu | null,
    rulebook.spec,
  );
  const eventLevel = requiredLevel('m.room.redaction', undefined, pl);
  const required = targetPdu.sender === sender
    ? eventLevel
    : Math.max(eventLevel, namedLevel('redact', pl));
  if (senderLevel < required) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      `redact requires level ${required}, sender has ${senderLevel}`,
    );
  }

  const content: Record<string, unknown> = { redacts: targetEventId };
  if (reason !== undefined) content.reason = reason;
  let res;
  try {
    res = await authorAndIngest(
      roomId,
      {
        type: 'm.room.redaction',
        sender,
        content,
        origin_server_ts: Date.now(),
      },
      txn ? { txn } : undefined,
    );
  } catch (e) {
    const msg = String(e);
    if (msg.includes('M_STATE_REJECT') || msg.includes('M_AUTHCHAIN_REJECT')) {
      throw new MatrixError(403, 'M_FORBIDDEN', msg);
    }
    throw e;
  }
  await withDb(serverDb(), async (c) => {
    await c.query(
      'UPDATE event_index SET redacted_by = $1 WHERE event_id = $2;',
      [res.event_id, targetEventId],
    );
  });
  return { eventId: res.event_id };
}
