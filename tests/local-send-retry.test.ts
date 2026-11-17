import { assert, assertEquals, assertRejects } from '@std/assert';
import { closeApp, openApp } from '#engine/app.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { acceptLocal, sendLocal } from '#engine/room/ingest.ts';
import { setRoomHooks } from '#engine/room/hooks.ts';
import { project } from '#engine/server/project.ts';
import { registerRoom } from '#engine/server/registry.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import { deviceIdentity, transactionSubmission } from '#engine/tenant/txns.ts';
import { startHttp } from '#tests/http-app.ts';

for (const seam of ['prepared-only', 'tenant-finish', 'wake-lost'] as const) {
  Deno.test(
    'local acceptance recovery: ' + seam +
      ' retains signed identity across reopen and later retries',
    async () => {
      const http = await startHttp();
      let app = http.app;
      try {
        const alice = await http.registerTestUser('seam-' + seam, 'pw');
        const device = await deviceIdentity(
          app.tenant,
          'seam-' + seam,
          alice.device_id!,
        );
        const created = await createRoom(app.store, {
          creator: alice.user_id,
          preset: 'public_chat',
        }, app.tenant.signer());
        let room = await openRoom(app.store, created.roomId);
        const endpoint = {
          kind: 'send' as const,
          roomId: room.id,
          eventType: 'm.room.message',
        };
        const original = transactionSubmission(
          app.tenant,
          device,
          endpoint,
          'same-command',
        )!;
        const event = {
          type: 'm.room.message',
          sender: alice.user_id,
          content: { msgtype: 'm.text', body: 'immutable ' + seam },
        };
        if (seam === 'wake-lost') {
          // Crash after both durable commits but before scheduling, not a mocked
          // receipt. A new store composition must discover the source on disk.
          setRoomHooks({ project, register: registerRoom, enroll: () => {} });
          await acceptLocal(room, event, app.tenant.signer(), original);
        } else {
          const interrupted = {
            ...original,
            ...(seam === 'prepared-only'
              ? {
                prepare: async (
                  pdu: Parameters<typeof original.prepare>[0],
                ) => {
                  await original.prepare(pdu);
                  throw new Error('cross-file seam');
                },
              }
              : { finish: () => Promise.reject(new Error('cross-file seam')) }),
          };
          await assertRejects(
            () => acceptLocal(room, event, app.tenant.signer(), interrupted),
            Error,
            'cross-file seam',
          );
        }
        const prepared = await original.lookup();
        assert(prepared);
        const frozen = prepared.pdu === null
          ? (await room.tx((tx) => tx.events.get(prepared.eventId)))!.pdu
          : JSON.stringify(prepared.pdu);
        if (seam === 'prepared-only') {
          assertEquals(
            await room.tx((tx) => tx.events.get(prepared.eventId)),
            null,
          );
        }
        if (seam === 'wake-lost') {
          assertEquals(
            await app.server.query(
              'SELECT event FROM feed WHERE room=? AND event=?',
              [room.id, prepared.eventId],
            ),
            [],
          );
        }
        const settings = {
          dir: app.store.directory,
          library: './.native/libturso_ffi.so',
          checkpointlogbytes: 65536,
          maxopenfiles: 8,
          idleseconds: 300,
        };
        installServerHooks();
        await closeApp();
        app = await openApp(settings);
        room = await openRoom(app.store, room.id);
        if (seam !== 'prepared-only') {
          assertEquals(
            await app.server.query(
              'SELECT event FROM feed WHERE room=? AND event=?',
              [room.id, prepared.eventId],
            ),
            [{ event: prepared.eventId }],
          );
        }
        const submission = transactionSubmission(
          app.tenant,
          device,
          endpoint,
          'same-command',
        )!;
        const retry = await acceptLocal(
          room,
          { ...event, content: { body: 'must never be authored' } },
          app.tenant.signer(),
          submission,
        );
        assertEquals(retry.eventId, prepared.eventId);
        assertEquals(JSON.parse(retry.event.pdu), JSON.parse(frozen));
        const target = retry.completion!;
        await sendLocal(room, {
          ...event,
          content: { msgtype: 'm.text', body: 'a newer tip' },
        }, app.tenant.signer());
        const again = await acceptLocal(
          room,
          event,
          app.tenant.signer(),
          submission,
        );
        assertEquals(again.completion, target);
        assertEquals(
          await app.server.query(
            'SELECT event FROM feed WHERE room=? AND event=?',
            [room.id, prepared.eventId],
          ),
          [{ event: prepared.eventId }],
        );
        assertEquals(
          await room.tx((tx) => tx.completion.receipt(prepared.eventId)),
          target,
        );
        assertEquals(
          (await app.tenant.tx((tx) => tx.completion.pending(device))).length,
          1,
        );
      } finally {
        installServerHooks();
        await http.close();
      }
    },
  );
}
