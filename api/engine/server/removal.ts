// A room's durable drop change is the recovery source until cleanup finishes.
// Server cleanup commits before unlinking that source. Startup replay is safe
// at every intermediate point and never resurrects a dropped room's projection.
import type { Store } from '#engine/store/index.ts';
import { recordRefusal } from '#engine/federation/sender.ts';
import { listRejectIntents } from '#engine/federation/invites.ts';
import type { ReviewIntent } from '#engine/federation/sender.ts';
import { roomEdges } from '#engine/room/edges.ts';
import { advance } from '#engine/store/watermark.ts';
import { reconcileDeviceRoom } from '#engine/server/e2ee.ts';
import { removeNotificationFacts } from '#engine/server/notifications.ts';
import { visiblePrejoin } from './prejoin.ts';

export type Removal = { why: string; intents: ReviewIntent[] };

export async function finishRoomRemoval(
  store: Store,
  roomId: string,
  removal: Removal,
  position: number | null,
): Promise<number> {
  await store.retireRoom(roomId);
  const db = await store.server();
  const localServers = await store.tenants();
  const settled = await db.tx(async (tx) => {
    await reconcileDeviceRoom(
      tx,
      roomId,
      [],
      false,
      null,
      Number.MAX_SAFE_INTEGER,
      localServers,
    );
    await tx.execute('DELETE FROM e2ee_rooms WHERE room=?', [roomId]);
    await removeNotificationFacts(tx, { room: roomId });
    await tx.execute('DELETE FROM watermarks WHERE source=?', [
      'push-context:' + roomId,
    ]);
    const rows = await tx.query(
      "SELECT destination, count(*) AS n FROM outbox WHERE room = ? AND state = 'pending' GROUP BY destination",
      [roomId],
    );
    const byDestination = new Map(
      rows.map((r) => [String(r.destination), Number(r.n)]),
    );
    const pending = await tx.query(
      `SELECT room_id,user_id,status FROM prejoin_memberships p WHERE room_id=? AND status IN ('rejecting','attempting','failed-attempt','failed-retract') AND ${
        visiblePrejoin('p')
      }`,
      [roomId],
    );
    for (const row of pending) {
      const intent = removal.intents.find((i) =>
        i.id ===
          (String(row.status).includes('attempt')
              ? 'knock-attempt:'
              : 'reject-invite:') +
            JSON.stringify([String(row.room_id), String(row.user_id)])
      );
      if (intent === undefined) {
        throw new Error('room removal missing prejoin delivery owner');
      }
      byDestination.set(
        intent.destination,
        (byDestination.get(intent.destination) ?? 0) + 1,
      );
    }
    let count = 0;
    for (const [destination, n] of byDestination) {
      await recordRefusal(tx, destination, {
        code: null,
        errcode: null,
        error: removal.why,
        txnId: null,
      }, n);
      count += n;
    }
    for (
      const table of [
        'event_index',
        'feed',
        'memberships',
        'redactions',
        'relations',
        'search',
        'outbox',
        'forgotten',
      ]
    ) {
      await tx.execute(`DELETE FROM ${table} WHERE room = ?`, [roomId]);
    }
    for (
      const table of [
        'receipts',
        'aliases',
        'directory',
        'visibility',
        'prejoin_memberships',
        'rooms',
      ]
    ) {
      await tx.execute(`DELETE FROM ${table} WHERE room_id = ?`, [roomId]);
    }
    // Keep the drop as the next replay item until its source file is gone.
    if (position !== null) await advance(tx, 'room:' + roomId, position - 1);
    return count;
  });
  await store.removeRoom(roomId);
  roomEdges.forgetOwner(store);
  await db.execute('DELETE FROM watermarks WHERE source = ?', [
    'room:' + roomId,
  ]);
  return settled;
}

export async function removalIntents(
  store: Store,
  self: string,
  live: ReviewIntent[] | null,
) {
  return live === null
    ? await listRejectIntents(await store.server(), self)
    : live;
}
