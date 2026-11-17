import { assertEquals, assertRejects } from '@std/assert';
import {
  captureCompletionCut,
  markCompleted,
  validateCompletion,
  validateCompletionCut,
} from '#engine/room/completion.ts';
import { roomSchema } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { serverSchema } from '#engine/server/schema.ts';
import type { Conn } from '#engine/store/db.ts';
import { openStore } from '#engine/store/index.ts';
import { genesis } from '#tests/fixtures/genesis.ts';

Deno.test('completion work: each cut operation captures its authority once without retaining stale facts', async (t) => {
  const dir = await Deno.makeTempDir({ prefix: 'completion-work-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 16,
    idleseconds: 300,
  }, { schemas: { room: roomSchema, server: serverSchema } });
  try {
    const g = await genesis(store, { roomId: '!completion-work:test' });
    const sent = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { msgtype: 'm.text', body: 'fixed authority' },
    }, g.signer);
    const target = sent.completion!;
    const db = await store.room(g.roomId);
    const once = (fn: (conn: Conn) => Promise<unknown>) =>
      db.tx(async (conn) => {
        const queries: string[] = [];
        const observed = new Proxy(conn, {
          get(owner, key) {
            if (key === 'query') {
              return (...args: Parameters<Conn['query']>) => {
                queries.push(args[0]);
                return owner.query(...args);
              };
            }
            const value = Reflect.get(owner, key);
            return typeof value === 'function' ? value.bind(owner) : value;
          },
        });
        await fn(observed);
        assertEquals(queries.length, 1, JSON.stringify(queries));
      });
    await t.step(
      'capture generation and head together',
      () => once((conn) => captureCompletionCut(conn, g.roomId)),
    );
    await t.step(
      'validate a cut from one current snapshot',
      () => once((conn) => validateCompletionCut(conn, target)),
    );
    await t.step(
      'validate an exact receipt in that same snapshot',
      () => once((conn) => validateCompletion(conn, target)),
    );
    await t.step(
      'advance progress using one fresh authority read',
      () =>
        once((conn) => markCompleted(conn, target.generation, target.through)),
    );
    await t.step(
      'later mutations never reuse captured identity or receipts',
      async () => {
        await db.tx(async (conn) => {
          await validateCompletion(conn, target);
          await conn.execute('DELETE FROM completion_receipts WHERE event=?', [
            target.eventId,
          ]);
          await assertRejects(
            () => validateCompletion(conn, target),
            Error,
            'E_COMPLETION_TARGET',
          );
          await conn.execute(
            "INSERT INTO completion_receipts VALUES(?,?,'accepted')",
            [
              target.eventId,
              target.through,
            ],
          );
          await assertRejects(
            () =>
              validateCompletionCut(conn, {
                ...target,
                through: target.through + 1,
              }),
            Error,
            'E_COMPLETION_TARGET',
          );
          await assertRejects(
            () =>
              validateCompletion(conn, {
                ...target,
                generation: 'replacement',
              }),
            Error,
            'E_COMPLETION_TARGET',
          );
          await assertRejects(
            () => markCompleted(conn, 'replacement', target.through),
            Error,
            'E_COMPLETION_PROGRESS',
          );
          await assertRejects(
            () => markCompleted(conn, target.generation, target.through + 1),
            Error,
            'E_COMPLETION_PROGRESS',
          );
        });
      },
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
