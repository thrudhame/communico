import { assertEquals, assertRejects } from '@std/assert';
import { MatrixError } from '#engine/matrix-error.ts';
import { createRoom } from '#engine/room/create.ts';
import { setRestrictedKnowledge } from '#engine/room/hooks.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { join, leave } from '#engine/room/membership.ts';
import {
  joinedAllowedRoom,
  withRestrictedAdmission,
} from '#engine/room/restricted.ts';
import { openStore } from '#engine/store/index.ts';
import { testSigner } from './fixtures/signer.ts';

Deno.test('restricted vouch fences allowed scope at native commit but not later ordinary membership departure', async (t) => {
  const dir = await Deno.makeTempDir({ prefix: 'restricted-scope-fence-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  try {
    const signer = await testSigner();
    const creator = '@owner:test', user = '@guest:test';
    const allowed = await openRoom(
      store,
      (await createRoom(store, { creator, preset: 'public_chat' }, signer))
        .roomId,
    );
    await join(allowed, user, signer);
    const room = await openRoom(
      store,
      (await createRoom(store, {
        creator,
        initial_state: [{
          type: 'm.room.join_rules',
          state_key: '',
          content: {
            join_rule: 'restricted',
            allow: [{ type: 'm.room_membership', room_id: allowed.id }],
          },
        }],
      }, signer)).roomId,
    );
    const original = room.tx.bind(room);
    let scopeReady = true;
    const checkCurrent = () => {
      if (!scopeReady) {
        throw new MatrixError(503, 'M_UNAVAILABLE', 'allowed scope withdrawn');
      }
    };
    setRestrictedKnowledge(
      store,
      () => Promise.resolve({ knowledge: 'partial', checkCurrent }),
    );
    for (const change of ['scope', 'departure']) {
      await t.step(change, async () => {
        const entered = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        let applying: Promise<unknown> | undefined;
        let held = false;
        const operation = 'restricted-native-' + change;
        room.tx = (fn) =>
          original(async (tx) => {
            const result = await fn(tx);
            if (!held && await tx.membershipReceipts.has(operation)) {
              held = true;
              entered.resolve();
              await release.promise;
            }
            return result;
          });
        try {
          applying = withRestrictedAdmission(
            room,
            user,
            signer.serverName,
            async (tx, authorizer) => {
              assertEquals(authorizer, creator);
              return await tx.membershipReceipts.save(operation, 'same-input', {
                vouched: true,
              });
            },
          ).then(() => null, (error) => error);
          await Promise.race([
            entered.promise,
            applying.then((result) => {
              throw new Error(
                'settled before native barrier: ' + String(result),
              );
            }),
          ]);
          if (change === 'scope') scopeReady = false;
          else await leave(allowed, user, signer);
          release.resolve();
          const outcome = await applying;
          room.tx = original;
          const receipt = await room.tx((tx) =>
            tx.membershipReceipts.get(operation, 'same-input')
          );
          if (change === 'scope') {
            assertEquals(
              receipt,
              null,
              'withdrawn allowed scope must roll back the actual target write',
            );
            assertEquals(outcome instanceof MatrixError, true);
            scopeReady = true;
          } else {
            assertEquals(
              outcome,
              null,
              'ordinary departure follows the qualifying-read cut',
            );
            assertEquals(receipt, { vouched: true });
          }
        } finally {
          release.resolve();
          await applying;
          room.tx = original;
          scopeReady = true;
        }
      });
    }
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('restricted allowed-room knowledge distinguishes partial local absence from complete nonmembership', async (t) => {
  const dir = await Deno.makeTempDir({ prefix: 'restricted-knowledge-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  try {
    const signer = await testSigner();
    const creator = '@owner:test';
    const user = '@guest:test';
    const missing = '!not-held:test';
    const closedId = (await createRoom(store, { creator }, signer)).roomId;
    const closed = await openRoom(store, closedId);
    await leave(closed, creator, signer);
    const activeId = (await createRoom(store, {
      creator,
      preset: 'public_chat',
    }, signer)).roomId;
    const active = await openRoom(store, activeId);
    await join(active, user, signer);
    const restricted = async (allowed: string[]) => {
      const made = await createRoom(store, {
        creator,
        initial_state: [{
          type: 'm.room.join_rules',
          state_key: '',
          content: {
            join_rule: 'restricted',
            allow: allowed.map((room_id) => ({
              type: 'm.room_membership',
              room_id,
            })),
          },
        }],
      }, signer);
      return await openRoom(store, made.roomId);
    };
    const targets = await Promise.all(
      [missing, closedId, activeId].map((id) => restricted([id])),
    );
    let mutations = 0;
    const admit = (index: number) =>
      withRestrictedAdmission(
        targets[index],
        user,
        signer.serverName,
        (_tx, authorizer) => {
          mutations++;
          return authorizer;
        },
      );
    for (const index of [0, 1]) {
      await t.step(
        `complete local absence ${index} remains forbidden`,
        async () => {
          const error = await assertRejects(() => admit(index), MatrixError);
          assertEquals([error.status, error.errcode], [403, 'M_FORBIDDEN']);
        },
      );
    }
    setRestrictedKnowledge(store, () => Promise.resolve('partial'));
    for (const index of [0, 1]) {
      await t.step(`partial local absence ${index} is unknown`, async () => {
        const error = await assertRejects(() => admit(index), MatrixError);
        assertEquals([error.status, error.errcode], [
          400,
          'M_UNABLE_TO_AUTHORISE_JOIN',
        ]);
      });
    }
    await t.step(
      'required unavailable scope cannot vouch from retained positive state',
      async () => {
        setRestrictedKnowledge(store, () => Promise.resolve('unavailable'));
        const error = await assertRejects(() => admit(2), MatrixError);
        assertEquals([error.status, error.errcode], [
          400,
          'M_UNABLE_TO_AUTHORISE_JOIN',
        ]);
        assertEquals(await joinedAllowedRoom(store, user, [activeId]), false);
      },
    );
    assertEquals(mutations, 0);
    setRestrictedKnowledge(store, () => Promise.resolve('partial'));
    await t.step(
      'ready partial positive witness admits the local user',
      async () => {
        assertEquals(await admit(2), creator);
        assertEquals(mutations, 1);
      },
    );
    await t.step(
      'an unknown alternative does not mask a valid witness',
      async () => {
        const room = await restricted([missing, activeId]);
        assertEquals(
          await withRestrictedAdmission(
            room,
            user,
            signer.serverName,
            (_tx, authorizer) => authorizer,
          ),
          creator,
        );
      },
    );
    await t.step(
      'complete held state still proves nonmembership on a partial store',
      async () => {
        const error = await assertRejects(() =>
          withRestrictedAdmission(
            targets[2],
            '@absent:test',
            signer.serverName,
            () => mutations++,
          ), MatrixError);
        assertEquals([error.status, error.errcode], [403, 'M_FORBIDDEN']);
      },
    );
    await t.step(
      'readiness is rechecked before the locked mutation',
      async () => {
        let ready = true;
        setRestrictedKnowledge(
          store,
          () => Promise.resolve(ready ? 'partial' : 'unavailable'),
        );
        const before = mutations;
        const error = await assertRejects(() =>
          withRestrictedAdmission(
            targets[2],
            user,
            signer.serverName,
            () => mutations++,
            undefined,
            () => {
              ready = false;
              return Promise.resolve();
            },
          ), MatrixError);
        assertEquals([error.status, error.errcode], [
          400,
          'M_UNABLE_TO_AUTHORISE_JOIN',
        ]);
        assertEquals(mutations, before);
      },
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
