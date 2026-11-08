// The old live-ingest push-rule hooks, consumed from durable room changes.
// A separate watermark prevents later traffic from re-copying a rule the
// user deleted. Startup completes an interrupted tenant-first migration.
import { openRoom } from '#engine/room/index.ts';
import { onProjected } from '#engine/server/project.ts';
import { listRooms } from '#engine/server/registry.ts';
import { advance, get } from '#engine/store/watermark.ts';
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { migrateRoomRules } from '#engine/tenant/pushrules.ts';
async function catchUp(store: Store, tenant: Tenant, roomId: string) {
  const room = await openRoom(store, roomId),
    server = await store.server(),
    source = 'client-room-rules:' + roomId;
  for (;;) {
    const mark = await get(server, source),
      batch = await room.tx((tx) => tx.changes.after(mark, 500));
    if (batch.length === 0) return;
    for (const change of batch) {
      if (
        (change.kind !== 'event' && change.kind !== 'transition') ||
        change.event === null
      ) continue;
      const data = JSON.parse(change.data) as {
        standing?: string;
        grounding?: string;
        offset?: number | null;
      };
      if (
        data.standing !== 'accepted' || data.grounding !== 'grounded' ||
        data.offset == null
      ) continue;
      const row = await room.tx((tx) => tx.events.get(change.event!));
      if (row === null) continue;
      const pdu = JSON.parse(row.pdu), content = pdu.content ?? {};
      if (
        pdu.type === 'm.room.tombstone' &&
        typeof content.replacement_room === 'string'
      ) await migrateRoomRules(tenant, roomId, content.replacement_room);
      if (
        pdu.type === 'm.room.create' &&
        typeof content.predecessor?.room_id === 'string'
      ) await migrateRoomRules(tenant, content.predecessor.room_id, roomId);
      if (
        pdu.type === 'm.room.member' && content.membership === 'join' &&
        typeof pdu.state_key === 'string' &&
        pdu.state_key.endsWith(':' + tenant.serverName)
      ) {
        const create = await room.tx(async (tx) => {
          const at = await tx.state.eventStateAfter(row.id);
          const id = at === null
            ? null
            : await tx.state.groupKey(at.group, 'm.room.create', '');
          const found = id === null ? null : await tx.events.get(id);
          return found === null ? null : JSON.parse(found.pdu);
        });
        const predecessor = create?.content?.predecessor?.room_id;
        if (typeof predecessor === 'string') {
          await migrateRoomRules(
            tenant,
            predecessor,
            roomId,
            pdu.state_key.slice(1, pdu.state_key.indexOf(':')),
          );
        }
      }
    }
    await server.tx((tx) => advance(tx, source, batch[batch.length - 1].pos));
  }
}
export async function installRuleMigration(store: Store, tenant: Tenant) {
  const dispose = onProjected((owner, room) =>
    owner === store ? catchUp(store, tenant, room) : undefined
  );
  try {
    for (const room of await listRooms(store)) {
      await catchUp(store, tenant, room);
    }
    return dispose;
  } catch (e) {
    dispose();
    throw e;
  }
}
