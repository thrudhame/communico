import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { tenantSchema } from '#engine/tenant/index.ts';
import {
  importRegisterOperation,
  readRegister,
  writeRegister,
} from '#engine/facade/registers.ts';

const key = JSON.stringify([
  'account-data',
  'alice',
  '',
  'm.secret_storage.key',
]);
const home = { source: 'home', incarnation: 'home-store' };
const edge = { source: 'edge', incarnation: 'edge-store' };

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'causal-register-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const store = await openStore(options, { schemas: { tenant: tenantSchema } });
  const db = (name: string) => store.tenant(name, { create: true });
  return {
    dir,
    options,
    store,
    db,
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

function permutations<T>(values: T[]): T[][] {
  if (!values.length) return [[]];
  return values.flatMap((value, i) =>
    permutations(values.filter((_, j) => i !== j)).map((
      rest,
    ) => [value, ...rest])
  );
}

Deno.test('registers: every delivery permutation retains the causal antichain and an observed-loser successor', async () => {
  const f = await fixture();
  try {
    const a = await f.db('a.test'), b = await f.db('b.test');
    const first = await a.tx((c) =>
      writeRegister(c, home, key, 'account-data', '{"ciphertext":"home"}')
    );
    const loser = await b.tx((c) =>
      writeRegister(c, edge, key, 'account-data', '{"ciphertext":"edge"}')
    );
    await a.tx((c) => importRegisterOperation(c, loser.operation));
    const before = await a.tx((c) => readRegister(c, key));
    assertEquals(before.frontier.length, 2);
    assertEquals(before.winner?.operationId, first.operation.operationId);
    // B observes BOTH alternatives, not only its former losing value.
    await b.tx((c) => importRegisterOperation(c, first.operation));
    const successor = await b.tx((c) =>
      writeRegister(
        c,
        edge,
        key,
        'account-data',
        '{"ciphertext":"replacement"}',
      )
    );
    const independent = await a.tx((c) =>
      writeRegister(c, home, key, 'account-data', '{"ciphertext":"concurrent"}')
    );
    const operations = [first, loser, successor, independent].map((r) =>
      r.operation
    );
    let expected: unknown;
    let n = 0;
    for (const order of permutations(operations)) {
      const db = await f.db('permutation' + n++ + '.test');
      for (const operation of order) {
        await db.tx((c) => importRegisterOperation(c, operation));
        const duplicate = await db.tx((c) =>
          importRegisterOperation(c, operation)
        );
        assertEquals(duplicate.inserted, false);
        assertEquals(duplicate.changed, false);
      }
      const view = await db.tx((c) => readRegister(c, key));
      assertEquals(view.frontier.length, 2);
      assertEquals(view.winner?.operationId, independent.operation.operationId);
      assertEquals(view.conflicts.length, 3);
      assertEquals(
        (await db.query(
          'SELECT operation_id FROM domain_frontiers WHERE semantic_key=? ORDER BY operation_id',
          [key],
        )).map((r) => r.operation_id),
        view.frontier.map((r) => r.operationId).sort(),
      );
      assertEquals(
        (await db.query(
          'SELECT operation_id FROM domain_conflicts WHERE semantic_key=? ORDER BY operation_id',
          [key],
        )).map((r) => r.operation_id),
        view.conflicts.map((r) => r.operationId).sort(),
      );
      const actual = {
        frontier: view.frontier.map((r) => r.operationId),
        conflicts: view.conflicts.map((r) => r.operationId),
        winner: view.winner,
      };
      if (expected === undefined) expected = actual;
      else assertEquals(actual, expected);
      // Recovery does not lose encrypted alternative bodies after supersession.
      assertEquals(
        view.conflicts.some((r) => JSON.parse(r.payload).ciphertext === 'edge'),
        true,
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('registers: opaque JSON preserves fractions, stable object identity and local sequence domains', async () => {
  const f = await fixture();
  try {
    const db = await f.db('opaque.test');
    const first = await db.tx((c) =>
      writeRegister(c, home, key, 'account-data', '{"z":0.25,"a":{"b":-1.5}}')
    );
    assertEquals(JSON.parse(first.operation.payload), {
      z: 0.25,
      a: { b: -1.5 },
    });
    const same = await db.tx((c) =>
      writeRegister(c, home, key, 'account-data', '{"a":{"b":-1.5},"z":0.25}')
    );
    assertEquals(same.changed, false);
    assertEquals(same.operation.sequence, first.operation.sequence + 1);
    const unrelated = await db.tx((c) =>
      writeRegister(c, home, 'another-key', 'profile', '{"value":true}')
    );
    assertEquals(unrelated.operation.sequence, 1);
    const after = await db.tx((c) => readRegister(c, key));
    assertEquals(after.frontier.map((r) => r.operationId), [
      same.operation.operationId,
    ]);
    assertEquals(after.conflicts.map((r) => r.operationId), [
      first.operation.operationId,
    ]);
    const invalid = await assertRejects(() =>
      db.tx((c) =>
        writeRegister(c, home, key, 'account-data', 'private-not-json-secret')
      )
    );
    assertEquals(String(invalid), 'Error: invalid register JSON');
    assertEquals(await db.tx((c) => readRegister(c, key)), after);
  } finally {
    await f.close();
  }
});

Deno.test('registers: operation identity, immutable content and causal domains refuse substitution atomically', async () => {
  const f = await fixture();
  try {
    const db = await f.db('source.test'), target = await f.db('target.test');
    const { operation } = await db.tx((c) =>
      writeRegister(c, home, key, 'account-data', '{"secret":"original"}')
    );
    await target.tx((c) => importRegisterOperation(c, operation));
    const before = await target.tx((c) => readRegister(c, key));
    for (
      const changed of [
        { ...operation, payload: '{"secret":"substitution"}' },
        { ...operation, operationId: 'different-operation' },
        { ...operation, semanticKey: 'another-key' },
        { ...operation, context: [{ ...home, sequence: operation.sequence }] },
        {
          ...operation,
          context: [{ ...edge, sequence: 1 }, { ...edge, sequence: 2 }],
        },
        { ...operation, sequence: Number.MAX_SAFE_INTEGER + 1 },
      ]
    ) {
      await assertRejects(() =>
        target.tx((c) => importRegisterOperation(c, changed))
      );
      assertEquals(await target.tx((c) => readRegister(c, key)), before);
    }
    // A well-formed operation with the same immutable dot and different body
    // must also fail even if its hash is internally consistent.
    const other = await f.db('other.test');
    const substitute = await other.tx((c) =>
      writeRegister(c, home, key, 'account-data', '{"secret":"substitution"}')
    );
    await assertRejects(() =>
      target.tx((c) => importRegisterOperation(c, substitute.operation))
    );
    assertEquals(await target.tx((c) => readRegister(c, key)), before);
  } finally {
    await f.close();
  }
});

Deno.test('registers: rollback and cold reopen preserve counters, contexts, conflicts and value projection decisions', async () => {
  const f = await fixture();
  try {
    const db = await f.db('cold.test');
    await assertRejects(() =>
      db.tx(async (c) => {
        await writeRegister(
          c,
          home,
          key,
          'account-data',
          '{"rolled_back":true}',
        );
        throw new Error('rollback owner mutation');
      })
    );
    assertEquals((await db.tx((c) => readRegister(c, key))).winner, null);
    const first = await db.tx((c) =>
      writeRegister(c, home, key, 'account-data', '{"retained":true}')
    );
    assertEquals(first.operation.sequence, 1);
    const before = await db.tx((c) => readRegister(c, key));
    await f.store.close();
    const reopened = await openStore(f.options, {
      schemas: { tenant: tenantSchema },
    });
    try {
      const cold = await reopened.tenant('cold.test');
      assertEquals(await cold.tx((c) => readRegister(c, key)), before);
      const next = await cold.tx((c) =>
        writeRegister(c, home, key, 'account-data', '{"retained":false}')
      );
      assertEquals(next.operation.sequence, 2);
      assertEquals(next.operation.context, [{ ...home, sequence: 1 }]);
      assertEquals(next.changed, true);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('registers: ASCII source and numeric sequence ordering do not depend on locale or arrival time', async () => {
  const f = await fixture();
  try {
    const upper = await f.db('upper.test'), lower = await f.db('lower.test');
    const capital = await upper.tx((c) =>
      writeRegister(
        c,
        { source: 'Z', incarnation: 'store' },
        key,
        'account-data',
        '"Z"',
      )
    );
    let small = await lower.tx((c) =>
      writeRegister(
        c,
        { source: 'a', incarnation: 'store' },
        key,
        'account-data',
        '"a1"',
      )
    );
    for (let i = 2; i <= 10; i++) {
      small = await lower.tx((c) =>
        writeRegister(
          c,
          { source: 'a', incarnation: 'store' },
          key,
          'account-data',
          JSON.stringify('a' + i),
        )
      );
    }
    await lower.tx((c) => importRegisterOperation(c, capital.operation));
    const view = await lower.tx((c) => readRegister(c, key));
    assertEquals(view.frontier.length, 2);
    assertEquals(view.winner?.operationId, small.operation.operationId);
    assertEquals(view.winner?.sequence, 10);
    const next = await lower.tx((c) =>
      writeRegister(
        c,
        { source: 'a', incarnation: 'store' },
        key,
        'account-data',
        '"joined"',
      )
    );
    assertEquals(next.operation.context, [
      { source: 'Z', incarnation: 'store', sequence: 1 },
      { source: 'a', incarnation: 'store', sequence: 10 },
    ]);
    assertEquals(
      (await lower.tx((c) => readRegister(c, key))).frontier.length,
      1,
    );
    // Restored counters cannot reuse an imported local dot or a received cut.
    const restored = await f.db('restored.test');
    await restored.tx((c) => importRegisterOperation(c, next.operation));
    const fresh = await restored.tx((c) =>
      writeRegister(
        c,
        { source: 'a', incarnation: 'store' },
        key,
        'account-data',
        '"fresh"',
      )
    );
    assertEquals(fresh.operation.sequence, 12);
  } finally {
    await f.close();
  }
});
