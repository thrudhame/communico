import { assert, assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import {
  captureAccountData,
  putAccountData,
} from '#engine/tenant/accountdata.ts';
import { setRuleEnabled } from '#engine/tenant/pushrules.ts';
import {
  receiptContent,
  receiptRows,
  receiptsSince,
} from '#engine/server/ephemeral.ts';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'sliding-streams-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema, server: serverSchema } });
  const tenant = await openTenant(store, 'streams.test', { create: true });
  await tenant.tx(async (tx) => {
    await tx.users.insert('alice', 'Alice');
    await tx.users.insert('bob', 'Bob');
  });
  return {
    tenant,
    server: await store.server(),
    close: async () => {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('sliding streams: captured account bodies, push rules and their maximum share one tenant cut', async () => {
  const f = await fixture();
  try {
    const put = (room: string, type: string, content: unknown) =>
      putAccountData(f.tenant, 'alice', room, type, content);
    const capture = (
      since: number | null,
      rooms?: ReadonlyMap<string, number>,
    ) =>
      f.tenant.tx((tx) =>
        captureAccountData(tx, 'alice', f.tenant.serverName, since, rooms)
      );
    await put('', 'm.direct', { '@bob:streams.test': ['!one:streams.test'] });
    await put('!one:streams.test', 'm.tag', { tags: { favourite: {} } });
    await put('!two:streams.test', 'm.test', { n: 2 });
    await putAccountData(f.tenant, 'bob', '', 'm.secret', { hidden: true });
    const first = await capture(null);
    assertEquals(first.global.map((r) => r.type), ['m.direct', 'm.push_rules']);
    assertEquals([...first.rooms.keys()].sort(), [
      '!one:streams.test',
      '!two:streams.test',
    ]);
    const original = JSON.stringify(first);
    const originalRooms = JSON.stringify([...first.rooms]);
    await put('', 'm.direct', { later: true });
    await put('!one:streams.test', 'm.tag', { tags: {} });
    await setRuleEnabled(f.tenant, 'alice', 'override', '.m.rule.master', true);
    // Slow rendering of a capture never re-reads a mutable latest value.
    assertEquals(JSON.stringify(first), original);
    assertEquals(JSON.stringify([...first.rooms]), originalRooms);
    const next = await capture(first.seq);
    assert(next.seq > first.seq);
    assertEquals(next.global.map((r) => r.type), ['m.direct', 'm.push_rules']);
    assertEquals(next.global[0].content, { later: true });
    const rules = next.global[1].content as {
      global: { override: { rule_id: string; enabled: boolean }[] };
    };
    assertEquals(
      rules.global.override.find((r) => r.rule_id === '.m.rule.master')
        ?.enabled,
      true,
    );
    assertEquals([...next.rooms], [['!one:streams.test', [{
      type: 'm.tag',
      content: { tags: {} },
    }]]]);
    assertEquals((await capture(next.seq)).global, []);
    assertEquals([...(await capture(next.seq)).rooms], []);
    // A room newly entering an extension gets its own initial data, not the
    // connection's advanced global cut. Explicit no-room selection stays empty.
    const reenter = await capture(
      next.seq,
      new Map([['!two:streams.test', 0]]),
    );
    assertEquals([...reenter.rooms], [['!two:streams.test', [{
      type: 'm.test',
      content: { n: 2 },
    }]]]);
    assertEquals([...(await capture(null, new Map())).rooms], []);
    await setRuleEnabled(
      f.tenant,
      'alice',
      'override',
      '.m.rule.master',
      false,
    );
    const pushOnly = await capture(next.seq, new Map());
    assert(pushOnly.seq > next.seq);
    assertEquals(pushOnly.global.map((r) => r.type), ['m.push_rules']);
    assertEquals((await capture(pushOnly.seq)).global, []);
  } finally {
    await f.close();
  }
});

Deno.test('sliding streams: receipt cuts and single-event collisions preserve viewer and thread contracts', async () => {
  const f = await fixture();
  try {
    const room = '!receipts:streams.test', alice = '@alice:streams.test';
    const add = (
      user: string,
      type: string,
      thread: string,
      event: string,
      seq: number,
    ) =>
      f.server.execute(
        'INSERT INTO receipts(room_id,user_id,receipt_type,thread_id,event_id,ts_ms,seq) VALUES(?,?,?,?,?,?,?)',
        [room, user, type, thread, event, seq * 10, seq],
      );
    await add(alice, 'm.read', '', '$same', 1);
    await add(alice, 'm.read', 'main', '$same', 2);
    await add(alice, 'm.read', '$root', '$reply', 3);
    await add(alice, 'm.read.private', '$root', '$reply', 4);
    await add('@bob:streams.test', 'm.read.private', '', '$secret', 5);
    await add('@bob:streams.test', 'm.read', '', '$later', 6);
    const captured = await receiptRows(f.server, room, 0, alice, 5);
    assertEquals(captured.length, 4);
    const content = receiptContent(captured) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    assertEquals(content.$same['m.read'][alice], { ts: 10 });
    assertEquals(content.$reply['m.read'][alice], {
      ts: 30,
      thread_id: '$root',
    });
    assertEquals(content.$reply['m.read.private'][alice], {
      ts: 40,
      thread_id: '$root',
    });
    // Unthreaded wins regardless of row order; two representable threaded
    // slots follow the source's iteration order, matching Synapse MSC4102.
    assertEquals(receiptContent([...captured].reverse()), content);
    const threaded = captured[1];
    assertEquals(
      receiptContent([threaded, { ...threaded, threadId: '$other' }]),
      {
        $same: { 'm.read': { [alice]: { ts: 20, thread_id: '$other' } } },
      },
    );
    assertEquals(
      (await receiptRows(f.server, room, 4, alice, 6)).map((r) => r.eventId),
      ['$later'],
    );
    assertEquals((await receiptRows(f.server, room, 0)).map((r) => r.eventId), [
      '$same',
      '$same',
      '$reply',
      '$later',
    ]);
    // Ordinary sync still has separate thread maps and loses no durable slot.
    const ordinary = await receiptsSince(f.server, room, alice, 0);
    assertEquals(ordinary.length, 3);
    assertEquals((await receiptRows(f.server, room, 0, alice)).length, 5);
    assertEquals(receiptContent([]), {});
  } finally {
    await f.close();
  }
});
