import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import {
  checkedMembershipOperation,
  membershipHistory,
  retainMembershipOperation,
} from '#engine/server/membership-history.ts';
import type {
  MembershipOperation,
  MembershipState,
} from '#engine/server/membership-operations.ts';

function fact(
  source = 'home',
  sequence = 1,
  context: MembershipOperation['context'] = [],
): MembershipOperation {
  const state: MembershipState = {
    roomId: '!room:remote.test',
    userId: '@alice:logical.test',
    eventId: '$invite',
    roomVersion: '11',
    eventJson: '{"retained":true}',
    inviteRoomState: '[]',
    origin: 'remote.test',
    status: sequence === 1 ? 'pending' : 'rejected',
    kind: 'invite',
    localLeaveJson: null,
    publication: null,
  };
  const stream = 'membership:' + state.userId;
  const incarnation = source + '-incarnation';
  const payload = canonicalJson(state);
  return {
    operationId: canonicalJson([source, incarnation, stream, sequence]),
    source,
    incarnation,
    stream,
    sequence,
    semanticKey: canonicalJson(['membership', state.roomId, state.userId]),
    kind: 'membership',
    context,
    payload,
    payloadHash: createHash('sha256').update(payload).digest('hex'),
  };
}

function dot(operation: MembershipOperation) {
  const { source, incarnation, sequence } = operation;
  return { source, incarnation, sequence };
}

async function fixture(
  run: (
    server: Awaited<
      ReturnType<Awaited<ReturnType<typeof openStore>>['server']>
    >,
  ) => Promise<void>,
) {
  const dir = await Deno.makeTempDir({ prefix: 'membership-history-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema } });
  try {
    await run(await store.server());
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('membership history: exact retry retains one immutable fact without a display, local counter or winner', async () => {
  await fixture(async (server) => {
    const counters = await server.query('SELECT * FROM counters ORDER BY name');
    const operation = fact();
    assertEquals(
      await server.tx((conn) => retainMembershipOperation(conn, operation)),
      true,
    );
    assertEquals(
      await server.tx((conn) => retainMembershipOperation(conn, operation)),
      false,
    );
    assertEquals(
      await server.tx((conn) => membershipHistory(conn, operation.semanticKey)),
      { ready: [operation], pending: [], frontier: [operation] },
    );
    for (
      const table of ['prejoin_memberships', 'memberships', 'domain_frontiers']
    ) {
      assertEquals(await server.query('SELECT * FROM ' + table), []);
    }
    assertEquals(
      await server.query('SELECT * FROM counters ORDER BY name'),
      counters,
    );
    assertEquals(
      (await server.query('SELECT applied FROM domain_operations'))[0].applied,
      0,
    );
  });
});

Deno.test('membership history: a missing transitive predecessor cannot grant lifecycle authority', async () => {
  await fixture(async (server) => {
    const first = fact(),
      second = fact('home', 2, [dot(first)]),
      third = fact('home', 3, [dot(second)]);
    await server.tx((conn) => retainMembershipOperation(conn, third));
    await server.tx((conn) => retainMembershipOperation(conn, second));
    let history = await server.tx((conn) =>
      membershipHistory(conn, first.semanticKey)
    );
    assertEquals(history.ready, []);
    assertEquals(history.pending, [second, third]);
    await server.tx((conn) => retainMembershipOperation(conn, first));
    history = await server.tx((conn) =>
      membershipHistory(conn, first.semanticKey)
    );
    assertEquals(history.ready, [first, second, third]);
    assertEquals(history.frontier, [third]);
    assertEquals(history.pending, []);
  });
});

Deno.test('membership history: concurrent facts remain distinct instead of inventing a register or arrival winner', async () => {
  await fixture(async (server) => {
    const home = fact(), edge = fact('edge');
    await server.tx((conn) => retainMembershipOperation(conn, home));
    await server.tx((conn) => retainMembershipOperation(conn, edge));
    const history = await server.tx((conn) =>
      membershipHistory(conn, home.semanticKey)
    );
    assertEquals(history.frontier, [edge, home]);
    assertEquals(await server.query('SELECT * FROM domain_frontiers'), []);
  });
});

Deno.test('membership history: changed material and same-dot cross-room substitution cannot overwrite retained evidence', async () => {
  await fixture(async (server) => {
    const original = fact();
    await server.tx((conn) => retainMembershipOperation(conn, original));
    const changed = fact();
    const state = JSON.parse(changed.payload);
    state.status = 'rejected';
    changed.payload = canonicalJson(state);
    changed.payloadHash = createHash('sha256').update(changed.payload).digest(
      'hex',
    );
    await assertRejects(
      () => server.tx((conn) => retainMembershipOperation(conn, changed)),
      Error,
      'divergence',
    );
    state.roomId = '!other:remote.test';
    changed.semanticKey = canonicalJson([
      'membership',
      state.roomId,
      state.userId,
    ]);
    changed.payload = canonicalJson(state);
    changed.payloadHash = createHash('sha256').update(changed.payload).digest(
      'hex',
    );
    await assertRejects(
      () => server.tx((conn) => retainMembershipOperation(conn, changed)),
      Error,
      'divergence',
    );
    assertEquals(
      (await server.query('SELECT payload_json FROM domain_operations'))[0]
        .payload_json,
      original.payload,
    );
  });
});

Deno.test('membership history: another semantic lifecycle cannot satisfy this fact causal predecessor', async () => {
  await fixture(async (server) => {
    const first = fact(), second = fact('edge', 1, [dot(first)]);
    const state = JSON.parse(first.payload);
    state.roomId = '!other:remote.test';
    first.semanticKey = canonicalJson([
      'membership',
      state.roomId,
      state.userId,
    ]);
    first.payload = canonicalJson(state);
    first.payloadHash = createHash('sha256').update(first.payload).digest(
      'hex',
    );
    await server.tx((conn) => retainMembershipOperation(conn, first));
    await server.tx((conn) => retainMembershipOperation(conn, second));
    assertEquals(
      (await server.tx((conn) => membershipHistory(conn, second.semanticKey)))
        .ready,
      [],
    );
  });
});

Deno.test('membership history: rollback removes admission and no successor is made visible', async () => {
  await fixture(async (server) => {
    await assertRejects(
      () =>
        server.tx(async (conn) => {
          await retainMembershipOperation(conn, fact());
          throw new Error('rollback history');
        }),
      Error,
      'rollback history',
    );
    assertEquals(await server.query('SELECT * FROM domain_operations'), []);
  });
});

Deno.test('membership history: malformed identity, source, payload and causal contexts are rejected', () => {
  const original = fact();
  assertEquals(checkedMembershipOperation(original), original);
  for (
    const patch of [
      { sequence: 0 },
      { sequence: 1.5 },
      { source: '' },
      { incarnation: '' },
      { operationId: 'not-the-dot' },
      { stream: 'membership:@bob:logical.test' },
      { semanticKey: 'another-key' },
      { kind: 'profile' },
      { payloadHash: 'bad' },
      { context: [dot(original)] },
      { context: [{ ...dot(original), sequence: 0 }] },
      { context: [dot(fact('edge')), dot(fact('edge', 2))] },
    ]
  ) {
    assertThrows(() =>
      checkedMembershipOperation(
        { ...original, ...patch } as MembershipOperation,
      )
    );
  }
  for (
    const patch of [
      { status: 'invented' },
      { kind: 'invented' },
      { userId: '@bob:logical.test' },
      { inviteRoomState: '{}' },
      { localLeaveJson: 3 },
      { publication: { eventId: '$x', membership: 'join', follows: 'yes' } },
    ]
  ) {
    const payload = canonicalJson({
      ...JSON.parse(original.payload),
      ...patch,
    });
    assertThrows(() =>
      checkedMembershipOperation({
        ...original,
        payload,
        payloadHash: createHash('sha256').update(payload).digest('hex'),
      })
    );
  }
});

Deno.test('membership history: malformed private JSON is refused without quoting its content', () => {
  const operation = fact();
  for (
    const field of ['payload', 'eventJson', 'inviteRoomState', 'localLeaveJson']
  ) {
    const secret = 'PRIVATE_INVITE_CONTENT_DO_NOT_LOG';
    const malformed = '{"' + secret + '":';
    const payload = field === 'payload' ? malformed : canonicalJson({
      ...JSON.parse(operation.payload),
      [field]: malformed,
    });
    const error = assertThrows(() =>
      checkedMembershipOperation({
        ...operation,
        payload,
        payloadHash: createHash('sha256').update(payload).digest('hex'),
      }), Error);
    assertEquals(error.message, 'invalid membership operation');
    assertEquals(error.message.includes(secret), false);
  }
});
