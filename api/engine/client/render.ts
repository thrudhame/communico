// One room-event projection for all C-S readers, including /sync.
// PDUs stay immutable; previous content comes from the event's BEFORE ref.
import { redact } from '#engine/eventid.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Room } from '#engine/room/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { transactionForEvent } from '#engine/tenant/txns.ts';
import { redactionOf, relationsOf } from '#engine/server/read.ts';
import { roomVersionOf } from '#engine/room/build.ts';
import { canSeeEvent } from './visibility.ts';

export type Viewer = {
  userId: string;
  deviceId: string | null;
  membership?: string;
  tenant?: Tenant;
};

export async function renderEvent(
  room: Room,
  eventId: string,
  viewer: Viewer,
  opts?: { omitRoomId?: boolean; bundleThreads?: boolean },
): Promise<Record<string, unknown> | null> {
  if (!await canSeeEvent(viewer.userId, room, eventId)) return null;
  return await renderStateEvent(room, eventId, viewer, opts);
}

// Published state snapshots have their own admission/cut contract, including
// imported evidence. They share formatting, not timeline visibility.
export async function renderStateEvent(
  room: Room,
  eventId: string,
  viewer?: Viewer,
  opts?: { omitRoomId?: boolean; bundleThreads?: boolean },
): Promise<Record<string, unknown> | null> {
  const loaded = await room.tx(async (tx) => {
    const row = await tx.events.get(eventId);
    if (row === null) return null;
    const status = await tx.events.getStatus(eventId);
    if (status?.standing !== 'accepted') return null;
    const stay = await tx.segments.latestStay();
    if (stay === null) return null;
    const version = await roomVersionOf(tx, stay.id);
    let prev: Pdu | null = null;
    if (row.state_key !== null) {
      const before = await tx.state.eventStateBefore(eventId);
      const id = before === null
        ? null
        : await tx.state.groupKey(before.group, row.type, row.state_key);
      const old = id === null ? null : await tx.events.get(id);
      if (old !== null) prev = JSON.parse(old.pdu) as Pdu;
    }
    return { pdu: JSON.parse(row.pdu) as Pdu, prev, version };
  });
  if (loaded === null) return null;
  const { pdu, prev, version } = loaded;
  const server = await room.store.server();
  const redactionId = await redactionOf(server, room.id, eventId);
  const redactionRow = redactionId === null
    ? null
    : await room.tx((tx) => tx.events.get(redactionId));
  const shown = redactionRow === null ? pdu : redact(
    pdu as unknown as Record<string, unknown>,
    version,
  ) as unknown as Pdu;
  const event: Record<string, unknown> = {
    event_id: eventId,
    type: shown.type,
    sender: shown.sender,
    content: shown.content ?? {},
    origin_server_ts: shown.origin_server_ts,
  };
  if (opts?.omitRoomId !== true) event.room_id = room.id;
  if (shown.state_key != null) event.state_key = shown.state_key;
  if (shown.redacts != null) event.redacts = shown.redacts;
  const unsigned: Record<string, unknown> = {
    age: Math.max(0, Date.now() - Number(pdu.origin_server_ts)),
  };
  if (
    viewer?.tenant !== undefined && viewer.deviceId !== null &&
    viewer.userId === pdu.sender
  ) {
    const txn = await transactionForEvent(
      viewer.tenant,
      viewer.deviceId,
      room.id,
      eventId,
    );
    if (txn !== null) unsigned.transaction_id = txn;
  }
  if (viewer?.membership !== undefined) unsigned.membership = viewer.membership;
  if (prev !== null) {
    unsigned.prev_content = prev.content ?? {};
    unsigned.prev_sender = prev.sender;
  }
  if (redactionRow !== null) {
    // The reason event is unbundled, so redaction cycles cannot recurse.
    const reason = JSON.parse(redactionRow.pdu) as Pdu;
    const redactedBecause: Record<string, unknown> = {
      event_id: redactionRow.id,
      room_id: room.id,
      type: reason.type,
      sender: reason.sender,
      content: reason.content ?? {},
      origin_server_ts: reason.origin_server_ts,
      unsigned: {
        age: Math.max(0, Date.now() - Number(reason.origin_server_ts)),
      },
    };
    if (reason.redacts != null) redactedBecause.redacts = reason.redacts;
    unsigned.redacted_because = redactedBecause;
  }
  event.unsigned = unsigned;
  if (opts?.bundleThreads !== false && viewer !== undefined) {
    const children = [];
    for (
      const child of await relationsOf(server, room.id, eventId, 'm.thread')
    ) {
      if (await canSeeEvent(viewer.userId, room, child.eventId)) {
        children.push(child);
      }
    }
    if (children.length > 0) {
      const latest = await renderEvent(
        room,
        children[children.length - 1].eventId,
        viewer,
        { bundleThreads: false },
      );
      let participated = viewer?.userId === pdu.sender;
      for (const child of children) {
        const row = await room.tx((tx) => tx.events.get(child.eventId));
        if (row?.sender === viewer?.userId) participated = true;
      }
      if (latest !== null) {
        unsigned['m.relations'] = {
          'm.thread': {
            latest_event: latest,
            count: children.length,
            current_user_participated: participated,
          },
        };
      }
    }
  }
  return event;
}
