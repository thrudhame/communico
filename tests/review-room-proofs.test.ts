import { assertEquals } from '@std/assert';
import { createRoom } from '#engine/room/create.ts';
import { loadRulebookStore } from '#engine/room/build.ts';
import { backfill } from '#engine/room/history.ts';
import { openRoom, type Room, roomSchema } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { joinRemote } from '#engine/room/join.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import { iterativeAuthChecks } from '#engine/rulebook/state-res-v2.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
  signJson,
} from '#engine/signing-primitives.js';
import { openStore, type Store } from '#engine/store/index.ts';
import { fakeFetcher, fakeKeyResolver } from './fixtures/remote.ts';
import { makeFakeRoom } from './fixtures/remote-room.ts';
import { testRemoteServer, testSigner } from './fixtures/signer.ts';

async function withStore(fn: (store: Store) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function invitation(user: string) {
  const pair = await generateSigningKeypair() as CryptoKeyPair;
  const key = b64encodeStd(await exportPublicKeyRaw(pair.publicKey));
  const signed = await signJson(
    { mxid: user, token: 'token' },
    'service',
    'ed25519:test',
    pair.privateKey,
  );
  return {
    key,
    content: { membership: 'invite', third_party_invite: { signed } },
  };
}

async function current(room: Room) {
  return await room.tx(async (tx) => {
    const stay = (await tx.segments.openStay())!;
    return await tx.state.groupMap((await tx.state.current(stay.id))!);
  });
}

Deno.test('review proofs: local ingest and fork resolution consume genuine event-bound proofs', async () => {
  await withStore(async (store) => {
    const signer = await testSigner();
    const creator = '@dev:test';
    const { roomId } = await createRoom(store, { creator }, signer);
    const room = await openRoom(store, roomId);
    const invite = await invitation('@bob:test');
    const key = await sendLocal(room, {
      type: 'm.room.third_party_invite',
      sender: creator,
      state_key: 'token',
      content: { public_keys: [{ public_key: invite.key }] },
    }, signer);
    const accepted = await sendLocal(room, {
      type: 'm.room.member',
      sender: creator,
      state_key: '@bob:test',
      content: invite.content,
    }, signer);
    assertEquals(accepted.standing, 'accepted');
    const fork = await sendLocal(room, {
      type: 'm.room.message',
      sender: creator,
      prev_events: [key.eventId],
      content: { msgtype: 'm.text', body: 'other fork' },
    }, signer);
    assertEquals(fork.standing, 'accepted');
    const merged = await sendLocal(room, {
      type: 'm.room.message',
      sender: creator,
      content: { msgtype: 'm.text', body: 'heal' },
    }, signer);
    assertEquals(merged.standing, 'accepted');
    assertEquals(
      (await current(room)).get('m.room.member\0@bob:test'),
      accepted.eventId,
    );

    // The resolver must evaluate a candidate against the exact key event,
    // including alternatives supplied by a different branch's state.
    const replacement = await sendLocal(room, {
      type: 'm.room.third_party_invite',
      sender: creator,
      state_key: 'token',
      content: { public_key: (await invitation('@unused:test')).key },
    }, signer);
    await room.tx(async (tx) => {
      const state = await tx.state.groupMap(
        (await tx.state.eventStateBefore(accepted.eventId))!.group,
      );
      state.set('m.room.third_party_invite\0token', replacement.eventId);
      state.delete('m.room.member\0@bob:test');
      const loaded = await loadRulebookStore(tx, [
        ...state.values(),
        accepted.eventId,
      ]);
      const resolved = iterativeAuthChecks(
        state,
        [accepted.eventId],
        loaded,
        getRulebook('11').spec,
      );
      assertEquals(resolved.has('m.room.member\0@bob:test'), false);
    });
    const wrongKey = await sendLocal(room, {
      type: 'm.room.member',
      sender: creator,
      state_key: '@bob:test',
      content: invite.content,
    }, signer);
    assertEquals(wrongKey.standing, 'rejected');

    const forged = await invitation('@carol:test');
    await sendLocal(room, {
      type: 'm.room.third_party_invite',
      sender: creator,
      state_key: 'token',
      content: { public_key: forged.key },
    }, signer);
    forged.content.third_party_invite.signed.signatures
      .service['ed25519:test'] = forged.key;
    const rejected = await sendLocal(room, {
      type: 'm.room.member',
      sender: creator,
      state_key: '@carol:test',
      content: forged.content,
    }, signer);
    assertEquals(rejected.standing, 'rejected');
  });
});

for (const mode of ['valid', 'forged', 'wrong-key'] as const) {
  Deno.test(`review proofs: join snapshot ${mode} invitation reaches the stored consumer`, async () => {
    await withStore(async (store) => {
      const fr = await makeFakeRoom({
        roomId: `!proof-join-${mode}:remote.test`,
      });
      const invite = await invitation('@bob:remote.test');
      await fr.addEvent({
        type: 'm.room.third_party_invite',
        state_key: 'token',
        content: {
          public_key: mode === 'wrong-key'
            ? (await invitation('@x:test')).key
            : invite.key,
        },
      });
      if (mode === 'forged') {
        invite.content.third_party_invite.signed.signatures
          .service['ed25519:test'] = invite.key;
      }
      const member = await fr.addEvent({
        type: 'm.room.member',
        state_key: '@bob:remote.test',
        content: invite.content,
      });
      const { fetcher } = fakeFetcher({
        makeJoin: (user) => fr.makeJoinAnswer(user),
        sendJoin: (event) => fr.acceptSendJoin(event),
      });
      const signer = await testSigner();
      const keys = fakeKeyResolver(fr.server, await testRemoteServer());
      const join = () =>
        joinRemote(store, {
          roomId: fr.roomId,
          user: '@anna:test',
          via: [fr.server.name],
          signer,
          deps: { self: 'test', keys, fetcher },
        });
      if (mode !== 'valid') {
        // This layer filters rejected snapshot state rather than refusing
        // the whole response. The rejected invitation must not be imported.
        const result = await join();
        const room = await openRoom(store, fr.roomId);
        assertEquals(
          (await current(room)).has('m.room.member\0@bob:remote.test'),
          false,
        );
        assertEquals(
          (await current(room)).get('m.room.member\0@anna:test'),
          result.eventId,
        );
        assertEquals(
          (await room.tx((tx) => tx.events.getStatus(member.event_id!)))
            ?.standing,
          'rejected',
        );
        return;
      }
      const result = await join();
      const room = await openRoom(store, fr.roomId);
      assertEquals(
        (await current(room)).get('m.room.member\0@bob:remote.test'),
        member.event_id,
      );
      assertEquals(
        (await current(room)).get('m.room.member\0@anna:test'),
        result.eventId,
      );
      const status = await room.tx((tx) =>
        tx.events.getStatus(member.event_id!)
      );
      assertEquals(status?.standing, 'accepted');
      assertEquals(status?.grounding, 'evidence');
    });
  });
}

for (
  const route of [
    'remote-evidence',
    'history-page',
    'history-evidence',
  ] as const
) {
  for (const valid of [true, false]) {
    Deno.test(`review proofs: ${route} ${valid ? 'valid' : 'forged'} prepares held and fetched invitation keys`, async () => {
      await withStore(async (store) => {
        const fr = await makeFakeRoom({
          roomId: `!proof-${route}:remote.test`,
        });
        const keys = fakeKeyResolver(fr.server, await testRemoteServer());
        const initial = fakeFetcher({
          makeJoin: (user) => fr.makeJoinAnswer(user),
          sendJoin: (event) => fr.acceptSendJoin(event),
        });
        await joinRemote(store, {
          roomId: fr.roomId,
          user: '@anna:test',
          via: [fr.server.name],
          signer: await testSigner(),
          deps: { self: 'test', keys, fetcher: initial.fetcher },
        });
        const room = await openRoom(store, fr.roomId);
        const invite = await invitation('@bob:remote.test');
        if (!valid) {
          invite.content.third_party_invite.signed.signatures
            .service['ed25519:test'] = invite.key;
        }
        const key = await fr.addEvent({
          type: 'm.room.third_party_invite',
          state_key: 'token',
          content: { public_key: invite.key },
        });
        const member = await fr.addEvent({
          type: 'm.room.member',
          state_key: '@bob:remote.test',
          content: invite.content,
        });
        const tip = await fr.addEvent({
          type: 'm.room.message',
          content: { body: 'gap tip' },
        });
        const child = await fr.addEvent({
          type: 'm.room.message',
          content: { body: 'pushed child' },
        });
        const ids = fr.stateIdsAt(tip.event_id!)!;
        const scripted = fakeFetcher({
          stateIds: new Map([[tip.event_id!, ids]]),
          event: fr.events,
          backfill: route === 'history-page' ? [tip, member, key] : [tip],
        });
        if (route === 'remote-evidence') {
          const outcome = await ingestRemote(room, [child], fr.server.name, {
            self: 'test',
            keys,
            fetcher: scripted.fetcher,
            limits: { waitMs: 0, budgetMs: 10000, limit: 100 },
            ungroundedMs: 0,
          });
          assertEquals(outcome[0].outcome, valid ? 'accepted' : 'dropped');
        } else {
          const result = await backfill(room, {
            from: [tip.event_id!],
            via: fr.server.name,
            limit: 100,
          }, { keys, fetcher: scripted.fetcher });
          assertEquals(
            result.positioned.includes(tip.event_id!),
            valid || route === 'history-page',
          );
        }
        const status = await room.tx((tx) =>
          tx.events.getStatus(member.event_id!)
        );
        assertEquals(status?.standing, valid ? 'accepted' : 'rejected');
        assertEquals(
          status?.grounding,
          route === 'history-page' ? 'grounded' : 'evidence',
        );
        if (route === 'history-page') {
          assertEquals(
            (await room.tx((tx) =>
              tx.segments.positionOf(member.event_id!)
            )) !== null,
            valid,
          );
        }
        const refs = await room.tx((tx) =>
          tx.state.eventStateAfter(tip.event_id!)
        );
        if (!valid && route !== 'history-page') assertEquals(refs, null);
        if (refs !== null) {
          const after = await room.tx((tx) => tx.state.groupMap(refs.group));
          assertEquals(after.has('m.room.member\0@bob:remote.test'), valid);
        }
      });
    });
  }
}

for (const route of ['remote', 'history'] as const) {
  Deno.test(`review auth: ${route} evidence dependencies precede hostile depth and cannot enter boundaries`, async () => {
    await withStore(async (store) => {
      const fr = await makeFakeRoom({
        roomId: `!auth-order-${route}:remote.test`,
      });
      const keys = fakeKeyResolver(fr.server, await testRemoteServer());
      const initial = fakeFetcher({
        makeJoin: (user) => fr.makeJoinAnswer(user),
        sendJoin: (event) => fr.acceptSendJoin(event),
      });
      await joinRemote(store, {
        roomId: fr.roomId,
        user: '@anna:test',
        via: [fr.server.name],
        signer: await testSigner(),
        deps: { self: 'test', keys, fetcher: initial.fetcher },
      });
      const room = await openRoom(store, fr.roomId);
      const bad = await fr.addEvent({
        type: 'm.room.power_levels',
        state_key: '',
        depth: 9999,
        content: { users: { [fr.creator]: 100, '@bob:remote.test': 101 } },
      });
      const dependent = await fr.addEvent({
        type: 'm.room.topic',
        state_key: '',
        depth: 1,
        content: { topic: 'must reject' },
      });
      const tip = await fr.addEvent({
        type: 'm.room.message',
        content: { body: 'tip' },
      });
      const child = await fr.addEvent({
        type: 'm.room.message',
        content: { body: 'child' },
      });
      const ids = fr.stateIdsAt(tip.event_id!)!;
      // Insert dependents before their auth parent to reproduce the original
      // same-pass bug independently of /state_ids' lexicographic id order.
      ids.pduIds = [
        dependent.event_id!,
        bad.event_id!,
        ...ids.pduIds.filter((id) =>
          id !== dependent.event_id && id !== bad.event_id
        ),
      ];
      const scripted = fakeFetcher({
        stateIds: new Map([[tip.event_id!, ids]]),
        event: fr.events,
        backfill: [tip],
      });
      if (route === 'remote') {
        const result = await ingestRemote(room, [child], fr.server.name, {
          self: 'test',
          keys,
          fetcher: scripted.fetcher,
          limits: { waitMs: 0, budgetMs: 10000, limit: 100 },
          ungroundedMs: 0,
        });
        assertEquals(result[0].outcome, 'dropped');
      } else {
        const result = await backfill(room, {
          from: [tip.event_id!],
          via: fr.server.name,
          limit: 100,
        }, { keys, fetcher: scripted.fetcher });
        assertEquals(result.positioned, []);
      }
      for (const event of [bad, dependent, tip]) {
        const status = await room.tx((tx) =>
          tx.events.getStatus(event.event_id!)
        );
        assertEquals(status?.standing, 'rejected');
        assertEquals(status?.grounding, 'evidence');
        assertEquals(
          await room.tx((tx) => tx.state.eventStateAfter(event.event_id!)),
          null,
        );
      }
      assertEquals((await current(room)).has('m.room.topic\0'), false);
    });
  });
}
