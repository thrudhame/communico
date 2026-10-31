// tests/fixtures/genesis.ts — the five-event genesis through the ingest
// pipeline (create, join, PL, join_rules, history_visibility), the shared
// starting point for ingest/redaction/membership/create tests.
import { assertEquals } from '@std/assert';
import { buildCreate } from '#engine/room/build.ts';
import { openRoom, type Room } from '#engine/room/index.ts';
import { ingestInTx, sendLocal } from '#engine/room/ingest.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import type { Signer } from '#engine/room/signer.ts';
import type { Store } from '#engine/store/index.ts';
import { testSigner } from '#tests/fixtures/signer.ts';

export const PL_DEFAULTS = (creator: string) => ({
  ban: 50,
  events: {},
  events_default: 0,
  invite: 0,
  kick: 50,
  redact: 50,
  state_default: 50,
  users: { [creator]: 100 },
  users_default: 0,
  notifications: { room: 50 },
});

export type Genesis = {
  room: Room;
  roomId: string;
  signer: Signer;
  creator: string;
  createId: string;
  tipId: string;
};

export async function genesis(
  store: Store,
  opts: { version?: string; joinRule?: string; roomId?: string } = {},
): Promise<Genesis> {
  const version = opts.version ?? '11';
  const signer = await testSigner();
  const creator = '@dev:' + signer.serverName;
  const create = await buildCreate(
    {
      sender: creator,
      content: { room_version: version },
      origin_server_ts: 1,
      roomId: opts.roomId,
    },
    signer,
    version,
  );
  const roomId = version === '12'
    ? '!' + create.event_id!.slice(1)
    : opts.roomId!;
  const room = await openRoom(store, roomId, { create: true });
  await withRoomLock(roomId, () =>
    room.tx(async (tx) => {
      const empty = await tx.materialize.newGroup(null, []);
      await tx.segments.create({ kind: 'stay', opening_group: empty });
      const created = await ingestInTx(tx, roomId, create);
      assertEquals(created.standing, 'accepted');
    }));
  let tip = (await sendLocal(room, {
    type: 'm.room.member',
    sender: creator,
    state_key: creator,
    content: { membership: 'join' },
    origin_server_ts: 2,
  }, signer)).eventId;
  tip = (await sendLocal(room, {
    type: 'm.room.power_levels',
    sender: creator,
    state_key: '',
    content: PL_DEFAULTS(creator),
    origin_server_ts: 3,
  }, signer)).eventId;
  tip = (await sendLocal(room, {
    type: 'm.room.join_rules',
    sender: creator,
    state_key: '',
    content: { join_rule: opts.joinRule ?? 'invite' },
    origin_server_ts: 4,
  }, signer)).eventId;
  tip = (await sendLocal(room, {
    type: 'm.room.history_visibility',
    sender: creator,
    state_key: '',
    content: { history_visibility: 'shared' },
    origin_server_ts: 5,
  }, signer)).eventId;
  return {
    room,
    roomId,
    signer,
    creator,
    createId: create.event_id!,
    tipId: tip,
  };
}

export async function bobJoins(
  g: Genesis,
  user = '@bob:test',
  ts = 1000,
): Promise<string> {
  const invite = await sendLocal(g.room, {
    type: 'm.room.member',
    sender: g.creator,
    state_key: user,
    content: { membership: 'invite' },
    origin_server_ts: ts,
  }, g.signer);
  assertEquals(invite.standing, 'accepted');
  const join = await sendLocal(g.room, {
    type: 'm.room.member',
    sender: user,
    state_key: user,
    content: { membership: 'join' },
    origin_server_ts: ts + 1,
  }, g.signer);
  assertEquals(join.standing, 'accepted');
  return join.eventId;
}
