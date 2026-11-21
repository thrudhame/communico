import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore, type Store } from '#engine/store/index.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { ingestLocal, redactEvent, sendLocal } from '#engine/room/ingest.ts';
import { buildInTx } from '#engine/room/build.ts';
import { genesis } from '#tests/fixtures/genesis.ts';
import { onProjected, projectThrough } from '#engine/server/project.ts';
import type { CompletionTarget } from '#engine/room/completion.ts';

async function fixture(fn: (store: Store, dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: 'completion-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 16,
    idleseconds: 300,
  }, { schemas: { room: roomSchema, server: serverSchema } });
  try {
    await fn(store, dir);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('completion: exact first acceptance cut includes all effects and survives later writes', async () => {
  await fixture(async (store) => {
    const g = await genesis(store, { roomId: '!completion:test' });
    const db = await store.room(g.roomId);
    const [identity] = await db.query('SELECT * FROM completion_state');
    assert(
      typeof identity.generation === 'string' && identity.generation.length > 0,
    );
    assertEquals(identity.legacy_through, 0);
    const write = (body: string) =>
      sendLocal(g.room, {
        type: 'm.room.message',
        sender: g.creator,
        content: { msgtype: 'm.text', body },
      }, g.signer);
    const first = await write('first');
    const [receipt] = await db.query(
      'SELECT * FROM completion_receipts WHERE event=?',
      [first.eventId],
    );
    const head = await g.room.tx((tx) => tx.changes.head());
    assertEquals(receipt.through, head);
    assertEquals(receipt.basis, 'accepted');
    assert(
      Number(receipt.through) > Number(
        await g.room.tx((tx) => tx.changes.posOf(first.eventId)),
      ),
    );
    await write('later');
    assertEquals(
      await db.query('SELECT * FROM completion_receipts WHERE event=?', [
        first.eventId,
      ]),
      [receipt],
    );
    assertEquals((await openRoom(store, g.roomId)).id, g.roomId);
    assertEquals(await db.query('SELECT generation FROM completion_state'), [{
      generation: identity.generation,
    }]);
  });
});

Deno.test('completion: explicit target publishes its finite prefix and fences generation', async () => {
  await fixture(async (store) => {
    const g = await genesis(store, { roomId: '!fixed-completion:test' });
    const write = (body: string) =>
      sendLocal(g.room, {
        type: 'm.room.message',
        sender: g.creator,
        content: { msgtype: 'm.text', body },
      }, g.signer);
    const first = await write('first');
    const target = first.completion!;
    assert(target);
    const second = await write('second');
    await projectThrough(store, target);
    const server = await store.server();
    assertEquals(
      await server.query(
        'SELECT event FROM feed WHERE event IN (?,?) ORDER BY seq',
        [first.eventId, second.eventId],
      ),
      [{ event: first.eventId }],
    );
    assertEquals(
      (await g.room.tx((tx) => tx.completion.state())).completedThrough,
      target.through,
    );
    await assertRejects(
      () =>
        projectThrough(store, { ...target, generation: crypto.randomUUID() }),
      Error,
      'E_COMPLETION_TARGET',
    );
    await assertRejects(
      () =>
        projectThrough(store, {
          ...target,
          through: second.completion!.through,
        }),
      Error,
      'E_COMPLETION_TARGET',
    );
    assertEquals(
      await g.room.tx((tx) => tx.completion.receipt(first.eventId)),
      target,
    );
    await projectThrough(store, second.completion!);
    assertEquals(
      (await server.query('SELECT event FROM feed WHERE event=?', [
        second.eventId,
      ])).length,
      1,
    );
  });
});

Deno.test('completion: callback failure is distinct from publication and retry is idempotent', async () => {
  await fixture(async (store) => {
    const g = await genesis(store, { roomId: '!callback-completion:test' });
    const result = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { msgtype: 'm.text', body: 'callback' },
    }, g.signer);
    const seen: number[] = [];
    const remove = onProjected((owner, id, through) => {
      if (owner === store && id === g.roomId) {
        seen.push(through);
        throw new Error('required callback');
      }
    });
    try {
      await assertRejects(
        () => projectThrough(store, result.completion!),
        AggregateError,
        'E_COMPLETION_CALLBACK',
      );
      const server = await store.server();
      assertEquals(
        (await server.query('SELECT event FROM feed WHERE event=?', [
          result.eventId,
        ])).length,
        1,
      );
      assertEquals(
        (await g.room.tx((tx) => tx.completion.state())).completedThrough,
        0,
      );
      assertEquals(seen, [result.completion!.through]);
    } finally {
      remove();
    }
    await projectThrough(store, result.completion!);
    assertEquals(
      (await g.room.tx((tx) => tx.completion.state())).completedThrough,
      result.completion!.through,
    );
    assertEquals(
      (await (await store.server()).query(
        'SELECT event FROM feed WHERE event=?',
        [result.eventId],
      )).length,
      1,
    );
  });
});

Deno.test('completion: rolled-back acceptance receipt never escapes a later attempt', async () => {
  await fixture(async (store) => {
    const g = await genesis(store, { roomId: '!rollback-completion:test' });
    const db = await store.room(g.roomId);
    await db.execute('DELETE FROM completion_receipts WHERE event=?', [
      g.tipId,
    ]);
    let abandoned: CompletionTarget | undefined;
    await assertRejects(
      () =>
        g.room.tx(async (tx) => {
          abandoned = await tx.completion.record(g.tipId);
          throw new Error('rollback receipt');
        }),
      Error,
      'rollback receipt',
    );
    assertEquals(await g.room.tx((tx) => tx.completion.receipt(g.tipId)), null);
    assert(abandoned);
    await assertRejects(
      () => projectThrough(store, abandoned!),
      Error,
      'E_COMPLETION_TARGET',
    );
    const committed = await g.room.tx((tx) => tx.completion.record(g.tipId));
    await projectThrough(store, committed);
    assertEquals(
      (await db.query('SELECT event FROM completion_receipts WHERE event=?', [
        g.tipId,
      ])).length,
      1,
    );
  });
});

Deno.test('completion: supported v7 upgrade fixes one legacy baseline across reopen and later writes', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'completion-upgrade-' });
  const config = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 16,
    idleseconds: 300,
  };
  const v7 = {
    version: 7,
    apply: async (db: Parameters<typeof roomSchema.apply>[0]) => {
      await roomSchema.apply(db);
      await db.exec(
        'DROP TABLE event_signatures; ALTER TABLE events DROP COLUMN hash_redacted; DROP TABLE completion_receipts; DROP TABLE completion_state;',
      );
    },
  };
  let store = await openStore(config, {
    schemas: { room: v7, server: serverSchema },
  });
  try {
    // Construct legacy room truth without calling v8 domain bindings.
    const db = await store.room('!upgrade-completion:test', { create: true });
    await db.execute("INSERT INTO changes VALUES(1,'legacy',NULL,'{}')");
    await store.close();
    store = await openStore(config, {
      schemas: { room: roomSchema, server: serverSchema },
    });
    const room = await openRoom(store, '!upgrade-completion:test');
    const state = await room.tx((tx) => tx.completion.state());
    assertEquals(state.legacyThrough, 1);
    await room.tx((tx) => tx.changes.append('later', null, {}));
    await store.close();
    store = await openStore(config, {
      schemas: { room: roomSchema, server: serverSchema },
    });
    assertEquals(
      await (await openRoom(store, room.id)).tx((tx) => tx.completion.state()),
      state,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('completion: legacy retry keeps its original grounding witness after a delayed redaction effect', async () => {
  const dir = await Deno.makeTempDir({
    prefix: 'legacy-redaction-completion-',
  });
  const config = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 16,
    idleseconds: 300,
  };
  const schemas = { room: roomSchema, server: serverSchema };
  let store = await openStore(config, { schemas });
  try {
    const g = await genesis(store, {
      roomId: '!legacy-redaction-completion:test',
    });
    const target = await g.room.tx((tx) =>
      buildInTx(tx, g.roomId, {
        type: 'm.room.message',
        sender: g.creator,
        content: { body: 'arrives after upgrade' },
      }, g.signer)
    );
    const redaction = await redactEvent(
      g.room,
      g.creator,
      target.event_id!,
      g.signer,
    );
    const pdu = JSON.parse(
      (await g.room.tx((tx) => tx.events.get(redaction.eventId)))!.pdu,
    );
    const baseline = await g.room.tx((tx) => tx.changes.head());
    assertEquals(
      await g.room.tx((tx) => tx.changes.redactionOf(target.event_id!)),
      null,
    );
    const db = await store.room(g.roomId);
    await db.exec(
      'DROP TABLE event_signatures; ALTER TABLE events DROP COLUMN hash_redacted; DROP TABLE completion_receipts; DROP TABLE completion_state',
    );
    await db.execute("UPDATE meta SET v='7' WHERE k='schema_version'");
    await store.close();
    store = await openStore(config, { schemas });
    const room = await openRoom(store, g.roomId);
    await ingestLocal(room, target, g.signer.serverName);
    assertEquals(
      await room.tx((tx) => tx.changes.redactionOf(target.event_id!)),
      redaction.eventId,
    );
    const effects = await room.tx(async (tx) =>
      (await tx.changes.after(baseline, 100)).filter((change) =>
        change.kind === 'redaction' && change.event === redaction.eventId
      )
    );
    assertEquals(effects.length, 1);
    assert(effects[0].pos > baseline);
    assert(
      (await room.tx((tx) => tx.changes.posOf(redaction.eventId)))! <= baseline,
    );
    let finished = '';
    const result = await sendLocal(
      room,
      { type: 'm.room.message', sender: g.creator, content: {} },
      g.signer,
      {
        lookup: () => Promise.resolve({ eventId: redaction.eventId, pdu }),
        prepare: () => {
          throw new Error('must not reauthor legacy redaction');
        },
        finish: (id) => {
          finished = id;
          return Promise.resolve();
        },
      },
    );
    assertEquals(finished, redaction.eventId);
    assertEquals(result.completion!.through, baseline);
    assertEquals(
      await (await store.room(room.id)).query(
        'SELECT basis FROM completion_receipts WHERE event=?',
        [redaction.eventId],
      ),
      [{ basis: 'legacy-reconciled' }],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('completion: old prepared submission uses its verified fixed upgrade witness, never the later head', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'prepared-upgrade-' });
  const config = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 16,
    idleseconds: 300,
  };
  const schemas = { room: roomSchema, server: serverSchema };
  let store = await openStore(config, { schemas });
  try {
    const g = await genesis(store, { roomId: '!prepared-upgrade:test' });
    const row = (await g.room.tx((tx) => tx.events.get(g.tipId)))!;
    const pdu = JSON.parse(row.pdu);
    const baseline = await g.room.tx((tx) => tx.changes.head());
    const db = await store.room(g.roomId);
    await db.exec(
      'DROP TABLE event_signatures; ALTER TABLE events DROP COLUMN hash_redacted; DROP TABLE completion_receipts; DROP TABLE completion_state',
    );
    await db.execute("UPDATE meta SET v='7' WHERE k='schema_version'");
    await store.close();
    store = await openStore(config, { schemas });
    const room = await openRoom(store, g.roomId);
    const later = await sendLocal(room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { msgtype: 'm.text', body: 'later' },
    }, g.signer);
    let finished = '';
    const submission = {
      lookup: () => Promise.resolve({ eventId: g.tipId, pdu }),
      prepare: () => {
        throw new Error('must not prepare again');
      },
      finish: (id: string) => {
        finished = id;
        return Promise.resolve();
      },
    };
    const retried = await sendLocal(
      room,
      {
        type: 'm.room.message',
        sender: g.creator,
        content: { body: 'not authored' },
      },
      g.signer,
      submission,
    );
    assertEquals(retried.eventId, g.tipId);
    assertEquals(finished, g.tipId);
    assertEquals(retried.completion!.through, baseline);
    assert(later.completion!.through > baseline);
    assertEquals(
      await (await store.room(g.roomId)).query(
        'SELECT basis FROM completion_receipts WHERE event=?',
        [g.tipId],
      ),
      [{ basis: 'legacy-reconciled' }],
    );
    // A verified signature learned after the room commit is an overlay; the
    // retried submission still names the same immutable PDU.
    await (await store.room(g.roomId)).execute(
      'INSERT INTO event_signatures(event,signatures) VALUES(?,?)',
      [
        g.tipId,
        JSON.stringify({ 'peer.test': { 'ed25519:peer': 'learned' } }),
      ],
    );
    const overlaid = await sendLocal(
      room,
      { type: 'm.room.message', sender: g.creator, content: {} },
      g.signer,
      submission,
    );
    assertEquals(overlaid.eventId, g.tipId);
    const wrong = {
      ...submission,
      lookup: () =>
        Promise.resolve({
          eventId: g.tipId,
          pdu: { ...pdu, content: { wrong: true } },
        }),
    };
    await assertRejects(
      () =>
        sendLocal(
          room,
          { type: 'm.room.message', sender: g.creator, content: {} },
          g.signer,
          wrong,
        ),
      Error,
      'E_SUBMISSION_PDU_MISMATCH',
    );
    await (await store.room(g.roomId)).execute(
      'DELETE FROM completion_receipts WHERE event=?',
      [later.eventId],
    );
    const lost = {
      ...submission,
      lookup: () =>
        Promise.resolve({
          eventId: later.eventId,
          pdu: JSON.parse(later.event.pdu),
        }),
    };
    await assertRejects(
      () =>
        sendLocal(
          room,
          { type: 'm.room.message', sender: g.creator, content: {} },
          g.signer,
          lost,
        ),
      Error,
      'E_COMPLETION_LEGACY_CUT',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
