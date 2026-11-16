import { assertEquals, assertRejects } from '@std/assert';
import {
  initializeRoom,
  openRoom,
  type Room,
  roomSchema,
  type RoomTx,
} from '#engine/room/index.ts';
import { Conn } from '#engine/store/db.ts';
import { StoreError, Turso } from '#engine/store/ffi.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { prepareEventSignatures } from '#engine/room/signatures.ts';
import { b64encodeStd } from '#engine/signing-primitives.js';
import {
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
} from './fixtures/remote.ts';

const pdu = (body: string) =>
  JSON.stringify({
    type: 'm.room.message',
    sender: '@dev:test',
    depth: 1,
    origin_server_ts: 1,
    content: { body },
    prev_events: [],
    auth_events: [],
  });
async function withStore(fn: (store: Store) => Promise<void>) {
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
async function withRoom(fn: (room: Room) => Promise<void>) {
  await withStore(async (store) =>
    await fn(await openRoom(store, '!reader:test', { create: true }))
  );
}

Deno.test('event reader: verified signature writes update the attempt view without rehydration and roll back with their intent', async () => {
  await withRoom(async (room) => {
    const author = await makeRemoteServer('author.test');
    const witness = await makeRemoteServer('witness.test');
    const partial = {
      type: 'm.room.message',
      sender: '@dev:author.test',
      content: { body: 'immutable' },
      prev_events: [],
      depth: 1,
      origin_server_ts: 1,
    };
    const base = await remoteEvent(room.id, author, '11', partial);
    const extra = await remoteEvent(room.id, witness, '11', partial);
    const combined = {
      ...base,
      signatures: { ...base.signatures, ...extra.signatures },
    };
    // Older ordinary admission validates required signatures only. A valid
    // later witness must repair this optional entry in the effective overlay.
    base.signatures[witness.name] = { [witness.keyId]: 'invalid old optional' };
    base.signatures['unverified.test'] = {
      'ed25519:old': 'unverified optional',
    };
    const effective = { ...base.signatures, ...combined.signatures };
    const { evidence } = await prepareEventSignatures(
      combined,
      '11',
      fakeKeyResolver(author, witness),
    );
    const id = String(base.event_id);
    await room.tx((tx) => tx.events.insert(id, JSON.stringify(base)));
    await assertRejects(
      () =>
        room.tx(async (tx) => {
          await tx.events.get(id);
          assertEquals(await tx.events.mergeSignatures(evidence), true);
          throw new Error('rollback signature union');
        }),
      Error,
      'rollback signature union',
    );
    assertEquals(await room.tx((tx) => tx.changes.head()), 0);
    assertEquals(
      JSON.parse((await room.tx((tx) => tx.events.get(id)))!.pdu).signatures,
      base.signatures,
    );
    const original = Conn.prototype.query;
    let reads = 0;
    Conn.prototype.query = function (sql, values) {
      if (sql.includes('FROM events WHERE id')) reads++;
      return original.call(this, sql, values);
    };
    try {
      await room.tx(async (tx) => {
        await tx.events.list([id]);
        assertEquals(reads, 1);
        assertEquals(await tx.events.mergeSignatures(evidence), true);
        assertEquals(
          JSON.parse((await tx.events.get(id))!.pdu).signatures,
          effective,
        );
        assertEquals(
          JSON.parse((await tx.events.list([id])).get(id)!.pdu).signatures,
          effective,
        );
        assertEquals(await tx.events.mergeSignatures(evidence), false);
        assertEquals(reads, 1);
        assertEquals((await tx.changes.after(0, 10)).map((row) => row.kind), [
          'signature',
        ]);
      });
      await room.tx(async (tx) => {
        assertEquals(
          JSON.parse((await tx.events.list([id])).get(id)!.pdu).signatures,
          effective,
        );
        assertEquals(reads, 2);
      });
    } finally {
      Conn.prototype.query = original;
    }
    const [overlay] = await (await room.store.room(room.id)).query(
      'SELECT signatures FROM event_signatures WHERE event=?',
      [id],
    );
    assertEquals(JSON.parse(String(overlay.signatures)), combined.signatures);
    assertEquals(
      await (await room.store.room(room.id)).query(
        'SELECT pdu FROM events WHERE id=?',
        [id],
      ),
      [{ pdu: JSON.stringify(base) }],
    );
  });
});

Deno.test('event reader: verified signature candidates converge across arrival orders and equivalent encodings', async () => {
  const author = await makeRemoteServer('author.test');
  const baseKeys = fakeKeyResolver(author);
  const a = b64encodeStd(new Uint8Array(64).fill(17));
  const b = b64encodeStd(new Uint8Array(64).fill(34));
  let expected: unknown;
  for (const order of [[a, b], [b, a]]) {
    await withRoom(async (room) => {
      const base = await remoteEvent(room.id, author, '11', {
        type: 'm.room.message',
        sender: '@dev:author.test',
        content: { body: 'same' },
        prev_events: [],
        depth: 1,
        origin_server_ts: 1,
      });
      const keys = {
        verifyEventSignature: (
          args: Parameters<typeof baseKeys.verifyEventSignature>[0],
        ) => {
          // Two accepted candidates exercise the merge algebra independently
          // of crypto. The other signature tests use real Ed25519 witnesses.
          if (args.server === 'witness.test') {
            return Promise.resolve(
              [a, b, a + '==', b + '=='].includes(
                args.pdu.signatures[args.server]?.[args.keyId],
              ),
            );
          }
          return baseKeys.verifyEventSignature(args);
        },
      };
      const proofs = await Promise.all(
        order.map(async (signature) =>
          (await prepareEventSignatures(
            {
              ...base,
              signatures: {
                ...base.signatures,
                'witness.test': { 'ed25519:1': signature },
              },
            },
            '11',
            keys,
          )).evidence
        ),
      );
      const id = String(base.event_id);
      await room.tx(async (tx) => {
        await tx.events.insert(id, JSON.stringify(base));
        for (const proof of proofs) await tx.events.mergeSignatures(proof);
        const actual =
          JSON.parse((await tx.events.get(id))!.pdu).signatures['witness.test'];
        if (expected === undefined) expected = actual;
        else assertEquals(actual, expected);
        const head = await tx.changes.head();
        for (const proof of proofs) {
          assertEquals(await tx.events.mergeSignatures(proof), false);
        }
        assertEquals(await tx.changes.head(), head);
      });
      const padded = await prepareEventSignatures(
        {
          ...base,
          signatures: {
            ...base.signatures,
            'witness.test': { 'ed25519:1': b + '==' },
          },
        },
        '11',
        keys,
      );
      await room.tx(async (tx) => {
        assertEquals(await tx.events.mergeSignatures(padded.evidence), false);
      });
    });
  }
});

Deno.test('event reader: scalar and bulk requests share one hydration and return isolated rows', async () => {
  await withRoom(async (room) => {
    await room.tx(async (tx) => {
      for (const id of ['$a', '$b', '$c', '$d']) {
        await tx.events.insert(id, pdu(id));
      }
    });
    const original = Conn.prototype.query;
    let reads = 0;
    Conn.prototype.query = function (sql, values) {
      if (sql.includes('FROM events WHERE id')) reads++;
      return original.call(this, sql, values);
    };
    try {
      await room.tx(async (tx) => {
        const [a, duplicate, batch] = await Promise.all([
          tx.events.get('$a'),
          tx.events.get('$a'),
          tx.events.list(['$a', '$b', '$a']),
        ]);
        assertEquals(reads, 2);
        assertEquals(a, duplicate);
        a!.pdu = 'mutated';
        duplicate!.sender = 'mutated';
        batch.get('$a')!.type = 'mutated';
        batch.clear();
        assertEquals((await tx.events.get('$a'))!.pdu, pdu('$a'));
        assertEquals(
          (await tx.events.list(['$a', '$b'])).get('$a')!.sender,
          '@dev:test',
        );
        assertEquals(reads, 2);
        const [bulk, c, d] = await Promise.all([
          tx.events.list(['$c', '$d']),
          tx.events.get('$c'),
          tx.events.get('$d'),
        ]);
        assertEquals(reads, 3);
        assertEquals(bulk.get('$c'), c);
        assertEquals(bulk.get('$d'), d);
      });
    } finally {
      Conn.prototype.query = original;
    }
  });
});

Deno.test('event reader: misses, failed reads and mutable status remain fresh', async () => {
  await withRoom(async (room) => {
    await room.tx(async (tx) => {
      assertEquals(await tx.events.get('$later'), null);
      assertEquals(await tx.events.list(['$later']), new Map());
      await tx.events.insert('$later', pdu('inserted after miss'));
      assertEquals(
        (await tx.events.get('$later'))!.pdu,
        pdu('inserted after miss'),
      );
      await tx.events.setStatus('$later', {
        standing: 'accepted',
        grounding: 'grounded',
        origin: null,
        received_ts: 1,
      });
      assertEquals((await tx.events.getStatus('$later'))!.standing, 'accepted');
      await tx.events.setStatus('$later', {
        standing: 'rejected',
        grounding: 'evidence',
        origin: null,
        received_ts: 2,
      });
      assertEquals((await tx.events.getStatus('$later'))!.standing, 'rejected');
      assertEquals(
        (await tx.events.get('$later'))!.pdu,
        pdu('inserted after miss'),
      );
      await tx.events.insert('$fault', pdu('after fault'));
      const original = Conn.prototype.query;
      let fail = true;
      Conn.prototype.query = function (sql, values) {
        if (fail && sql.includes('FROM events WHERE id')) {
          fail = false;
          return Promise.reject(new Error('injected event read fault'));
        }
        return original.call(this, sql, values);
      };
      try {
        await assertRejects(
          () => tx.events.list(['$fault']),
          Error,
          'injected event read fault',
        );
        assertEquals((await tx.events.get('$fault'))!.pdu, pdu('after fault'));
      } finally {
        Conn.prototype.query = original;
      }
    });
  });
});

Deno.test('event reader: rollback and native retry receive fresh readers and release escaped capabilities', async () => {
  await withRoom(async (room) => {
    let escaped!: RoomTx;
    await assertRejects(
      () =>
        room.tx(async (tx) => {
          escaped = tx;
          await tx.events.insert('$rollback', pdu('abandoned'));
          await tx.events.get('$rollback');
          throw new Error('rollback event attempt');
        }),
      Error,
      'rollback event attempt',
    );
    await assertRejects(
      () => escaped.events.get('$rollback'),
      Error,
      'released',
    );
    await assertRejects(
      () => escaped.events.list(['$rollback']),
      Error,
      'released',
    );
    await room.tx(async (tx) => {
      assertEquals(await tx.events.get('$rollback'), null);
    });
    const commit = Turso.prototype.commit;
    let calls = 0, attempts = 0;
    const readers: RoomTx[] = [];
    Turso.prototype.commit = function (handle) {
      if (++calls === 1) {
        return Promise.reject(new StoreError(517, 'snapshot', 'BusySnapshot'));
      }
      return commit.call(this, handle);
    };
    try {
      const value = await room.tx(async (tx) => {
        readers.push(tx);
        const body = 'attempt' + ++attempts;
        assertEquals(await tx.events.get('$retry'), null);
        await tx.events.insert('$retry', pdu(body));
        return (await tx.events.get('$retry'))!.pdu;
      });
      assertEquals(attempts, 2);
      assertEquals(value, pdu('attempt2'));
    } finally {
      Turso.prototype.commit = commit;
    }
    for (const tx of readers) {
      await assertRejects(() => tx.events.get('$retry'), Error, 'released');
      await assertRejects(() => tx.events.list(['$retry']), Error, 'released');
    }
    assertEquals(
      await room.tx(async (tx) => (await tx.events.get('$retry'))!.pdu),
      pdu('attempt2'),
    );
  });
});

Deno.test('event reader: room and store identity never share immutable rows', async () => {
  await withRoom(async (first) => {
    const second = await openRoom(first.store, '!other:test', { create: true });
    await first.tx(async (tx) => {
      await tx.events.insert('$same', pdu('first room'));
    });
    await second.tx(async (tx) => {
      await tx.events.insert('$same', pdu('second room'));
    });
    assertEquals(
      await first.tx(async (tx) => (await tx.events.get('$same'))!.pdu),
      pdu('first room'),
    );
    assertEquals(
      await second.tx(async (tx) => (await tx.events.get('$same'))!.pdu),
      pdu('second room'),
    );
    await withRoom(async (otherStore) => {
      await otherStore.tx(async (tx) => {
        await tx.events.insert('$same', pdu('other store'));
      });
      assertEquals(
        await otherStore.tx(async (tx) => (await tx.events.get('$same'))!.pdu),
        pdu('other store'),
      );
    });
    assertEquals(
      await first.tx(async (tx) => (await tx.events.get('$same'))!.pdu),
      pdu('first room'),
    );
  });
});

Deno.test('event reader: unpublished initialization shares and releases its reader', async () => {
  await withStore(async (store) => {
    let escaped!: RoomTx;
    await initializeRoom(store, '!initial:test', async (tx) => {
      escaped = tx;
      await tx.events.insert('$initial', pdu('initialized'));
      const row = await tx.events.get('$initial');
      row!.pdu = 'mutated';
      assertEquals(
        (await tx.events.list(['$initial'])).get('$initial')!.pdu,
        pdu('initialized'),
      );
    });
    await assertRejects(
      () => escaped.events.get('$initial'),
      Error,
      'released',
    );
    await assertRejects(
      () => escaped.events.list(['$initial']),
      Error,
      'released',
    );
    const room = await openRoom(store, '!initial:test');
    assertEquals(
      await room.tx(async (tx) => (await tx.events.get('$initial'))!.pdu),
      pdu('initialized'),
    );
  });
});
