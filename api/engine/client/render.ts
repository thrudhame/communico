// One room-event projection for all C-S readers, including /sync.
// PDUs stay immutable; previous content comes from the event's BEFORE ref.
import { redact } from '#engine/eventid.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Room } from '#engine/room/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { transactionForEvent } from '#engine/tenant/txns.ts';
import { localpartOf } from '#engine/ids.ts';
import { redactionOf } from '#engine/server/read.ts';
import { relationBundles } from './relation-view.ts';
import { isIgnoredEvent } from './ignored.ts';
import { roomVersionOf } from '#engine/room/build.ts';
import { canSeeEvent } from './visibility.ts';
import { erasedView } from '#engine/erasure.ts';
import { admitState, type StateAdmission } from './state-admission.ts';
import {
  prejoinDisplay,
  savedPrejoinDisplay,
} from '#engine/federation/prejoin.ts';

export type Viewer = {
  userId: string;
  deviceId: string | null;
  membership?: string;
  tenant: Tenant;
};

function clientShape(
  pdu: Pdu,
  eventId: string,
): Record<string, unknown> & { type: string; sender: string } {
  const event: Record<string, unknown> & { type: string; sender: string } = {
    event_id: eventId,
    type: pdu.type,
    sender: pdu.sender,
    content: pdu.content ?? {},
    origin_server_ts: pdu.origin_server_ts,
  };
  if (pdu.state_key != null) event.state_key = pdu.state_key;
  if (pdu.redacts != null) event.redacts = pdu.redacts;
  return event;
}

function eventShape(
  pdu: Pdu,
  eventId: string,
  format: 'client' | 'federation' | undefined,
) {
  return format === 'federation'
    ? { ...pdu, event_id: eventId }
    : clientShape(pdu, eventId);
}

/** Only the authoritative prejoin owner supplies these full membership PDUs.
 * Saved stripped hints must never enter a full client state-event batch. */
export function renderPrejoinDeparture(
  pdu: Pdu,
  userId: string,
  format: 'client' | 'federation' | undefined,
) {
  if (
    pdu.type !== 'm.room.member' || pdu.state_key !== userId ||
    !['leave', 'ban'].includes(String(pdu.content?.membership)) ||
    typeof pdu.event_id !== 'string' || typeof pdu.origin_server_ts !== 'number'
  ) {
    throw new Error('invalid out-of-band departure');
  }
  return eventShape(pdu, pdu.event_id, format);
}

/** Only the authoritative pending OOB invite owner may call this boundary.
 * It exposes the viewer's own invite, never arbitrary stripped-state PDUs. */
export async function renderInviteNotification(
  pdu: Pdu,
  eventId: string,
  viewer: Viewer,
  saved: Record<string, unknown>[],
  room: Room | null,
): Promise<Record<string, unknown> | null> {
  if (
    pdu.type !== 'm.room.member' || pdu.state_key !== viewer.userId ||
    pdu.content?.membership !== 'invite'
  ) return null;
  return {
    ...clientShape(pdu, eventId),
    unsigned: {
      invite_room_state: await savedPrejoinDisplay(
        room,
        saved,
        viewer.userId,
        viewer,
      ),
    },
  };
}

export async function renderEvent(
  room: Room,
  eventId: string,
  viewer: Viewer,
  opts?: {
    omitRoomId?: boolean;
    bundleThreads?: boolean;
    eventFormat?: 'client' | 'federation';
  },
): Promise<Record<string, unknown> | null> {
  if (!await canSeeEvent(viewer.userId, room, eventId)) return null;
  if (await isIgnoredEvent(room, eventId, viewer)) return null;
  return await serializeEvent(room, eventId, viewer, opts);
}

// Published state snapshots have their own admission/cut contract, including
// imported evidence. They share formatting, not timeline visibility.
export async function renderStateEvent(
  room: Room,
  eventId: string,
  viewer?: Viewer,
  opts?: {
    omitRoomId?: boolean;
    bundleThreads?: boolean;
    eventFormat?: 'client' | 'federation';
    admission?: StateAdmission;
  },
): Promise<Record<string, unknown> | null> {
  const admission = opts?.admission ??
    await admitState(room, { userId: viewer?.userId ?? null });
  if (
    admission.roomId !== room.id ||
    admission.userId !== (viewer?.userId ?? null) ||
    !admission.events.has(eventId)
  ) return null;
  return await serializeEvent(room, eventId, viewer, opts);
}

// The timeline entry point checks event visibility; state entry points check an
// exact snapshot grant. Neither exports an unchecked serializer to consumers.
async function serializeEvent(
  room: Room,
  eventId: string,
  viewer?: Viewer,
  opts?: {
    omitRoomId?: boolean;
    bundleThreads?: boolean;
    eventFormat?: 'client' | 'federation';
  },
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
    let prevId: string | null = null;
    if (row.state_key !== null) {
      const before = await tx.state.eventStateBefore(eventId);
      const id = before === null
        ? null
        : await tx.state.groupKey(before.group, row.type, row.state_key);
      const old = id === null ? null : await tx.events.get(id);
      if (old !== null) {
        prev = JSON.parse(old.pdu) as Pdu;
        prevId = old.id;
      }
    }
    const pdu = JSON.parse(row.pdu) as Pdu;
    const membership = pdu.type === 'm.room.member'
      ? pdu.content?.membership
      : null;
    const prejoinGroup = membership === 'invite' || membership === 'knock'
      ? await tx.state.eventStateAfter(eventId)
      : null;
    const prejoinIds = prejoinGroup === null
      ? null
      : [...(await tx.state.groupMap(prejoinGroup.group)).values()];
    return { pdu, prev, prevId, version, membership, prejoinIds };
  });
  if (loaded === null) return null;
  const { pdu, prev, prevId, version } = loaded;
  const server = await room.store.server();
  const redactionId = await redactionOf(server, room.id, eventId);
  const redactionRow = redactionId === null
    ? null
    : await room.tx((tx) => tx.events.get(redactionId));
  const unredacted = await erasedView(
    room,
    eventId,
    pdu,
    version,
    viewer === undefined ? undefined : { userId: viewer.userId },
    viewer?.tenant,
  );
  const shown = redactionRow === null ? unredacted : redact(
    pdu as unknown as Record<string, unknown>,
    version,
  ) as unknown as Pdu;
  const event: Record<string, unknown> = eventShape(
    shown,
    eventId,
    opts?.eventFormat,
  );
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
    const device = await viewer.tenant.tx((tx) =>
      tx.devices.byId(viewer.deviceId!, localpartOf(viewer.userId))
    );
    const txn = device === null ? null : await transactionForEvent(
      viewer.tenant,
      {
        localpart: localpartOf(viewer.userId),
        deviceId: viewer.deviceId,
        generation: device.generation,
      },
      room.id,
      eventId,
    );
    if (txn !== null) unsigned.transaction_id = txn;
  }
  if (viewer?.membership !== undefined) unsigned.membership = viewer.membership;
  if (viewer !== undefined && loaded.prejoinIds !== null) {
    unsigned[
      loaded.membership === 'knock' ? 'knock_room_state' : 'invite_room_state'
    ] = await prejoinDisplay(
      room,
      loaded.prejoinIds,
      String(pdu.state_key),
      viewer,
    );
  }
  if (prev !== null) {
    const shownPrev = await erasedView(
      room,
      prevId!,
      prev,
      version,
      viewer === undefined ? undefined : { userId: viewer.userId },
      viewer?.tenant,
    );
    const previousRedaction = await redactionOf(server, room.id, prevId!);
    unsigned.prev_content = previousRedaction === null
      ? (shownPrev.content ?? {})
      : redact(prev as unknown as Record<string, unknown>, version).content;
    unsigned.prev_sender = prev.sender;
  }
  if (redactionRow !== null) {
    // The reason event is unbundled, so redaction cycles cannot recurse.
    const reason = await erasedView(
      room,
      redactionRow.id,
      JSON.parse(redactionRow.pdu) as Pdu,
      version,
      viewer === undefined ? undefined : { userId: viewer.userId },
      viewer?.tenant,
    );
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
  if (viewer !== undefined) {
    const selection = await relationBundles(room, eventId, pdu, viewer, {
      threads: opts?.bundleThreads !== false,
      redacted: redactionRow !== null,
    });
    const relations: Record<string, unknown> = {};
    if (selection.references.length > 0) {
      relations['m.reference'] = {
        chunk: selection.references.map((event_id) => ({ event_id })),
      };
    }
    if (selection.replacement !== null) {
      const replacement = await renderEvent(
        room,
        selection.replacement,
        viewer,
        { ...opts, bundleThreads: false },
      );
      if (replacement !== null) relations['m.replace'] = replacement;
    }
    if (selection.thread !== null) {
      const latest = await renderEvent(
        room,
        selection.thread.latest,
        viewer,
        { ...opts, bundleThreads: false },
      );
      if (latest !== null) {
        relations['m.thread'] = {
          latest_event: latest,
          count: selection.thread.count,
          current_user_participated: selection.thread.participated,
        };
      }
    }
    if (Object.keys(relations).length > 0) unsigned['m.relations'] = relations;
  }
  return event;
}
