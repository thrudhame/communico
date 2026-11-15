// One room-event projection for all C-S readers, including /sync.
// PDUs stay immutable; previous content comes from the event's BEFORE ref.
import { redact } from '#engine/eventid.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Room } from '#engine/room/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { transactionsForDeviceEvents } from '#engine/tenant/txns.ts';
import { localpartOf } from '#engine/ids.ts';
import { redactionsOf } from '#engine/server/read.ts';
import { relationBundlesFor } from './relation-view.ts';
import { ignoredSenders } from './ignored.ts';
import { roomVersionOf } from '#engine/room/build.ts';
import { canSeeEventAt } from './visibility.ts';
import { erasedViews } from '#engine/erasure.ts';
import { admitState, type StateAdmission } from './state-admission.ts';
import {
  prejoinDisplays,
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

export type RenderOptions = {
  omitRoomId?: boolean;
  bundleThreads?: boolean;
  eventFormat?: 'client' | 'federation';
};
export type PublicationPoint = { stay: number; pos: number };

export async function renderEvent(
  room: Room,
  eventId: string,
  viewer: Viewer,
  opts?: RenderOptions,
): Promise<Record<string, unknown> | null> {
  return (await renderEvents(room, [eventId], viewer, opts)).get(eventId) ??
    null;
}

/** Timeline and snapshot grants stay distinct. Both use the same batch capture
 * and private formatter, including singleton and nested-relation callers. */
export async function renderEvents(
  room: Room,
  eventIds: readonly string[],
  viewer: Viewer,
  opts?: RenderOptions & {
    publications?: ReadonlyMap<string, PublicationPoint>;
    take?: number;
  },
): Promise<Map<string, Record<string, unknown>>> {
  return await captureAndRender(
    room,
    eventIds,
    viewer,
    opts,
    undefined,
    opts?.publications,
    opts?.take,
  );
}

export async function renderStateEvent(
  room: Room,
  eventId: string,
  viewer?: Viewer,
  opts?: RenderOptions & { admission?: StateAdmission },
): Promise<Record<string, unknown> | null> {
  return (await renderStateEvents(room, [eventId], viewer, opts)).get(
    eventId,
  ) ?? null;
}

export async function renderStateEvents(
  room: Room,
  eventIds: readonly string[],
  viewer?: Viewer,
  opts?: RenderOptions & { admission?: StateAdmission },
): Promise<Map<string, Record<string, unknown>>> {
  const admission = opts?.admission ??
    await admitState(room, { userId: viewer?.userId ?? null });
  if (
    admission.roomId !== room.id ||
    admission.userId !== (viewer?.userId ?? null)
  ) return new Map();
  return await captureAndRender(
    room,
    eventIds.filter((id) => admission.events.has(id)),
    viewer,
    opts,
    admission,
  );
}

type LoadedEvent = {
  pdu: Pdu;
  prev: Pdu | null;
  prevId: string | null;
  prejoinIds: string[] | null;
  membership: unknown;
  viewerMembership: string | undefined;
};

async function captureAndRender(
  room: Room,
  eventIds: readonly string[],
  viewer: Viewer | undefined,
  opts: RenderOptions | undefined,
  admission?: StateAdmission,
  publications?: ReadonlyMap<string, PublicationPoint>,
  take?: number,
): Promise<Map<string, Record<string, unknown>>> {
  const ids = [...new Set(eventIds)];
  if (!ids.length) return new Map();
  const ignored = viewer === undefined
    ? new Set<string>()
    : await ignoredSenders(viewer);
  const captured = await room.tx(async (tx) => {
    const stay = await tx.segments.latestStay();
    if (stay === null) return null;
    const version = await roomVersionOf(tx, stay.id);
    const rows = await tx.events.list(ids);
    const events = new Map<string, LoadedEvent>();
    for (const id of ids) {
      if (take !== undefined && events.size >= take) break;
      const row = rows.get(id);
      if (row === undefined) continue;
      if (admission === undefined) {
        if (!await canSeeEventAt(viewer!.userId, tx, id)) continue;
        if (row.state_key === null && ignored.has(row.sender)) continue;
      } else if ((await tx.events.getStatus(id))?.standing !== 'accepted') {
        continue;
      }
      let prev: Pdu | null = null;
      let prevId: string | null = null;
      if (row.state_key !== null) {
        const before = await tx.state.eventStateBefore(id);
        prevId = before === null
          ? null
          : await tx.state.groupKey(before.group, row.type, row.state_key);
        const old = prevId === null ? null : await tx.events.get(prevId);
        if (old !== null) prev = JSON.parse(old.pdu) as Pdu;
      }
      const pdu = JSON.parse(row.pdu) as Pdu;
      const membership = pdu.type === 'm.room.member'
        ? pdu.content?.membership
        : null;
      const prejoinGroup = membership === 'invite' || membership === 'knock'
        ? await tx.state.eventStateAfter(id)
        : null;
      const prejoinIds = prejoinGroup === null
        ? null
        : [...(await tx.state.groupMap(prejoinGroup.group)).values()];
      let viewerMembership = viewer?.membership;
      const publication = publications?.get(id);
      if (publication !== undefined && viewer !== undefined) {
        const group = await tx.state.publishedAt(
          publication.stay,
          publication.pos,
        );
        const memberId = group === null
          ? null
          : await tx.state.groupKey(group, 'm.room.member', viewer.userId);
        const member = memberId === null ? null : await tx.events.get(memberId);
        viewerMembership = String(
          member === null
            ? 'leave'
            : JSON.parse(member.pdu).content?.membership ?? 'leave',
        );
      }
      events.set(id, {
        pdu,
        prev,
        prevId,
        membership,
        prejoinIds,
        viewerMembership,
      });
    }
    return { version, events };
  });
  if (captured === null || !captured.events.size) return new Map();
  const { version, events } = captured;
  const pdus = new Map<string, Pdu>();
  for (const [id, loaded] of events) {
    pdus.set(id, loaded.pdu);
    if (loaded.prev !== null) pdus.set(loaded.prevId!, loaded.prev);
  }
  const redactions = await redactionsOf(await room.store.server(), room.id, [
    ...pdus.keys(),
  ]);
  const reasonIds = [...new Set(redactions.values())];
  const reasons = reasonIds.length
    ? await room.tx((tx) => tx.events.list(reasonIds))
    : new Map();
  for (const [id, row] of reasons) pdus.set(id, JSON.parse(row.pdu) as Pdu);
  const shown = await erasedViews(
    room,
    pdus,
    version,
    viewer === undefined ? undefined : { userId: viewer.userId },
    viewer?.tenant,
  );
  const receipts = viewer === undefined || viewer.deviceId === null
    ? new Map<string, string>()
    : await transactionsForDeviceEvents(
      viewer.tenant,
      localpartOf(viewer.userId),
      viewer.deviceId,
      room.id,
      [...events].filter(([, loaded]) => loaded.pdu.sender === viewer.userId)
        .map(([id]) => id),
    );
  const prejoin = viewer === undefined
    ? new Map<string, Record<string, unknown>[]>()
    : await prejoinDisplays(
      room,
      new Map(
        [...events].filter(([, loaded]) => loaded.prejoinIds !== null).map((
          [id, loaded],
        ) => [id, {
          ids: loaded.prejoinIds!,
          member: String(loaded.pdu.state_key),
        }]),
      ),
      viewer,
    );
  const bundles = viewer === undefined ? new Map() : await relationBundlesFor(
    room,
    new Map([...events].map(([id, loaded]) => [id, loaded.pdu])),
    viewer,
    {
      threads: opts?.bundleThreads !== false,
      redacted: new Set(
        [...events.keys()].filter((id) => reasons.has(redactions.get(id))),
      ),
    },
    ignored,
  );
  // Nested children inherit their parent's publication membership, including
  // when the same child is rendered for two different cuts in one batch.
  const nestedIds = new Map<string | undefined, Set<string>>();
  for (const [id, loaded] of events) {
    const bundle = bundles.get(id);
    const ids = nestedIds.get(loaded.viewerMembership) ?? new Set<string>();
    if (bundle?.replacement) ids.add(bundle.replacement);
    if (bundle?.thread) ids.add(bundle.thread.latest);
    nestedIds.set(loaded.viewerMembership, ids);
  }
  const nested = new Map<
    string | undefined,
    Map<string, Record<string, unknown>>
  >();
  if (viewer !== undefined) {
    for (const [membership, ids] of nestedIds) {
      if (ids.size) {
        nested.set(
          membership,
          await renderEvents(room, [...ids], { ...viewer, membership }, {
            omitRoomId: opts?.omitRoomId,
            eventFormat: opts?.eventFormat,
            bundleThreads: false,
          }),
        );
      }
    }
  }
  const result = new Map<string, Record<string, unknown>>();
  for (const [id, loaded] of events) {
    const { pdu, prev, prevId } = loaded;
    const redactionId = redactions.get(id);
    const reason = redactionId === undefined || !reasons.has(redactionId)
      ? undefined
      : shown.get(redactionId);
    const visiblePdu = reason === undefined ? shown.get(id)! : redact(
      pdu as unknown as Record<string, unknown>,
      version,
    ) as unknown as Pdu;
    const event = eventShape(visiblePdu, id, opts?.eventFormat);
    if (opts?.omitRoomId !== true) event.room_id = room.id;
    const unsigned: Record<string, unknown> = {
      age: Math.max(0, Date.now() - Number(pdu.origin_server_ts)),
    };
    if (receipts.has(id)) unsigned.transaction_id = receipts.get(id);
    if (loaded.viewerMembership !== undefined) {
      unsigned.membership = loaded.viewerMembership;
    }
    if (prejoin.has(id)) {
      unsigned[
        loaded.membership === 'knock' ? 'knock_room_state' : 'invite_room_state'
      ] = prejoin.get(id);
    }
    if (prev !== null) {
      unsigned.prev_content = redactions.has(prevId!)
        ? redact(prev as unknown as Record<string, unknown>, version).content
        : shown.get(prevId!)!.content ?? {};
      unsigned.prev_sender = prev.sender;
    }
    if (reason !== undefined) {
      const because: Record<string, unknown> = {
        event_id: redactionId,
        room_id: room.id,
        type: reason.type,
        sender: reason.sender,
        content: reason.content ?? {},
        origin_server_ts: reason.origin_server_ts,
        unsigned: {
          age: Math.max(0, Date.now() - Number(reason.origin_server_ts)),
        },
      };
      if (reason.redacts != null) because.redacts = reason.redacts;
      unsigned.redacted_because = because;
    }
    const bundle = bundles.get(id);
    const children = nested.get(loaded.viewerMembership);
    const relations: Record<string, unknown> = {};
    if (bundle?.references.length) {
      relations['m.reference'] = {
        chunk: bundle.references.map((event_id: string) => ({ event_id })),
      };
    }
    const replacement = bundle?.replacement
      ? children?.get(bundle.replacement)
      : undefined;
    if (replacement !== undefined) relations['m.replace'] = replacement;
    const latest = bundle?.thread
      ? children?.get(bundle.thread.latest)
      : undefined;
    if (latest !== undefined) {
      relations['m.thread'] = {
        latest_event: latest,
        count: bundle.thread.count,
        current_user_participated: bundle.thread.participated,
      };
    }
    if (Object.keys(relations).length) unsigned['m.relations'] = relations;
    event.unsigned = unsigned;
    result.set(id, event);
  }
  return result;
}
