import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { membershipDisplay } from '#engine/server/membership-display.ts';
import {
  checkedMembershipOperation,
  membershipHistory,
  retainMembershipOperation,
} from '#engine/server/membership-history.ts';
import {
  appendMembershipSuccessor,
  type MembershipOperation,
  membershipOperations,
  type MembershipState,
  recordMembershipOperation,
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

function withState(
  operation: MembershipOperation,
  change: Partial<MembershipState>,
) {
  const payload = canonicalJson({
    ...JSON.parse(operation.payload),
    ...change,
  });
  return {
    ...operation,
    payload,
    payloadHash: createHash('sha256').update(payload).digest('hex'),
  };
}

Deno.test('membership display: concurrent distinct OOB invites converge by event ID in either arrival order', async () => {
  const low = withState(fact('home'), { eventId: '$a' });
  const high = withState(fact('edge'), { eventId: '$z' });
  for (const order of [[low, high], [high, low]]) {
    await fixture(async (server) => {
      for (const operation of order) {
        await server.tx((conn) => retainMembershipOperation(conn, operation));
      }
      const selected = await server.tx((conn) =>
        membershipDisplay(conn, low.semanticKey, false)
      );
      assertEquals(selected.display, [high]);
      assertEquals(selected.frontier.length, 2);
      assertEquals(
        (await server.query('SELECT * FROM domain_operations')).length,
        2,
      );
      assertEquals(await server.query('SELECT * FROM prejoin_memberships'), []);
      assertEquals(await server.query('SELECT * FROM domain_frontiers'), []);
    });
  }
});

Deno.test('membership display: causal successor wins before distinct event-ID ordering', async () => {
  await fixture(async (server) => {
    const first = withState(fact(), { eventId: '$z' });
    const next = withState(fact('edge', 1, [dot(first)]), { eventId: '$a' });
    for (const operation of [next, first]) {
      await server.tx((conn) => retainMembershipOperation(conn, operation));
    }
    assertEquals(
      (await server.tx((conn) =>
        membershipDisplay(conn, first.semanticKey, false)
      )).display,
      [next],
    );
  });
});

Deno.test('membership display: concurrent same-event terminal facts suppress stale invites without hiding unrelated invites', async () => {
  for (const status of ['rejecting', 'failed-retract', 'rejected', 'joined']) {
    await fixture(async (server) => {
      const stale = withState(fact(), { eventId: '$z' });
      const terminal = withState(fact('edge'), { eventId: '$z', status });
      const other = withState(fact('third'), { eventId: '$a' });
      for (const operation of [terminal, other, stale]) {
        await server.tx((conn) => retainMembershipOperation(conn, operation));
      }
      const selected = await server.tx((conn) =>
        membershipDisplay(conn, stale.semanticKey, false)
      );
      assertEquals(selected.display, [other]);
      assertEquals(selected.frontier.length, 3);
    });
  }
});

Deno.test('membership display: held rooms, incomplete history and uncompleted attempts never acquire OOB display authority', async () => {
  await fixture(async (server) => {
    const pending = fact();
    const incomplete = withState(fact('edge', 2, [dot(fact('edge'))]), {
      eventId: '$z',
      status: 'pending',
    });
    const attempt = withState(fact('third'), {
      eventId: '$y',
      kind: 'knock',
      status: 'attempting',
    });
    for (const operation of [pending, incomplete, attempt]) {
      await server.tx((conn) => retainMembershipOperation(conn, operation));
    }
    assertEquals(
      (await server.tx((conn) =>
        membershipDisplay(conn, pending.semanticKey, false)
      )).display,
      [pending],
    );
    assertEquals(
      (await server.tx((conn) =>
        membershipDisplay(conn, pending.semanticKey, true)
      )).display,
      [],
    );
  });
});

Deno.test('membership display: same-event duplicates retain all candidate evidence without inventing another tie breaker', async () => {
  await fixture(async (server) => {
    const home = fact(), edge = fact('edge');
    for (const operation of [home, edge]) {
      await server.tx((conn) => retainMembershipOperation(conn, operation));
    }
    assertEquals(
      (await server.tx((conn) =>
        membershipDisplay(conn, home.semanticKey, false)
      )).display,
      [edge, home],
    );
  });
});

Deno.test('membership display: an unrelated successor cannot discard the tombstone needed to suppress a concurrent stale invitation', async () => {
  await fixture(async (server) => {
    const old = withState(fact(), { eventId: '$z' });
    const terminal = withState(fact('home', 2, [dot(old)]), {
      eventId: '$z',
      status: 'rejected',
    });
    const next = withState(fact('home', 3, [dot(terminal)]), {
      eventId: '$a',
      status: 'pending',
    });
    const stale = withState(fact('edge'), { eventId: '$z' });
    for (const operation of [stale, next, terminal, old]) {
      await server.tx((conn) => retainMembershipOperation(conn, operation));
    }
    assertEquals(
      (await server.tx((conn) =>
        membershipDisplay(conn, old.semanticKey, false)
      )).display,
      [next],
    );
  });
});

Deno.test('membership display: an uncompleted copy of the same attempt does not erase an accepted pending fact', async () => {
  for (const status of ['attempting', 'failed-attempt']) {
    await fixture(async (server) => {
      const accepted = withState(fact(), { kind: 'knock' });
      const attempt = withState(fact('edge'), { kind: 'knock', status });
      for (const operation of [attempt, accepted]) {
        await server.tx((conn) => retainMembershipOperation(conn, operation));
      }
      assertEquals(
        (await server.tx((conn) =>
          membershipDisplay(conn, accepted.semanticKey, false)
        )).display,
        [accepted],
      );
    });
  }
});

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

Deno.test('membership history: a fresh observation preserves both same-source branches after prepared completion', async () => {
  const operations: MembershipOperation[] = [];
  await fixture(async (server) => {
    const first = withState(fact(), { eventId: '$first', status: 'pending' });
    const state = JSON.parse(first.payload) as MembershipState;
    await server.execute(
      "INSERT INTO publication_domain VALUES(1,'home','publication','domain')",
    );
    await server.execute('INSERT INTO facade_owner_controls VALUES(?,?,?,?)', [
      'membership-test',
      1,
      'verified-test',
      canonicalJson({
        body: {
          server: 'logical.test',
          nodes: [{ node: 'home', incarnation: 'home-incarnation' }],
        },
      }),
    ]);
    await server.execute(
      "INSERT INTO facade_owner_activation VALUES('membership-test',1,'verified-test')",
    );
    await server.execute(
      `INSERT INTO prejoin_memberships(room_id,user_id,event_id,room_version,event_json,invite_room_state,origin,received_ms,status,seq,kind)
       VALUES(?,?,?,?,?,?,?,1,'pending',1,'invite')`,
      [
        state.roomId,
        state.userId,
        state.eventId,
        state.roomVersion,
        state.eventJson,
        state.inviteRoomState,
        state.origin,
      ],
    );
    const observe = () =>
      server.tx((conn) =>
        recordMembershipOperation(conn, state.roomId, state.userId)
      );
    await observe();
    const [a1] = await server.tx((conn) =>
      membershipOperations(conn, state.userId)
    );
    await server.execute('UPDATE prejoin_memberships SET event_id=?', [
      '$z-new',
    ]);
    await observe();
    const [, a2] = await server.tx((conn) =>
      membershipOperations(conn, state.userId)
    );
    const a3 = await server.tx((conn) =>
      appendMembershipSuccessor(conn, a1, {
        ...JSON.parse(a1.payload) as MembershipState,
        status: 'rejected',
      })
    );
    // Completing A1 must not retrospectively observe the newer A2 invitation.
    assertEquals(a3.context, [dot(a1)]);
    await server.execute('UPDATE prejoin_memberships SET event_id=?', [
      '$a-fresh',
    ]);
    await observe();
    operations.push(
      ...await server.tx((conn) => membershipOperations(conn, state.userId)),
    );
    assertEquals(operations[3].context, [dot(a2), dot(a3)]);
    assertEquals(
      (await server.tx((conn) => membershipHistory(conn, a1.semanticKey)))
        .frontier,
      [operations[3]],
    );
  });
  const permutations = (
    values: MembershipOperation[],
  ): MembershipOperation[][] =>
    values.length === 0
      ? [[]]
      : values.flatMap((value, index) =>
        permutations(values.filter((_, at) => at !== index)).map((
          rest,
        ) => [value, ...rest])
      );
  for (const order of permutations(operations)) {
    await fixture(async (server) => {
      for (const operation of order) {
        await server.tx((conn) => retainMembershipOperation(conn, operation));
      }
      const selected = await server.tx((conn) =>
        membershipDisplay(conn, operations[0].semanticKey, false)
      );
      assertEquals(selected.pending, []);
      assertEquals(selected.frontier, [operations[3]]);
      assertEquals(selected.display, [operations[3]]);
      assertEquals(await server.query('SELECT * FROM prejoin_memberships'), []);
    });
  }
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
      { context: [dot(fact('home', 2))] },
      { context: [{ ...dot(original), sequence: 0 }] },
      { context: [dot(fact('edge')), dot(fact('edge'))] },
      { context: [dot(fact('edge', 2)), dot(fact('edge'))] },
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
