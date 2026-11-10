import { assertEquals, assertRejects } from '@std/assert';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { ingestInTx } from '#engine/room/ingest.ts';
import { openStore } from '#engine/store/index.ts';
import { verify } from '#engine/room/verify.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import {
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
} from '#tests/fixtures/remote.ts';
import type { Pdu } from '#engine/pdu.ts';
import { validEventUserId } from '#engine/ids.ts';

Deno.test('event-user references reject NUL, lone surrogates, bad domains and oversized UTF-8 without normalizing historical names', () => {
  for (
    const user of [
      '@:remote.test',
      '@UpperCase:remote.test',
      '@\ncontrol:remote.test',
      '@\u{1f600}:remote.test',
    ]
  ) {
    assertEquals(validEventUserId(user), true);
  }
  for (
    const user of [
      '@nul\0:remote.test',
      '@\uD800:remote.test',
      '@x:remote.test\n',
      '@x:dom$ain',
      '@' + '\u00e9'.repeat(128) + ':remote.test',
    ]
  ) {
    assertEquals(validEventUserId(user), false);
  }
});

Deno.test('historical IDs: verified ingest and references preserve Unicode, controls and empty user localparts in v3-v12', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  const server = await makeRemoteServer('remote.test');
  const keys = fakeKeyResolver(server);
  try {
    for (
      const version of ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12']
    ) {
      for (
        const localpart of ['UpperCase', '\u00e9\u{1f600}', '', '\ncontrol']
      ) {
        const user = '@' + localpart + ':remote.test';
        const reference = '@' + localpart + '-reference:remote.test';
        const extra = '@' + localpart + '-creator:remote.test';
        const initialId = '!opaque\n\u00e9-' + version + '-' +
          crypto.randomUUID() + ':remote.test';
        const create = await remoteEvent(initialId, server, version, {
          type: 'm.room.create',
          sender: user,
          state_key: '',
          prev_events: [],
          depth: 1,
          omitRoomId: version === '12',
          content: {
            room_version: version,
            ...(Number(version) <= 10 ? { creator: user } : {}),
            ...(version === '12' ? { additional_creators: [extra] } : {}),
          },
        });
        const roomId = version === '12'
          ? '!' + create.event_id!.slice(1)
          : initialId;
        const room = await openRoom(store, roomId, { create: true });
        await room.tx(async (tx) => {
          const empty = await tx.materialize.newGroup(null, []);
          await tx.segments.create({ kind: 'stay', opening_group: empty });
        });
        let tip = '';
        let depth = 1;
        for (
          const partial of [
            null,
            {
              type: 'm.room.member',
              state_key: user,
              content: { membership: 'join' },
            },
            {
              type: 'm.room.power_levels',
              state_key: '',
              content: {
                users: {
                  [reference]: 10,
                  ...(version === '12' ? {} : { [user]: 100 }),
                },
              },
            },
            {
              type: 'm.room.message',
              content: { msgtype: 'm.text', body: 'historical ID' },
            },
          ]
        ) {
          const state = await room.tx(async (tx) => {
            const stay = await tx.segments.openStay();
            const group = stay === null
              ? null
              : await tx.state.current(stay.id);
            return group === null
              ? new Map<string, string>()
              : await tx.state.groupMap(group);
          });
          const event = partial === null
            ? create
            : await remoteEvent(roomId, server, version, {
              ...partial,
              sender: user,
              prev_events: [tip],
              depth: ++depth,
              auth_events: getRulebook(version).selectAuthEvents(
                { ...partial, sender: user } as unknown as Pdu,
                state,
              ),
            });
          const verified = await verify(structuredClone(event), version, keys, {
            roomId,
          });
          const accepted = await room.tx((tx) =>
            ingestInTx(tx, roomId, verified.pdu, { self: server.name })
          );
          assertEquals(
            accepted.standing,
            'accepted',
            JSON.stringify({ version, localpart, type: event.type, accepted }),
          );
          tip = event.event_id!;
          const stored = await room.tx((tx) => tx.events.get(tip));
          assertEquals(JSON.parse(stored!.pdu).sender, user);
        }
      }
      // Identifier limits are UTF-8 bytes even in versions whose state-key
      // limit is codepoint-based. JSON escapes do not change that bound.
      const tooLong = await remoteEvent(
        '!bounds:remote.test',
        server,
        version,
        {
          type: 'm.room.message',
          sender: '@' + '\u00e9'.repeat(128) + ':remote.test',
          prev_events: [],
        },
      );
      await assertRejects(
        () => verify(tooLong, version, keys),
        Error,
        'identifier exceeds',
      );
    }
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
