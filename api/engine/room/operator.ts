// The operator's offered list and explicit drop. Selection is revalidated under
// the room lock after projection; a durable room change precedes any cleanup.
import type { App } from '#engine/app.ts';
import { openRoom } from '#engine/room/index.ts';
import { roomVersionOf } from '#engine/room/build.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { project, withProjectionLock } from '#engine/server/project.ts';
import { finishRoomRemoval, removalIntents } from '#engine/server/removal.ts';

export type OperatorRoom = {
  room_id: string;
  room_version: string;
  current_stay: number | null;
  purgeable_ms: number | null;
};

export async function listOperatorRooms(
  app: App,
  purgeableOnly: boolean,
): Promise<OperatorRoom[]> {
  const rows = await app.server.query(
    'SELECT r.room_id,d.purgeable_ms FROM rooms r LEFT JOIN directory d ON d.room_id=r.room_id' +
      (purgeableOnly
        ? ' WHERE d.purgeable_ms IS NOT NULL ORDER BY d.purgeable_ms,r.room_id'
        : ' ORDER BY r.room_id'),
  );
  const result: OperatorRoom[] = [];
  for (const row of rows) {
    const roomId = String(row.room_id);
    const room = await openRoom(app.store, roomId);
    const info = await room.tx(async (tx) => {
      const open = await tx.segments.openStay();
      const latest = open ?? await tx.segments.latestStay();
      if (latest === null) throw new Error(`room has no stay: ${roomId}`);
      return {
        room_version: await roomVersionOf(tx, latest.id),
        current_stay: open === null ? null : open.id,
      };
    });
    result.push({
      room_id: roomId,
      ...info,
      purgeable_ms: row.purgeable_ms === null ? null : Number(row.purgeable_ms),
    });
  }
  return result;
}

async function remove(
  app: App,
  roomId: string,
  why: string,
  cutoff: number | null,
): Promise<number | null> {
  return await withRoomLock(roomId, async () => {
    let room;
    try {
      room = await openRoom(app.store, roomId);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      if (cutoff !== null) return null;
      const live = app.sender === null
        ? null
        : await app.sender.reviewIntents();
      const intents = await removalIntents(
        app.store,
        app.tenant.serverName,
        live,
      );
      return await withProjectionLock(() =>
        finishRoomRemoval(app.store, roomId, { why, intents }, null)
      );
    }
    await project(app.store, roomId);
    if (cutoff !== null) {
      const offered = await app.server.query(
        'SELECT purgeable_ms FROM directory WHERE room_id=? AND purgeable_ms IS NOT NULL AND purgeable_ms<=?',
        [roomId, cutoff],
      );
      if (offered.length === 0) return null;
    }
    const live = app.sender === null ? null : await app.sender.reviewIntents();
    const intents = await removalIntents(
      app.store,
      app.tenant.serverName,
      live,
    );
    const removal = { why, intents };
    return await withProjectionLock(async () => {
      const position = await room.tx((tx) =>
        tx.changes.append('drop', null, removal)
      );
      return await finishRoomRemoval(app.store, roomId, removal, position);
    });
  });
}

export async function dropOperatorRoom(app: App, roomId: string) {
  return {
    room_id: roomId,
    settled: await remove(
      app,
      roomId,
      `room ${roomId} dropped by the operator`,
      null,
    ),
  };
}

export async function purgeOperatorRooms(app: App, olderThan: number | null) {
  const cutoff = olderThan === null ? Date.now() : Date.now() - olderThan;
  const result: { room_id: string; settled: number }[] = [];
  for (const row of await listOperatorRooms(app, true)) {
    const settled = await remove(
      app,
      row.room_id,
      `room ${row.room_id} purged`,
      cutoff,
    );
    if (settled !== null) result.push({ room_id: row.room_id, settled });
  }
  return result;
}
