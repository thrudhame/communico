import type { Store } from '#engine/store/index.ts';
import type { Conn } from '#engine/store/db.ts';

// The room publication and OOB membership share the event allocator. A later
// room publication wins, even before a post-join marker can clear the OOB row.
// All membership display/count consumers use this one selection contract.
export function visiblePrejoin(alias: string) {
  return `NOT EXISTS (SELECT 1 FROM memberships m WHERE m.room=${alias}.room_id AND m.user=${alias}.user_id AND m.seq>=${alias}.seq)`;
}

export function visibleRoomMembership(alias: string) {
  return `NOT EXISTS (SELECT 1 FROM prejoin_memberships p WHERE p.user_id=${alias}.user AND p.room_id=${alias}.room AND p.status NOT IN ('joined','attempting','failed-attempt') AND p.seq>${alias}.seq)`;
}

// A superseded durable intent can be cancelled, but an already dispatched leave
// must drain first. Process death ends the request; restart can cancel the row.
const leaving = new WeakMap<Store, Map<string, number>>();
export function prejoinLeaveActive(store: Store, room: string, user: string) {
  return (leaving.get(store)?.get(JSON.stringify([room, user])) ?? 0) > 0;
}
export function beginPrejoinLeave(store: Store, room: string, user: string) {
  let entries = leaving.get(store);
  if (!entries) leaving.set(store, entries = new Map());
  const key = JSON.stringify([room, user]);
  entries.set(key, (entries.get(key) ?? 0) + 1);
  return () => {
    const count = entries.get(key)!;
    if (count === 1) entries.delete(key);
    else entries.set(key, count - 1);
  };
}

export async function settleSupersededPrejoin(
  tx: Conn,
  room: string,
  user: string,
) {
  await tx.execute(
    `UPDATE prejoin_memberships SET status='rejected' WHERE room_id=? AND user_id=? AND status IN ('rejecting','failed-retract') AND NOT (${
      visiblePrejoin('prejoin_memberships')
    })`,
    [room, user],
  );
}
