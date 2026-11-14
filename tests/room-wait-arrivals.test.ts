import { assertEquals } from '@std/assert';
import { buildInTx } from '#engine/room/build.ts';
import { backfill } from '#engine/room/history.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { redactEvent, sendLocal } from '#engine/room/ingest.ts';
import { joinRemote } from '#engine/room/join.ts';
import { importReplicaBoundary } from '#engine/room/replica.ts';
import { openStore } from '#engine/store/index.ts';
import { genesis } from './fixtures/genesis.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  remoteEvent,
} from './fixtures/remote.ts';
import { makeFakeRoom } from './fixtures/remote-room.ts';
import { testRemoteServer, testSigner } from './fixtures/signer.ts';

Deno.test('backfill completion drains dependency work made ready by historical arrivals', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  try {
    const g = await genesis(store, { roomId: '!wait-backfill:test' });
    const target = await g.room.tx((tx) =>
      buildInTx(tx, g.room.id, {
        type: 'm.room.message',
        sender: g.creator,
        content: { body: 'historical target' },
      }, g.signer)
    );
    const redaction = await redactEvent(
      g.room,
      g.creator,
      target.event_id!,
      g.signer,
    );
    const { fetcher } = fakeFetcher({ backfill: [target] });
    const result = await backfill(g.room, {
      from: [redaction.eventId],
      limit: 10,
      via: 'test',
    }, {
      self: g.signer.serverName,
      keys: fakeKeyResolver(await testRemoteServer()),
      fetcher,
    });
    assertEquals(result.positioned, [target.event_id!]);
    assertEquals(await g.room.tx((tx) => tx.waits.of(redaction.eventId)), []);
    const changes = await g.room.tx((tx) => tx.changes.after(0, 200));
    assertEquals(
      changes.filter((change) =>
        change.kind === 'redaction' && change.event === redaction.eventId
      ).length,
      1,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

for (const composition of ['rejoin', 'replica']) {
  Deno.test(`${composition} completion drains dependency work made ready by snapshot evidence`, async () => {
    const dir = await Deno.makeTempDir();
    const store = await openStore({
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { room: roomSchema } });
    try {
      const fr = await makeFakeRoom({ roomId: '!wait-rejoin:remote.test' });
      const user = '@anna:test', signer = await testSigner();
      const oldPower = fr.events.get(fr.powerLevelsId)!;
      await fr.addEvent({
        type: 'm.room.power_levels',
        state_key: '',
        content: {
          ...oldPower.content,
          users: { [fr.creator]: 100, [user]: 100 },
        },
      });
      const { fetcher } = fakeFetcher({
        makeJoin: (user) => fr.makeJoinAnswer(user),
        sendJoin: (event) => fr.acceptSendJoin(event),
      });
      const deps = {
        self: 'test',
        keys: fakeKeyResolver(fr.server, await testRemoteServer()),
        fetcher,
      };
      const join = () =>
        joinRemote(store, {
          roomId: fr.roomId,
          user,
          via: [fr.server.name],
          signer,
          deps,
        });
      await join();
      const room = await openRoom(store, fr.roomId);
      const target = await fr.addEvent({
        type: 'm.room.topic',
        state_key: '',
        content: { topic: 'snapshot target' },
      });
      const redaction = await redactEvent(room, user, target.event_id!, signer);
      await sendLocal(room, {
        type: 'm.room.member',
        sender: user,
        state_key: user,
        content: { membership: 'leave' },
      }, signer);
      assertEquals(await room.tx((tx) => tx.segments.openStay()), null);
      if (composition === 'rejoin') {
        await join();
      } else {
        const template = fr.makeJoinAnswer(user).event;
        const next = await remoteEvent(
          fr.roomId,
          await testRemoteServer(),
          fr.version,
          {
            ...template,
            sender: user,
            prev_events: template.prev_events ?? [],
          },
        );
        const answer = await fr.acceptSendJoin(next);
        await importReplicaBoundary(store, {
          roomId: fr.roomId,
          roomVersion: fr.version,
          self: deps.self,
          resident: fr.server.name,
          keys: deps.keys,
          join: answer.event,
          state: answer.state,
          authChain: answer.authChain,
        });
      }
      assertEquals(
        (await room.tx((tx) => tx.events.getStatus(target.event_id!)))
          ?.grounding,
        'evidence',
      );
      assertEquals(await room.tx((tx) => tx.waits.of(redaction.eventId)), []);
      assertEquals(
        await room.tx((tx) => tx.segments.positionOf(target.event_id!)),
        null,
      );
      const changes = await room.tx((tx) => tx.changes.after(0, 200));
      assertEquals(
        changes.filter((change) =>
          change.kind === 'redaction' && change.event === redaction.eventId
        ).length,
        1,
      );
    } finally {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}
