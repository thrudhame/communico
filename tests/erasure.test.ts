import { assert, assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { deactivateUser, registerUser } from '#engine/tenant/users.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { createRoom } from '#engine/room/create.ts';
import { testSigner } from './fixtures/signer.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import {
  serveBackfill,
  serveEvent,
  serveGetMissingEvents,
  serveState,
} from '#engine/federation/serve.ts';
import { bobJoins } from './fixtures/genesis.ts';
import { renderEvent } from '#engine/client/render.ts';

installServerHooks();
for (const version of ['10', '11', '12']) {
  Deno.test(
    'erasure v' + version +
      ': durable viewer-specific client/federation pruning without PDU rewrites',
    async () => {
      const dir = await Deno.makeTempDir();
      const settings = {
        dir,
        library: './.native/libturso_ffi.so',
        checkpointlogbytes: 65536,
        maxopenfiles: 8,
        idleseconds: 300,
      };
      const schemas = {
        room: roomSchema,
        server: serverSchema,
        tenant: tenantSchema,
      };
      let store = await openStore(settings, { schemas });
      try {
        const tenant = await openTenant(store, 'test', { create: true });
        await registerUser(tenant, { localpart: 'dev', password: 'pw' });
        const signer = await testSigner();
        const creator = '@dev:test';
        const created = await createRoom(store, {
          creator,
          version,
          preset: 'public_chat',
        }, signer);
        const g = {
          room: await openRoom(store, created.roomId),
          roomId: created.roomId,
          creator,
          signer,
          createId: created.createEventId,
          tipId: created.memberEventId,
        };
        await bobJoins(g, '@old:old.test');
        const message = await sendLocal(g.room, {
          type: 'm.room.message',
          sender: g.creator,
          content: { msgtype: 'm.text', body: 'private-original' },
        }, g.signer);
        const topic = await sendLocal(g.room, {
          type: 'm.room.topic',
          state_key: '',
          sender: g.creator,
          content: { topic: 'private-topic' },
        }, g.signer);
        await bobJoins(g, '@shared:shared.test');
        const original = await g.room.tx((tx) =>
          tx.events.get(message.eventId)
        );
        const cut = await g.room.tx((tx) => tx.state.erasureCut());
        await deactivateUser(tenant, 'dev', { [g.roomId]: cut });
        const newcomer = await bobJoins(g, '@new:new.test');
        let deps = { store, server: await store.server(), self: 'test' };
        for (const server of ['old.test', 'shared.test']) {
          assertEquals(
            (await serveEvent(message.eventId, server, deps)).pdus[0].content,
            { msgtype: 'm.text', body: 'private-original' },
          );
        }
        assertEquals(
          (await serveEvent(message.eventId, 'new.test', deps)).pdus[0].content,
          {},
        );
        const state = await serveState(g.roomId, newcomer, 'new.test', deps);
        assertEquals(
          state.pdus.find((p) => p.type === 'm.room.topic')?.content,
          {},
        );
        const backfill = await serveBackfill(
          g.roomId,
          [message.eventId],
          100,
          'new.test',
          deps,
        );
        assertEquals(
          backfill.pdus.find((p) => p.type === 'm.room.message')?.content,
          {},
        );
        const missing = await serveGetMissingEvents(
          g.roomId,
          { latest_events: [newcomer], earliest_events: [], limit: 100 },
          'new.test',
          deps,
        );
        assertEquals(
          missing.events.find((p) => p.type === 'm.room.message')?.content,
          {},
        );
        assertEquals(
          await g.room.tx((tx) => tx.events.get(message.eventId)),
          original,
        );
        assertEquals(
          (await renderEvent(g.room, topic.eventId, {
            userId: '@new:new.test',
            deviceId: null,
            tenant,
          }))?.content,
          {},
        );
        await store.close();
        store = await openStore(settings, { schemas });
        deps = { store, server: await store.server(), self: 'test' };
        assertEquals(
          (await serveEvent(message.eventId, 'new.test', deps)).pdus[0].content,
          {},
        );
        assertEquals(
          (await serveEvent(message.eventId, 'shared.test', deps)).pdus[0]
            .content,
          { msgtype: 'm.text', body: 'private-original' },
        );
        const reopened = await openTenant(store, 'test');
        // A retry with a later boundary must not grant newcomers visibility.
        await deactivateUser(reopened, 'dev', {
          [g.roomId]: {
            changePos: Number.MAX_SAFE_INTEGER,
            segment: Number.MAX_SAFE_INTEGER,
            group: Number.MAX_SAFE_INTEGER,
          },
        });
        assertEquals(
          (await serveEvent(message.eventId, 'new.test', deps)).pdus[0].content,
          {},
        );
        assert(original?.pdu.includes('private-original'));
      } finally {
        await store.close();
        await Deno.remove(dir, { recursive: true });
      }
    },
  );
}
