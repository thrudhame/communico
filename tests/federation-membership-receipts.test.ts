import { assert, assertEquals, assertRejects } from '@std/assert';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  makeJoin,
  makeKnock,
  makeLeave,
  sendJoin,
  sendKnock,
  sendLeave,
} from '#engine/federation/joins.ts';
import type { InviteDeps } from '#engine/federation/invites.ts';
import { toWire } from '#engine/federation/pdu.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { ingestInTx, sendLocal } from '#engine/room/ingest.ts';
import { verify } from '#engine/room/verify.ts';
import { config } from '#engine/config.ts';
import { openStore } from '#engine/store/index.ts';
import type { Conn } from '#engine/store/db.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { setRoomHooks } from '#engine/room/hooks.ts';
import { project } from '#engine/server/project.ts';
import { registerRoom } from '#engine/server/registry.ts';
import { fakeKeyResolver, makeRemoteServer } from './fixtures/remote.ts';
import { signerFor, signTemplate } from './http-federation.ts';

const self = 'logical.test';
const creator = '@alice:' + self;
const guest = '@zoe:remote.test';

async function fixture(knock = false) {
  const dir = await Deno.makeTempDir({ prefix: 'membership-receipt-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const schemas = { room: roomSchema, server: serverSchema };
  let store = await openStore(options, { schemas });
  const local = await makeRemoteServer(self);
  const remote = await makeRemoteServer('remote.test');
  const rawSigner = signerFor(local);
  let signatures = 0;
  let expired = false;
  const signer = {
    ...rawSigner,
    sign: (bytes: string) => {
      signatures++;
      if (expired) {
        throw new MatrixError(
          503,
          'M_UNAVAILABLE',
          'signing authority expired',
        );
      }
      return rawSigner.sign(bytes);
    },
  };
  const { roomId } = await createRoom(store, {
    creator,
    preset: 'public_chat',
    version: '11',
    ...(knock
      ? {
        initial_state: [{
          type: 'm.room.join_rules',
          state_key: '',
          content: { join_rule: 'knock' },
        }],
      }
      : {}),
  }, signer);
  const deps = async (): Promise<InviteDeps> => ({
    store,
    server: await store.server(),
    signer,
    keys: fakeKeyResolver(local, remote),
    self,
    wake() {},
  });
  const room = () => openRoom(store, roomId);
  const topic = async (text: string) => {
    const held = await room();
    const result = await sendLocal(held, {
      type: 'm.room.topic',
      state_key: '',
      sender: creator,
      content: { topic: text },
      origin_server_ts: Date.now(),
    }, signer);
    assertEquals(result.standing, 'accepted');
  };
  const changes = async () => (await room()).tx((tx) => tx.changes.head());
  return {
    roomId,
    remote,
    deps,
    room,
    topic,
    changes,
    store: () => store,
    signatures: () => signatures,
    expire() {
      expired = true;
    },
    async reopen() {
      await store.close();
      store = await openStore(options, { schemas });
    },
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('resident membership templates refuse incomplete replica scope before reading room state', async () => {
  const f = await fixture(true);
  try {
    const deps = {
      ...await f.deps(),
      prepareRoomScope: () =>
        Promise.reject(
          new MatrixError(503, 'M_UNAVAILABLE', 'test scope unavailable'),
        ),
    };
    const head = await f.changes();
    const signatures = f.signatures();
    for (const make of [makeJoin, makeKnock, makeLeave]) {
      const error = await assertRejects(
        () => make(f.roomId, guest, f.remote.name, ['11'], deps),
        MatrixError,
      );
      assertEquals(error.status, 503);
    }
    assertEquals(await f.changes(), head);
    assertEquals(f.signatures(), signatures);
  } finally {
    await f.close();
  }
});

Deno.test('resident membership rechecks prepared scope after network verification without blocking completed replay', async () => {
  const f = await fixture();
  try {
    const original = await f.deps();
    const made = await makeJoin(
      f.roomId,
      guest,
      f.remote.name,
      ['11'],
      original,
    );
    const join = await signTemplate(made.event, f.remote);
    const wire = toWire(join, '11');
    let current = true, invalidate = true, durableChecks = 0, preparations = 0;
    const checkCurrent = () => {
      if (!current) {
        throw new MatrixError(503, 'M_UNAVAILABLE', 'test scope changed');
      }
    };
    const deps = {
      ...original,
      prepareRoomScope: (roomId: string) => {
        assertEquals(roomId, f.roomId);
        preparations++;
        checkCurrent();
        return Promise.resolve({
          checkCurrent,
          check: async (conn: Conn) => {
            // The durable check belongs to the server file, never a room callback.
            const rows = await conn.query(
              "SELECT name FROM sqlite_schema WHERE name='membership_operations'",
            );
            assertEquals(rows.length, 1);
            durableChecks++;
            checkCurrent();
          },
        });
      },
      keys: {
        verifyEventSignature: async (
          args: Parameters<typeof original.keys.verifyEventSignature>[0],
        ) => {
          const answer = await original.keys.verifyEventSignature(args);
          if (invalidate && preparations > 0) current = false;
          return answer;
        },
      },
    };
    const head = await f.changes();
    const error = await assertRejects(
      () =>
        sendJoin(
          f.roomId,
          String(join.event_id),
          wire,
          f.remote.name,
          'v2',
          deps,
        ),
      MatrixError,
    );
    assertEquals(error.status, 503);
    assertEquals(
      await f.changes(),
      head,
      'an invalidated cut cannot publish a join',
    );
    assertEquals(
      await (await f.room()).tx((tx) =>
        tx.membershipReceipts.has(
          JSON.stringify([f.remote.name, 'join', join.event_id]),
        )
      ),
      false,
    );
    current = true;
    invalidate = false;
    const first = await sendJoin(
      f.roomId,
      String(join.event_id),
      wire,
      f.remote.name,
      'v2',
      deps,
    );
    assert(
      durableChecks > 0,
      'new mutation rechecks durable scope on the server connection',
    );
    const completedHead = await f.changes();
    const prepared = preparations;
    current = false;
    f.expire();
    assertEquals(
      await sendJoin(
        f.roomId,
        String(join.event_id),
        wire,
        f.remote.name,
        'v2',
        deps,
      ),
      first,
    );
    assertEquals(
      preparations,
      prepared,
      'exact authenticated completion needs no new scope admission',
    );
    assertEquals(await f.changes(), completedHead);
  } finally {
    await f.close();
  }
});

Deno.test('review join: resident membership cannot commit its event or receipt after native-boundary scope invalidation', async () => {
  const f = await fixture();
  const store = f.store();
  const originalRoom = store.room.bind(store);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let applying: Promise<unknown> | undefined;
  try {
    const original = await f.deps();
    const made = await makeJoin(
      f.roomId,
      guest,
      f.remote.name,
      ['11'],
      original,
    );
    const join = await signTemplate(made.event, f.remote);
    const operation = JSON.stringify([f.remote.name, 'join', join.event_id]);
    const db = await originalRoom(f.roomId);
    const originalTx = db.tx.bind(db);
    let wrapped = false;
    store.room = async (id, options) => {
      const held = await originalRoom(id, options);
      if (id === f.roomId && !wrapped) {
        wrapped = true;
        held.tx = (fn, txOptions) =>
          originalTx(async (conn) => {
            const before = await conn.query(
              'SELECT 1 FROM membership_receipts WHERE operation=?',
              [operation],
            );
            const result = await fn(conn);
            const after = await conn.query(
              'SELECT 1 FROM membership_receipts WHERE operation=?',
              [operation],
            );
            if (!before.length && after.length) {
              entered.resolve();
              await release.promise;
            }
            return result;
          }, txOptions);
      }
      return held;
    };
    let current = true;
    const checkCurrent = () => {
      if (!current) {
        throw new MatrixError(
          503,
          'M_UNAVAILABLE',
          'test scope changed at native commit',
        );
      }
    };
    const deps = {
      ...original,
      prepareRoomScope: () =>
        Promise.resolve({
          checkCurrent,
          check: (conn: Conn) => {
            conn.admit(checkCurrent);
            checkCurrent();
            return Promise.resolve();
          },
        }),
    };
    applying = sendJoin(
      f.roomId,
      String(join.event_id),
      toWire(join, '11'),
      f.remote.name,
      'v2',
      deps,
    ).then(() => null, (error) => error);
    await Promise.race([
      entered.promise,
      applying.then((result) => {
        throw new Error(
          'membership settled before native barrier: ' + String(result),
        );
      }),
    ]);
    current = false;
    release.resolve();
    const outcome = await applying;
    store.room = originalRoom;
    db.tx = originalTx;
    assertEquals(
      await (await f.room()).tx((tx) => tx.events.get(String(join.event_id))),
      null,
    );
    assertEquals(
      await db.query('SELECT 1 FROM membership_receipts WHERE operation=?', [
        operation,
      ]),
      [],
    );
    assert(outcome instanceof MatrixError);
    assertEquals(outcome.status, 503);
  } finally {
    release.resolve();
    await applying;
    store.room = originalRoom;
    await f.close();
  }
});

Deno.test('resident knock and leave new work requires scope while exact results survive its loss', async () => {
  const f = await fixture(true);
  try {
    const original = await f.deps();
    let unavailable = true;
    const checkCurrent = () => {
      if (unavailable) {
        throw new MatrixError(503, 'M_UNAVAILABLE', 'test scope unavailable');
      }
    };
    const deps = {
      ...original,
      prepareRoomScope: () => {
        checkCurrent();
        return Promise.resolve({
          checkCurrent,
          check: () => Promise.resolve(checkCurrent()),
        });
      },
    };
    const knocked = await makeKnock(
      f.roomId,
      guest,
      f.remote.name,
      ['11'],
      original,
    );
    const knock = await signTemplate(knocked.event, f.remote);
    const knockWire = toWire(knock, '11');
    const head = await f.changes();
    const deniedKnock = await assertRejects(
      () =>
        sendKnock(
          f.roomId,
          String(knock.event_id),
          knockWire,
          f.remote.name,
          deps,
        ),
      MatrixError,
    );
    assertEquals(deniedKnock.status, 503);
    assertEquals(await f.changes(), head);
    unavailable = false;
    const result = await sendKnock(
      f.roomId,
      String(knock.event_id),
      knockWire,
      f.remote.name,
      deps,
    );
    unavailable = true;
    assertEquals(
      await sendKnock(
        f.roomId,
        String(knock.event_id),
        knockWire,
        f.remote.name,
        deps,
      ),
      result,
    );
    const leaving = await makeLeave(
      f.roomId,
      guest,
      f.remote.name,
      ['11'],
      original,
    );
    const leave = await signTemplate(leaving.event, f.remote);
    const leaveWire = toWire(leave, '11');
    const knockedHead = await f.changes();
    const deniedLeave = await assertRejects(
      () =>
        sendLeave(
          f.roomId,
          String(leave.event_id),
          leaveWire,
          f.remote.name,
          'v2',
          deps,
        ),
      MatrixError,
    );
    assertEquals(deniedLeave.status, 503);
    assertEquals(await f.changes(), knockedHead);
    unavailable = false;
    assertEquals(
      await sendLeave(
        f.roomId,
        String(leave.event_id),
        leaveWire,
        f.remote.name,
        'v1',
        deps,
      ),
      [200, {}],
    );
    unavailable = true;
    const completedHead = await f.changes();
    const signatures = f.signatures();
    f.expire();
    assertEquals(
      await sendLeave(
        f.roomId,
        String(leave.event_id),
        leaveWire,
        f.remote.name,
        'v2',
        deps,
      ),
      {},
    );
    assertEquals(f.signatures(), signatures);
    assertEquals(await f.changes(), completedHead);
  } finally {
    await f.close();
  }
});

Deno.test('resident new work cannot classify incomplete room evidence as a malformed event', async () => {
  const f = await fixture();
  try {
    const deps = {
      ...await f.deps(),
      prepareRoomScope: () =>
        Promise.reject(
          new MatrixError(503, 'M_UNAVAILABLE', 'test scope unavailable'),
        ),
    };
    const head = await f.changes();
    for (const membership of ['join', 'knock', 'leave'] as const) {
      const error = await assertRejects(
        () =>
          membership === 'knock'
            ? sendKnock(f.roomId, '$new', {}, f.remote.name, deps)
            : membership === 'join'
            ? sendJoin(f.roomId, '$new', {}, f.remote.name, 'v2', deps)
            : sendLeave(f.roomId, '$new', {}, f.remote.name, 'v2', deps),
        MatrixError,
      );
      assertEquals(error.status, 503);
      const absent = '!absent:logical.test';
      const missing = await assertRejects(
        () =>
          membership === 'knock'
            ? sendKnock(absent, '$new', {}, f.remote.name, deps)
            : membership === 'join'
            ? sendJoin(absent, '$new', {}, f.remote.name, 'v2', deps)
            : sendLeave(absent, '$new', {}, f.remote.name, 'v2', deps),
        MatrixError,
      );
      assertEquals(
        missing.status,
        503,
        'a missing required file is not known absence',
      );
    }
    assertEquals(await f.changes(), head);
  } finally {
    await f.close();
  }
});

Deno.test('resident membership distinguishes directory-proved absence from a missing required replica file', async () => {
  const f = await fixture();
  try {
    const absent = '!absent:logical.test';
    for (const knownAbsent of [true, false]) {
      const deps = {
        ...await f.deps(),
        prepareRoomScope: () => {
          if (knownAbsent) {
            throw new MatrixError(404, 'M_NOT_FOUND', 'scope not found');
          }
          return Promise.resolve({
            checkCurrent() {},
            check: () => Promise.resolve(),
          });
        },
      };
      for (const make of [makeJoin, makeKnock, makeLeave]) {
        const error = await assertRejects(
          () => make(absent, guest, f.remote.name, ['11'], deps),
          MatrixError,
        );
        assertEquals(error.status, knownAbsent ? 404 : 503);
      }
      for (const membership of ['join', 'knock', 'leave'] as const) {
        const error = await assertRejects(
          () =>
            membership === 'knock'
              ? sendKnock(absent, '$new', {}, f.remote.name, deps)
              : membership === 'join'
              ? sendJoin(absent, '$new', {}, f.remote.name, 'v2', deps)
              : sendLeave(absent, '$new', {}, f.remote.name, 'v2', deps),
          MatrixError,
        );
        assertEquals(error.status, knownAbsent ? 404 : 503);
      }
    }
  } finally {
    await f.close();
  }
});

Deno.test('membership receipts pin the pre-join response across later room writes and cold retry', async () => {
  const f = await fixture();
  try {
    const made = await makeJoin(
      f.roomId,
      guest,
      f.remote.name,
      ['11'],
      await f.deps(),
    );
    const join = await signTemplate(made.event, f.remote);
    const wire = toWire(join, '11');
    const first = await sendJoin(
      f.roomId,
      String(join.event_id),
      wire,
      f.remote.name,
      'v2',
      await f.deps(),
    );
    const partial = await sendJoin(
      f.roomId,
      String(join.event_id),
      wire,
      f.remote.name,
      'v2',
      await f.deps(),
      true,
    );
    await f.topic('after the original join');
    const before = await f.changes();
    await f.reopen();
    const retry = await sendJoin(
      f.roomId,
      String(join.event_id),
      { ...wire, unsigned: { retry: true } },
      f.remote.name,
      'v2',
      await f.deps(),
    );
    assertEquals(retry, first, 'retry must not render a newer state/auth cut');
    assertEquals(
      await sendJoin(
        f.roomId,
        String(join.event_id),
        wire,
        f.remote.name,
        'v2',
        await f.deps(),
        true,
      ),
      partial,
      'partial variants use the same pinned cut after cold reopen',
    );
    assertEquals(await f.changes(), before, 'a replay is not new arrival news');
  } finally {
    await f.close();
  }
});

Deno.test('membership receipts replay retained signed work without minting a signature after expiry', async () => {
  const f = await fixture();
  try {
    const made = await makeJoin(
      f.roomId,
      guest,
      f.remote.name,
      ['11'],
      await f.deps(),
    );
    const join = await signTemplate(made.event, f.remote);
    const wire = toWire(join, '11');
    const first = await sendJoin(
      f.roomId,
      String(join.event_id),
      wire,
      f.remote.name,
      'v2',
      await f.deps(),
    );
    const signatures = f.signatures();
    await f.reopen();
    f.expire();
    assertEquals(
      await sendJoin(
        f.roomId,
        String(join.event_id),
        wire,
        f.remote.name,
        'v2',
        await f.deps(),
      ),
      first,
    );
    assertEquals(
      f.signatures(),
      signatures,
      'saved result needs no new permit',
    );
    const forged = structuredClone(wire);
    forged.signatures = { [f.remote.name]: { [f.remote.keyId]: 'AAAA' } };
    const deps = await f.deps();
    const error = await assertRejects(
      () =>
        sendJoin(
          f.roomId,
          String(join.event_id),
          forged,
          f.remote.name,
          'v2',
          deps,
        ),
      MatrixError,
    );
    assertEquals(error.status, 403);
  } finally {
    await f.close();
  }
});

Deno.test('completed membership replays survive later ACL changes while new operations retain ACL admission', async () => {
  const f = await fixture();
  try {
    const deps = await f.deps();
    const made = await makeJoin(f.roomId, guest, f.remote.name, ['11'], deps);
    const join = await signTemplate(made.event, f.remote);
    const wire = toWire(join, '11');
    const result = await sendJoin(
      f.roomId,
      String(join.event_id),
      wire,
      f.remote.name,
      'v2',
      deps,
    );
    const acl = await sendLocal(await f.room(), {
      type: 'm.room.server_acl',
      state_key: '',
      sender: creator,
      content: { allow: ['*'], deny: [f.remote.name] },
      origin_server_ts: Date.now(),
    }, deps.signer);
    assertEquals(acl.standing, 'accepted');
    const head = await f.changes();
    await f.reopen();
    assertEquals(
      await sendJoin(
        f.roomId,
        String(join.event_id),
        wire,
        f.remote.name,
        'v2',
        await f.deps(),
      ),
      result,
    );
    const reopened = await f.deps();
    const refused = await assertRejects(
      () =>
        sendJoin(f.roomId, '$new-operation', {}, f.remote.name, 'v2', reopened),
      MatrixError,
    );
    assertEquals(refused.status, 403);
    assertEquals(refused.message, 'M_FORBIDDEN: server denied by room ACL');
    assertEquals(await f.changes(), head);
  } finally {
    await f.close();
  }
});

Deno.test('membership receipts reject changed full material under a retained event identity', async () => {
  const f = await fixture();
  try {
    const made = await makeJoin(
      f.roomId,
      guest,
      f.remote.name,
      ['11'],
      await f.deps(),
    );
    const join = await signTemplate(made.event, f.remote);
    const wire = toWire(join, '11');
    await sendJoin(
      f.roomId,
      String(join.event_id),
      wire,
      f.remote.name,
      'v2',
      await f.deps(),
    );
    const before = await f.changes();
    const deps = await f.deps();
    const substituted = {
      ...wire,
      content: { ...join.content, displayname: 'changed material' },
    };
    const error = await assertRejects(
      () =>
        sendJoin(
          f.roomId,
          String(join.event_id),
          substituted,
          f.remote.name,
          'v2',
          deps,
        ),
      MatrixError,
    );
    assertEquals(error.status, 400);
    assertEquals(error.errcode, 'M_BAD_JSON');
    assertEquals(await f.changes(), before);
  } finally {
    await f.close();
  }
});

Deno.test('membership receipts pin knock results and share one leave result across API envelopes', async () => {
  const f = await fixture(true);
  try {
    const made = await makeKnock(
      f.roomId,
      guest,
      f.remote.name,
      ['11'],
      await f.deps(),
    );
    const knock = await signTemplate(made.event, f.remote);
    const wire = toWire(knock, '11');
    const first = await sendKnock(
      f.roomId,
      String(knock.event_id),
      wire,
      f.remote.name,
      await f.deps(),
    );
    await f.topic('after the original knock');
    await f.reopen();
    assertEquals(
      await sendKnock(
        f.roomId,
        String(knock.event_id),
        wire,
        f.remote.name,
        await f.deps(),
      ),
      first,
    );
    const leaving = await makeLeave(
      f.roomId,
      guest,
      f.remote.name,
      ['11'],
      await f.deps(),
    );
    const leave = await signTemplate(leaving.event, f.remote);
    const leaveWire = toWire(leave, '11');
    assertEquals(
      await sendLeave(
        f.roomId,
        String(leave.event_id),
        leaveWire,
        f.remote.name,
        'v1',
        await f.deps(),
      ),
      [200, {}],
    );
    const before = await f.changes();
    const signatures = f.signatures();
    await f.reopen();
    f.expire();
    assertEquals(
      await sendLeave(
        f.roomId,
        String(leave.event_id),
        leaveWire,
        f.remote.name,
        'v2',
        await f.deps(),
      ),
      {},
    );
    assertEquals(f.signatures(), signatures);
    assertEquals(await f.changes(), before);
    assert(
      'knock_room_state' in first && Array.isArray(first.knock_room_state) &&
        first.knock_room_state.length > 0,
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership receipt and actual room ingest roll back together before publication', async () => {
  const f = await fixture();
  try {
    const deps = await f.deps();
    const made = await makeJoin(f.roomId, guest, f.remote.name, ['11'], deps);
    const join = await signTemplate(made.event, f.remote);
    const prepared = await verify(join, '11', deps.keys, { roomId: f.roomId });
    const held = await f.room();
    const before = await f.changes();
    await assertRejects(
      () =>
        held.tx(async (tx) => {
          const result = await ingestInTx(tx, f.roomId, prepared.pdu, {
            remote: {
              origin: f.remote.name,
              self,
              oversized: prepared.oversized,
              ungroundedMs: config().federation.ungroundedmillihours * 3600,
              residentMembership: true,
            },
          });
          assertEquals(result.standing, 'accepted');
          await tx.membershipReceipts.save('aborted', 'same-input', {
            event: prepared.pdu,
          });
          throw new Error('abort after membership result');
        }),
      Error,
      'abort after membership result',
    );
    await f.reopen();
    const reopened = await f.room();
    assertEquals(
      await reopened.tx((tx) => tx.events.get(String(join.event_id))),
      null,
    );
    assertEquals(
      await reopened.tx((tx) =>
        tx.membershipReceipts.get('aborted', 'same-input')
      ),
      null,
    );
    assertEquals(await f.changes(), before);
    const result = await sendJoin(
      f.roomId,
      String(join.event_id),
      toWire(join, '11'),
      f.remote.name,
      'v2',
      await f.deps(),
    );
    assert(!Array.isArray(result) && result.event !== undefined);
  } finally {
    await f.close();
  }
});

Deno.test('membership receipt retries finish interrupted projection after cold reopen', async (t) => {
  for (const membership of ['join', 'knock', 'leave'] as const) {
    await t.step(membership, async () => {
      const f = await fixture(membership !== 'join');
      try {
        await registerRoom(f.store(), f.roomId);
        await project(f.store(), f.roomId);
        const deps = await f.deps();
        // A leave needs prior membership. A knock needs only the room's rule.
        if (membership === 'leave') {
          const made = await makeKnock(
            f.roomId,
            guest,
            f.remote.name,
            ['11'],
            deps,
          );
          const knock = await signTemplate(made.event, f.remote);
          await sendKnock(
            f.roomId,
            String(knock.event_id),
            toWire(knock, '11'),
            f.remote.name,
            deps,
          );
          await project(f.store(), f.roomId);
        }
        const make = membership === 'join'
          ? makeJoin
          : membership === 'knock'
          ? makeKnock
          : makeLeave;
        const made = await make(f.roomId, guest, f.remote.name, ['11'], deps);
        const signed = await signTemplate(made.event, f.remote);
        const id = String(signed.event_id);
        const send = async () =>
          membership === 'knock'
            ? await sendKnock(
              f.roomId,
              id,
              toWire(signed, '11'),
              f.remote.name,
              await f.deps(),
            )
            : await (membership === 'join' ? sendJoin : sendLeave)(
              f.roomId,
              id,
              toWire(signed, '11'),
              f.remote.name,
              'v2',
              await f.deps(),
            );
        setRoomHooks({
          project: () =>
            Promise.reject(new Error('membership projection interrupted')),
          register: registerRoom,
        });
        const first = await send();
        const count = async () =>
          (await (await f.store().server()).query(
            'SELECT COUNT(*) AS n FROM feed WHERE room=? AND event=?',
            [f.roomId, id],
          ))[0].n;
        assertEquals(
          await count(),
          0,
          'room commit precedes derived publication',
        );
        const head = await f.changes();
        await f.reopen();
        setRoomHooks({ project, register: registerRoom });
        assertEquals(await send(), first);
        assertEquals(
          await count(),
          1,
          'a retained result must not bypass pending projection',
        );
        assertEquals(
          await f.changes(),
          head,
          'projection retry adds no room news',
        );
        assertEquals(await send(), first);
        assertEquals(
          await count(),
          1,
          'the projected membership remains unique',
        );
      } finally {
        setRoomHooks({ project: async () => {}, register: async () => {} });
        await f.close();
      }
    });
  }
});
