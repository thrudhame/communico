// Authored origins belong to finalization, never to received-event ingest.
import { assert, assertEquals } from '@std/assert';
import { canonicalJson } from '#engine/canonical.ts';
import { redact } from '#engine/eventid.ts';
import { serveEvent } from '#engine/federation/serve.ts';
import type { Pdu } from '#engine/pdu.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { invite, join, leave, reopen } from '#engine/room/membership.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { assertAuthored } from './fixtures/authored.ts';
import { genesis } from './fixtures/genesis.ts';
import { authAt } from './fixtures/auth.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
  wireOf,
} from './fixtures/remote.ts';
import { testSigner } from './fixtures/signer.ts';

installServerHooks();

async function withStore(fn: (store: Store) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema, server: serverSchema } });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

for (const version of ['10', '11', '12']) {
  Deno.test(`origin: v${version} creation, sends, membership and reopen are signed with our origin`, async () => {
    await withStore(async (store) => {
      const signer = await testSigner('author.test');
      const creator = '@dev:author.test';
      const created = await createRoom(store, {
        creator,
        version,
        preset: 'public_chat',
      }, signer);
      const room = await openRoom(store, created.roomId);
      const sent = await sendLocal(room, {
        type: 'm.room.message',
        sender: creator,
        content: { msgtype: 'm.text', body: 'authored locally' },
      }, signer);
      assertEquals(sent.standing, 'accepted');
      await invite(room, creator, '@bob:author.test', signer);
      await join(room, '@bob:author.test', signer);
      await leave(room, '@bob:author.test', signer);
      await leave(room, creator, signer);
      await reopen(room, creator, signer, {});
      await room.tx(async (tx) => {
        const events = (await tx.changes.after(0, 1000)).filter((c) =>
          c.kind === 'event'
        );
        assert(events.length >= 11);
        for (const entry of events) {
          const row = await tx.events.get(entry.event!);
          assert(row !== null);
          const pdu = JSON.parse(row.pdu) as Pdu;
          await assertAuthored(pdu, version, signer.serverName);
          const redacted = redact(
            pdu as unknown as Record<string, unknown>,
            version,
          );
          assertEquals('origin' in redacted, version === '10');
          if (version === '10') {
            assertEquals(redacted.origin, signer.serverName);
          }
        }
      });
    });
  });
}

Deno.test('origin: a locally authored knock carries a verifiable origin', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, {
      roomId: '!knock:test',
      joinRule: 'knock',
    });
    const result = await sendLocal(g.room, {
      type: 'm.room.member',
      sender: '@knocker:test',
      state_key: '@knocker:test',
      content: { membership: 'knock' },
    }, g.signer);
    assertEquals(result.standing, 'accepted');
    await g.room.tx(async (tx) => {
      const row = await tx.events.get(result.eventId);
      assert(row !== null);
      await assertAuthored(JSON.parse(row.pdu) as Pdu);
    });
  });
});

Deno.test('origin: a received event without origin is stored and served unchanged', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, {
      roomId: '!received:test',
      joinRule: 'public',
    });
    const remote = await makeRemoteServer('remote.test');
    const keys = fakeKeyResolver(remote);
    const deps = {
      keys,
      fetcher: fakeFetcher({}).fetcher,
      self: 'test',
      limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
      ungroundedMs: 3_600_000,
    };
    const received = await remoteEvent(g.roomId, remote, '11', {
      type: 'm.room.member',
      sender: '@rudy:remote.test',
      state_key: '@rudy:remote.test',
      content: { membership: 'join' },
      prev_events: [g.tipId],
      auth_events: await authAt(g.room, {
        type: 'm.room.member',
        sender: '@rudy:remote.test',
        state_key: '@rudy:remote.test',
        content: { membership: 'join' },
      }, g.tipId),
    });
    const expected = canonicalJson(received);
    assertEquals('origin' in received, false);
    const [result] = await ingestRemote(g.room, [received], remote.name, deps);
    assertEquals(result.outcome, 'accepted');
    await g.room.tx(async (tx) => {
      const row = await tx.events.get(received.event_id!);
      assertEquals(row?.pdu, expected);
    });
    const response = await serveEvent(received.event_id!, remote.name, {
      store,
      server: await store.server(),
      self: 'test',
    });
    assertEquals(response.pdus, [
      wireOf(received) as unknown as Record<string, unknown>,
    ]);
    assertEquals(canonicalJson(received), expected);
  });
});
