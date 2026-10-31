// api/engine/room/index.ts — the typed room handle: one room file, one
// transaction per tx() call, every data operation exposed inside it under
// its module's short name. The store must have been opened with the room
// schema provider (R14).
import type { Store } from '#engine/store/index.ts';
import { type Conn, Db } from '#engine/store/db.ts';
import * as changes from '#engine/room/changes.ts';
import * as events from '#engine/room/events.ts';
import * as extremities from '#engine/room/extremities.ts';
import * as materialize from '#engine/room/materialize.ts';
import * as segments from '#engine/room/segments.ts';
import { roomSchema } from '#engine/room/schema.ts';
import * as state from '#engine/room/state.ts';
import * as waits from '#engine/room/waits.ts';

export { roomSchema };
export type { EventRow, Status, Walk } from '#engine/room/events.ts';
export type { StateChange, StateMap } from '#engine/room/state.ts';
export type { Segment } from '#engine/room/segments.ts';
export type { Wait } from '#engine/room/waits.ts';
export type { Change } from '#engine/room/changes.ts';

function bind(conn: Conn) {
  return {
    events: {
      insert: (id: string, pdu: string) => events.insertEvent(conn, id, pdu),
      get: (id: string) => events.getEvent(conn, id),
      list: (ids: readonly string[]) => events.getEvents(conn, ids),
      prevsOf: (event: string) => events.prevsOf(conn, event),
      authsOf: (event: string) => events.authsOf(conn, event),
      childrenOf: (prev: string) => events.childrenOf(conn, prev),
      authChildrenOf: (auth: string) => events.authChildrenOf(conn, auth),
      authClosure: (seeds: readonly string[], limit: number) =>
        events.authClosure(conn, seeds, limit),
      ancestors: (
        seeds: readonly string[],
        stopAt: readonly string[],
        limit: number,
      ) => events.ancestors(conn, seeds, stopAt, limit),
      getStatus: (event: string) => events.getStatus(conn, event),
      setStatus: (event: string, status: events.Status) =>
        events.setStatus(conn, event, status),
      statuses: (ids: readonly string[]) => events.statuses(conn, ids),
    },
    state: {
      groupEntries: (group: number) => state.groupEntries(conn, group),
      groupMap: (group: number) => state.groupMap(conn, group),
      groupKey: (group: number, type: string, stateKey: string) =>
        state.groupKey(conn, group, type, stateKey),
      eventStateBefore: (event: string) => state.eventStateBefore(conn, event),
      eventStateAfter: (event: string) => state.eventStateAfter(conn, event),
      publishedAt: (stay: number, pos: number) =>
        state.publishedAt(conn, stay, pos),
      current: (stay: number) => state.current(conn, stay),
    },
    materialize: {
      newGroup: (parent: number | null, batch: state.StateChange[]) =>
        materialize.newGroup(conn, parent, batch),
      setEventState: (
        event: string,
        before: number | null,
        after: number | null,
        provenance: materialize.Provenance,
      ) => materialize.setEventState(conn, event, before, after, provenance),
      publish: (changePos: number, stay: number, group: number) =>
        materialize.publish(conn, changePos, stay, group),
      setCurrent: (stay: number, group: number) =>
        materialize.setCurrent(conn, stay, group),
    },
    segments: {
      create: (options: {
        kind: 'stay' | 'history';
        prev?: number | null;
        opened_by?: string | null;
        opening_group?: number | null;
        status?: string;
      }) => segments.createSegment(conn, options),
      close: (id: number) => segments.closeSegment(conn, id),
      setOpenedBy: (id: number, event: string) =>
        segments.setOpenedBy(conn, id, event),
      get: (id: number) => segments.getSegment(conn, id),
      list: () => segments.listSegments(conn),
      openStay: () => segments.openStay(conn),
      historyOf: (stay: number) => segments.historyOf(conn, stay),
      latestStay: () => segments.latestStay(conn),
      positionOf: (event: string) => segments.positionOf(conn, event),
      appendPosition: (segment: number, event: string) =>
        segments.appendPosition(conn, segment, event),
      prependPositions: (segment: number, ids: readonly string[]) =>
        segments.prependPositions(conn, segment, ids),
      positionsPage: (
        segment: number,
        from: number,
        dir: 'f' | 'b',
        limit: number,
      ) => segments.positionsPage(conn, segment, from, dir, limit),
    },
    extremities: {
      frontier: (stay: number) => extremities.frontier(conn, stay),
      add: (stay: number, event: string) =>
        extremities.addExtremity(conn, stay, event),
      remove: (stay: number, ids: readonly string[]) =>
        extremities.removeExtremities(conn, stay, ids),
    },
    waits: {
      add: (wait: waits.Wait) => waits.addWait(conn, wait),
      for: (missing: string) => waits.waitsFor(conn, missing),
      of: (waiting: string) => waits.waitsOf(conn, waiting),
      all: () => waits.allWaits(conn),
      expired: (now: number) => waits.expiredWaits(conn, now),
      remove: (missing: string, waiting: string, kind: string) =>
        waits.removeWait(conn, missing, waiting, kind),
      removeOf: (waiting: string) => waits.removeWaitsOf(conn, waiting),
    },
    changes: {
      append: (kind: string, event: string | null, data: unknown) =>
        changes.appendChange(conn, kind, event, data),
      after: (pos: number, limit: number) =>
        changes.changesAfter(conn, pos, limit),
    },
  };
}

export type RoomTx = ReturnType<typeof bind>;

export type Room = {
  readonly id: string;
  tx<T>(fn: (room: RoomTx) => Promise<T>): Promise<T>;
};

export async function openRoom(
  store: Store,
  roomId: string,
  options: { create?: boolean } = {},
): Promise<Room> {
  const db: Db = await store.room(roomId, options);
  return {
    id: roomId,
    tx: (fn) => db.tx((conn) => fn(bind(conn))),
  };
}
