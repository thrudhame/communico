import { assert, assertEquals } from '@std/assert';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { startHttp } from '#tests/http-app.ts';
import { completionService } from '#engine/server/completion.ts';
import { holdPublication } from '#tests/support/hold-publication.ts';

for (const holder of ['foreign', 'own'] as const) {
  Deno.test(
    'local acceptance: HTTP acknowledges with ' + holder +
      ' publication still held',
    async () => {
      const http = await startHttp();
      const app = http.app;
      const jobs: Promise<unknown>[] = [];
      let hold: ReturnType<typeof holdPublication> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const alice = await http.registerTestUser('completion-' + holder, 'pw');
        const signer = app.tenant.signer();
        const created = await createRoom(app.store, {
          creator: alice.user_id,
          preset: 'public_chat',
        }, signer);
        const room = await openRoom(app.store, created.roomId);
        const other = holder === 'own' ? created : await createRoom(app.store, {
          creator: alice.user_id,
          preset: 'public_chat',
        }, signer);
        const blockedRoom = await openRoom(app.store, other.roomId);
        const authenticated = (path: string, body?: Record<string, unknown>) =>
          http.matrix(
            new Request('http://x/_matrix/client/' + path, {
              method: body === undefined ? 'GET' : 'POST',
              headers: {
                Authorization: 'Bearer ' + alice.access_token,
                'Content-Type': 'application/json',
              },
              body: body === undefined ? undefined : JSON.stringify(body),
            }),
          );
        const baseline = await authenticated('v3/sync?timeout=0');
        assertEquals(baseline.status, 200);
        const since = (await baseline.json()).next_batch;
        hold = holdPublication(app, other.roomId);
        const blocked = sendLocal(blockedRoom, {
          type: 'm.room.message',
          sender: alice.user_id,
          content: { msgtype: 'm.text', body: 'held owner' },
        }, signer);
        jobs.push(blocked);
        await hold.entered;
        let released = false;
        const request = http.matrix(
          new Request(
            'http://x/_matrix/client/v3/rooms/' + encodeURIComponent(room.id) +
              '/send/m.room.message/owned-completion',
            {
              method: 'PUT',
              headers: {
                Authorization: 'Bearer ' + alice.access_token,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                msgtype: 'm.text',
                body: 'durable while held',
              }),
            },
          ),
        );
        jobs.push(request);
        // Diagnostic liveness guard only. The contract assertion is the ordering:
        // an actual 200 with the publication owner STILL held, not a latency goal.
        const response = await Promise.race([
          request,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), 10000);
          }),
        ]);
        assert(
          response !== null,
          'HTTP acceptance retained the held publication owner',
        );
        assertEquals(released, false);
        assertEquals(response.status, 200);
        const accepted = await response.json();
        assert(typeof accepted.event_id === 'string');
        const event = await room.tx((tx) => tx.events.get(accepted.event_id));
        assert(event !== null);
        assertEquals(JSON.parse(event.pdu).content.body, 'durable while held');
        const tenant = await app.store.tenant(app.tenant.serverName);
        const receipts = await tenant.query(
          'SELECT event_id,completed,pending_pdu FROM transactions WHERE txn_id=?',
          ['owned-completion'],
        );
        assertEquals(receipts, [{
          event_id: accepted.event_id,
          completed: 1,
          pending_pdu: null,
        }]);
        const synced: { response: Promise<Response>; kind: string }[] = [];
        if (holder === 'own') {
          const owner = completionService(app.store);
          const wait = owner.wait.bind(owner);
          const captured = Promise.withResolvers<void>();
          let captures = 0;
          owner.wait = (target, phase, signal, self) => {
            if (
              phase === 'publication' && target.roomId === room.id &&
              ++captures === 10
            ) captured.resolve();
            return wait(target, phase, signal, self);
          };
          for (
            const query of [
              'timeout=0',
              'timeout=0&since=' + since,
              'timeout=0&full_state=true&since=' + since,
            ]
          ) {
            synced.push({
              kind: 'ordinary',
              response: authenticated('v3/sync?' + query),
            });
          }
          for (
            const [name, body] of Object.entries({
              timeline: {
                lists: {
                  all: {
                    ranges: [[0, 9]],
                    timeline_limit: 20,
                    required_state: [],
                  },
                },
              },
              list: {
                lists: {
                  all: {
                    ranges: [[0, 9]],
                    timeline_limit: 0,
                    required_state: [],
                  },
                },
              },
              encryption: { extensions: { e2ee: { enabled: true } } },
            })
          ) {
            synced.push({
              kind: name,
              response: authenticated(
                'unstable/org.matrix.simplified_msc3575/sync?timeout=0',
                { conn_id: name, ...body },
              ),
            });
          }
          const path = encodeURIComponent(room.id);
          const event = encodeURIComponent(accepted.event_id);
          synced.push(
            {
              kind: 'event',
              response: authenticated('v3/rooms/' + path + '/event/' + event),
            },
            {
              kind: 'relations',
              response: authenticated(
                'v1/rooms/' + path + '/relations/' + event,
              ),
            },
            {
              kind: 'search',
              response: authenticated('v3/search', {
                search_categories: {
                  room_events: { search_term: 'durable while held' },
                },
              }),
            },
            {
              kind: 'receipt',
              response: authenticated(
                'v3/rooms/' + path + '/receipt/m.read/' + event,
                {},
              ),
            },
          );
          jobs.push(...synced.map((s) => s.response));
          let staleSuccess = false;
          for (const s of synced) {
            void s.response.then(() => {
              staleSuccess = true;
            });
          }
          clearTimeout(timer);
          await Promise.race([
            captured.promise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      'sync or effect-dependent read did not enter causal capture',
                    ),
                  ),
                10000,
              );
            }),
          ]);
          assertEquals(
            staleSuccess,
            false,
            'sync bypassed its captured own publication barrier',
          );
          owner.wait = wait;
        }
        released = true;
        hold.release();
        await blocked;
        for (const sync of synced) {
          const response = await sync.response;
          assertEquals(response.status, 200);
          const value = await response.json();
          if (sync.kind === 'event') {
            assertEquals(value.event_id, accepted.event_id);
            assertEquals(value.content.body, 'durable while held');
            continue;
          }
          if (sync.kind === 'search') {
            assert(
              value.search_categories.room_events.results.some((
                r: { result: { event_id: string } },
              ) => r.result.event_id === accepted.event_id),
            );
            continue;
          }
          if (sync.kind === 'relations' || sync.kind === 'receipt') continue;
          if (sync.kind === 'list' || sync.kind === 'encryption') continue;
          const timeline = sync.kind === 'ordinary'
            ? value.rooms.join[room.id].timeline.events
            : value.rooms[room.id].timeline;
          const echoed = timeline.find((e: { event_id: string }) =>
            e.event_id === accepted.event_id
          );
          assert(echoed, 'own acknowledged ID absent from ' + sync.kind);
          assertEquals(echoed.content.body, 'durable while held');
          assertEquals(echoed.unsigned.transaction_id, 'owned-completion');
        }
      } finally {
        clearTimeout(timer);
        hold?.release();
        await Promise.allSettled(jobs);
        hold?.restore();
        await http.close();
      }
    },
  );
}
