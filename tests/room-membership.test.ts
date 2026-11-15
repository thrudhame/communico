// tests/room-membership.test.ts — the old membership.test.ts's local
// paths (A1–A4): membership operations and the power-level rules through
// the rulebook at the engine level. Federation paths are 3c.
import { assertEquals, assertRejects } from '@std/assert';
import { MatrixError } from '#engine/matrix-error.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom, type Room, roomSchema } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import {
  ban,
  invite,
  join,
  joinResident,
  kick,
  leave,
  membershipOf,
  reopen,
  unban,
} from '#engine/room/membership.ts';
import type { Signer } from '#engine/room/signer.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { testSigner } from './fixtures/signer.ts';

const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

async function withStore(
  fn: (store: Store) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore(config(dir), {
    schemas: { room: roomSchema },
  });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function fixture(
  store: Store,
  opts: { preset?: string } = {},
): Promise<{ room: Room; signer: Signer; creator: string }> {
  const signer = await testSigner();
  const creator = '@dev:test';
  const res = await createRoom(store, { creator, ...opts }, signer);
  return { room: await openRoom(store, res.roomId), signer, creator };
}

async function pl(
  room: Room,
  signer: Signer,
  sender: string,
  content: Record<string, unknown>,
) {
  return await sendLocal(room, {
    type: 'm.room.power_levels',
    sender,
    state_key: '',
    content,
    origin_server_ts: Date.now(),
  }, signer);
}

for (const keepPeer of [false, true]) {
  Deno.test(`leave reconciliation keepPeer=${keepPeer} serializes its membership check and never authors a second departure after reopen`, async () => {
    const dir = await Deno.makeTempDir({ prefix: 'leave-reconciliation-' });
    let store = await openStore(config(dir), { schemas: { room: roomSchema } });
    try {
      const { room, signer, creator } = await fixture(store);
      if (keepPeer) {
        await invite(room, creator, '@bob:test', signer);
        await join(room, '@bob:test', signer);
      }
      const results = await Promise.all(
        Array.from({ length: 8 }, () => leave(room, creator, signer)),
      );
      assertEquals(results.filter((result) => result.created).length, 1);
      assertEquals(new Set(results.map((result) => result.eventId)).size, 1);
      const eventId = results[0].eventId;
      const roomId = room.id;
      await store.close();
      store = await openStore(config(dir), { schemas: { room: roomSchema } });
      const resumed = await openRoom(store, roomId);
      assertEquals(
        await leave(resumed, creator, {
          ...signer,
          sign: () =>
            Promise.reject(
              new Error('completed departure must not sign again'),
            ),
        }),
        { roomId, eventId, created: false },
      );
      assertEquals(await membershipOf(resumed, creator), {
        membership: 'leave',
        eventId,
      });
    } finally {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test('leave reconciliation preserves ordinary rejected-event evidence without changing membership', async () => {
  await withStore(async (store) => {
    const { room, signer, creator } = await fixture(store);
    await invite(room, creator, '@bob:test', signer);
    await join(room, '@bob:test', signer);
    await ban(room, creator, '@bob:test', signer);
    await assertRejects(
      () => leave(room, '@bob:test', signer),
      MatrixError,
      'membership rejected',
    );
    assertEquals((await membershipOf(room, '@bob:test'))?.membership, 'ban');
    assertEquals(
      await (await store.room(room.id)).query(
        "SELECT s.standing FROM events e JOIN event_status s ON s.event=e.id WHERE e.sender=? AND e.type='m.room.member' AND json_extract(e.pdu,'$.content.membership')='leave'",
        ['@bob:test'],
      ),
      [{ standing: 'rejected' }],
    );
  });
});

Deno.test('A1: PL 100 via users may lower users_default 100→40', async () => {
  await withStore(async (store) => {
    const { room, signer, creator } = await fixture(store);
    // both dev and bob at 100 via users, users_default 100
    const first = await pl(room, signer, creator, {
      users: { [creator]: 100, '@bob:test': 100 },
      users_default: 100,
      events: {},
      notifications: {},
    });
    assertEquals(first.standing, 'accepted');
    await invite(room, creator, '@bob:test', signer);
    await join(room, '@bob:test', signer);

    // bob (100 via users) lowers users_default 100→40 — allowed (the
    // gomatrixserverlib#306 regression: sender's level == old users_default)
    const lowered = await pl(room, signer, '@bob:test', {
      users: { [creator]: 100, '@bob:test': 100 },
      users_default: 40,
      events: {},
      notifications: {},
    });
    assertEquals(lowered.standing, 'accepted');
  });
});

Deno.test('A1b: PL {} self-demotion allowed; PL {users:{}} then rejected (rule 9.x)', async () => {
  await withStore(async (store) => {
    const { room, signer, creator } = await fixture(store);
    // {users:{dev:100}} -> {} is a self-demotion and must pass; after it
    // dev holds 0, so the next state event is a state-reject
    const first = await pl(room, signer, creator, {
      users: { [creator]: 100 },
    });
    assertEquals(first.standing, 'accepted');
    const demote = await pl(room, signer, creator, {});
    assertEquals(demote.standing, 'accepted');
    const rejected = await pl(room, signer, creator, { users: {} });
    assertEquals(rejected.standing, 'rejected');
    assertEquals(rejected.reason, 'auth');
  });
});

Deno.test('A2: a never-joined user with PL 100 cannot ban (rule 5)', async () => {
  await withStore(async (store) => {
    const { room, signer, creator } = await fixture(store);
    await invite(room, creator, '@bob:test', signer);
    await join(room, '@bob:test', signer);

    // charlie gets 100 via users but never joins the room
    const grant = await pl(room, signer, creator, {
      users: { [creator]: 100, '@charlie:test': 100 },
    });
    assertEquals(grant.standing, 'accepted');

    const err = await assertRejects(() =>
      ban(room, '@charlie:test', '@bob:test', signer, 'testing')
    );
    assertEquals(err instanceof MatrixError, true);
    assertEquals((err as MatrixError).status, 403);
    assertEquals((err as MatrixError).errcode, 'M_FORBIDDEN');
  });
});

Deno.test('A3: kick never-present → 403; kick left → 403 (rule 4.5.5)', async () => {
  await withStore(async (store) => {
    const { room, signer, creator } = await fixture(store);

    const never = await assertRejects(() =>
      kick(room, creator, '@bob:test', signer, 'testing')
    );
    assertEquals((never as MatrixError).status, 403);
    assertEquals((never as MatrixError).errcode, 'M_FORBIDDEN');

    await invite(room, creator, '@bob:test', signer);
    await join(room, '@bob:test', signer);
    await leave(room, '@bob:test', signer);

    const left = await assertRejects(() =>
      kick(room, creator, '@bob:test', signer, 'testing')
    );
    assertEquals((left as MatrixError).status, 403);
    assertEquals((left as MatrixError).errcode, 'M_FORBIDDEN');
  });
});

Deno.test('A4: unban is the leave-from-ban — banned target unbanned, then invite + join work; not-banned → 400', async () => {
  await withStore(async (store) => {
    const { room, signer, creator } = await fixture(store, {
      preset: 'public_chat',
    });
    await join(room, '@bob:test', signer);
    await ban(room, creator, '@bob:test', signer, 'out');
    assertEquals(
      (await membershipOf(room, '@bob:test'))?.membership,
      'ban',
    );
    // not-banned → 400 M_BAD_STATE
    const err = await assertRejects(() =>
      unban(room, creator, creator, signer)
    );
    assertEquals((err as MatrixError).status, 400);
    assertEquals((err as MatrixError).errcode, 'M_BAD_STATE');
    // the unban: a leave from ban
    await unban(room, creator, '@bob:test', signer, 'back');
    assertEquals(
      (await membershipOf(room, '@bob:test'))?.membership,
      'leave',
    );
    // invite + join work again (the TestUnbanViaInvite flow)
    await invite(room, creator, '@bob:test', signer);
    assertEquals(
      (await membershipOf(room, '@bob:test'))?.membership,
      'invite',
    );
    await join(room, '@bob:test', signer);
    assertEquals(
      (await membershipOf(room, '@bob:test'))?.membership,
      'join',
    );
  });
});

Deno.test('membership: an idempotent re-join returns the existing event', async () => {
  await withStore(async (store) => {
    const { room, signer, creator } = await fixture(store, {
      preset: 'public_chat',
    });
    const first = await join(room, '@bob:test', signer);
    assertEquals(first.created, true);
    const again = await join(room, '@bob:test', signer);
    assertEquals(again.created, false);
    assertEquals(again.eventId, first.eventId);
    // the creator's own re-join is idempotent too
    const own = await join(room, creator, signer);
    assertEquals(own.created, false);
  });
});

Deno.test('membership: concurrent joins share one admitted membership event', async () => {
  await withStore(async (store) => {
    const { room, signer } = await fixture(store, { preset: 'public_chat' });
    const results = await Promise.all([
      join(room, '@bob:test', signer),
      join(room, '@bob:test', signer),
    ]);
    assertEquals(results.filter((result) => result.created).length, 1);
    assertEquals(new Set(results.map((result) => result.eventId)).size, 1);
  });
});

Deno.test('membership: resident admission observes a last-local departure after capture without authoring or leaking a routing 404', async () => {
  await withStore(async (store) => {
    const { room, signer, creator } = await fixture(store, {
      preset: 'public_chat',
    });
    const original = room.tx;
    let armed = true;
    room.tx = async (fn) => {
      const result = await original(fn);
      if (
        armed && result !== null && typeof result === 'object' &&
        'required' in result
      ) {
        armed = false;
        await leave(room, creator, signer);
      }
      return result;
    };
    try {
      assertEquals(await joinResident(room, '@bob:test', signer), null);
      assertEquals(armed, false, 'departure occurred after admission capture');
      assertEquals(await membershipOf(room, '@bob:test'), null);
      assertEquals((await reopen(room, '@bob:test', signer, {})).created, true);
    } finally {
      room.tx = original;
    }
  });
});

Deno.test('membership: archived reopen admits a concurrent winner without a second stay or join', async () => {
  await withStore(async (store) => {
    const { room, signer, creator } = await fixture(store, {
      preset: 'public_chat',
    });
    await leave(room, creator, signer);
    const results = await Promise.all([
      reopen(room, '@bob:test', signer, {}),
      reopen(room, '@bob:test', signer, {}),
      reopen(room, '@carol:test', signer, {}),
    ]);
    assertEquals(results.filter((result) => result.created).length, 2);
    assertEquals(results[0].eventId, results[1].eventId);
    assertEquals((await membershipOf(room, '@carol:test'))?.membership, 'join');
    assertEquals(
      (await room.tx((tx) => tx.segments.list())).filter((s) =>
        s.kind === 'stay'
      )
        .length,
      2,
    );
  });
});
