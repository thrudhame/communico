// Extension selection composes captured owner data, not room timeline deltas.
import type { RoomExtension } from './types.ts';
import type { AccountDataRow } from '#engine/tenant/accountdata.ts';
import { receiptContent, type ReceiptRow } from '#engine/server/ephemeral.ts';
import type { TypingSnapshot } from '#engine/typing.ts';
import type { Database } from '#engine/store/db.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import type { DeviceIdentity } from '#engine/tenant/devices.ts';
import { deviceListsBetween } from '#engine/server/e2ee.ts';

export type E2eeExtensionState = { deviceCut: number; poolSeq: number };

/** The coordinator supplies this connection's last enabled device cut, or its
 * creation baseline when enabling later. Disabled calls read nothing and cannot
 * advance either cut. Initial no-pos requests intentionally have empty deltas. */
export async function e2eeExtension(input: {
  enabled: boolean;
  server: Database;
  tenant: Tenant;
  device: DeviceIdentity;
  since: number | null;
  through: number;
  previousPoolSeq?: number;
}) {
  if (!input.enabled) return null;
  const { server, tenant, device, since, through } = input;
  const pools = await tenant.tx((tx) => tx.e2ee.status(device));
  const lists = since === null
    ? { changed: [], left: [] }
    : await deviceListsBetween(
      server,
      `@${device.localpart}:${tenant.serverName}`,
      since,
      through,
      'sync',
    );
  return {
    response: {
      device_lists: lists,
      device_one_time_keys_count: pools.counts,
      device_unused_fallback_key_types: pools.unused,
    },
    state: {
      deviceCut: through,
      poolSeq: pools.seq,
    } satisfies E2eeExtensionState,
    relevant: lists.changed.length > 0 || lists.left.length > 0 ||
      (input.previousPoolSeq !== undefined &&
        input.previousPoolSeq !== pools.seq),
  };
}

export type ExtensionScope = {
  lists: ReadonlyMap<string, ReadonlySet<string>>;
  subscriptions: ReadonlySet<string>;
};

/** Inputs contain only admitted list windows and subscriptions. Extension room
 * IDs cannot request arbitrary rooms or turn a list window into a subscription. */
export function extensionRooms(
  request: RoomExtension | undefined,
  scope: ExtensionScope,
): Set<string> {
  const selected = new Set<string>();
  if (!request?.enabled) return selected;
  for (const name of request.lists) {
    if (name === '*') {
      for (const rooms of scope.lists.values()) {
        for (const room of rooms) selected.add(room);
      }
      break;
    }
    for (const room of scope.lists.get(name) ?? []) selected.add(room);
  }
  for (const room of request.rooms) {
    if (room === '*') {
      for (const id of scope.subscriptions) selected.add(id);
      break;
    }
    if (scope.subscriptions.has(room)) selected.add(room);
  }
  return selected;
}

export type RoomExtensionCuts = Record<string, number>;

/** The owner captures bodies and maximum together. Only rooms actually selected
 * by this extension advance; out-of-window rooms retain their earlier cut. */
export function accountDataExtension(
  snapshot: {
    seq: number;
    global: AccountDataRow[];
    rooms: Map<string, AccountDataRow[]>;
  },
  selected: ReadonlySet<string>,
  previous: RoomExtensionCuts,
) {
  const cuts = { ...previous };
  const rooms: Record<string, AccountDataRow[]> = {};
  for (const room of selected) {
    if (!snapshot.rooms.has(room)) continue;
    cuts[room] = snapshot.seq;
    const events = snapshot.rooms.get(room);
    if (events?.length) rooms[room] = events;
  }
  return {
    response: { global: snapshot.global, rooms },
    cuts,
    relevant: snapshot.global.length > 0 || Object.keys(rooms).length > 0,
  };
}

type Timeline = {
  initial?: boolean;
  unstable_expanded_timeline?: boolean;
  timeline?: { event_id?: unknown }[];
};

function initialReceipts(
  timeline: Timeline | undefined,
  previous: number | undefined,
) {
  return previous === undefined || timeline?.initial === true ||
    timeline?.unstable_expanded_timeline === true;
}

export function receiptCaptureSince(
  timeline: Timeline | undefined,
  previous: number | undefined,
): number {
  return initialReceipts(timeline, previous) ? 0 : previous!;
}

export function receiptsExtension(
  viewer: string,
  selected: ReadonlySet<string>,
  snapshot: ReadonlyMap<string, ReceiptRow[]>,
  through: number,
  previous: RoomExtensionCuts,
  timelines: Readonly<Record<string, Timeline>>,
) {
  const cuts = { ...previous };
  const rooms: Record<
    string,
    { type: 'm.receipt'; content: ReturnType<typeof receiptContent> }
  > = {};
  for (const room of selected) {
    const timeline = timelines[room];
    const initial = initialReceipts(timeline, previous[room]);
    const eventIds = new Set(timeline?.timeline?.map((e) => e.event_id) ?? []);
    const rows = (snapshot.get(room) ?? []).filter((row) =>
      row.seq <= through &&
      (row.receiptType === 'm.read' || row.userId === viewer) &&
      (initial
        ? row.userId === viewer || row.eventIds.some((id) => eventIds.has(id))
        : row.seq > previous[room])
    );
    if (rows.length) {
      rooms[room] = { type: 'm.receipt', content: receiptContent(rows) };
    }
    cuts[room] = through;
  }
  return { response: { rooms }, cuts, relevant: Object.keys(rooms).length > 0 };
}

export type TypingCuts = { epoch: string; rooms: RoomExtensionCuts };

export function typingExtension(
  selected: ReadonlySet<string>,
  snapshot: TypingSnapshot,
  previous: TypingCuts | undefined,
) {
  const sameProcess = previous?.epoch === snapshot.epoch;
  const cuts: TypingCuts = {
    epoch: snapshot.epoch,
    rooms: sameProcess ? { ...previous.rooms } : {},
  };
  const rooms: Record<
    string,
    { type: 'm.typing'; content: { user_ids: string[] } }
  > = {};
  for (const room of selected) {
    const value = snapshot.rooms.get(room);
    if (value === undefined) continue;
    const since = sameProcess ? previous.rooms[room] : undefined;
    // Initial empty values are useful snapshots; subsequent empty stops must
    // also reach clients. A process restart invalidates durable ephemeral cuts.
    if (since === undefined || value.changed > since) {
      rooms[room] = { type: 'm.typing', content: { user_ids: value.userIds } };
    }
    cuts.rooms[room] = snapshot.seq;
  }
  return { response: { rooms }, cuts, relevant: Object.keys(rooms).length > 0 };
}
