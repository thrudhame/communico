import { assertEquals, assertRejects } from '@std/assert';
import { Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';
import type { SchemaProvider } from '#engine/store/create.ts';
import { roomSchema } from '#engine/room/schema.ts';
import { insertEvent, setStatus } from '#engine/room/events.ts';
import {
  newGroup,
  setCurrent,
  setEventState,
} from '#engine/room/materialize.ts';
import { addWait, deferWait } from '#engine/room/waits.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { advanceNotificationRead } from '#engine/server/notifications.ts';
import { tenantSchema } from '#engine/tenant/schema.ts';
import { acknowledge, acknowledgeSliding } from '#engine/tenant/todevice.ts';
import { encodeStreamToken } from '#engine/client/tokens.ts';
import { hashToken } from '#engine/tenant/auth.ts';

async function withDb(schema: SchemaProvider, fn: (db: Db) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  const db = await Db.open(ffi, dir + '/data.db', 65536);
  try {
    await schema.apply(db);
    await fn(db);
  } finally {
    await db.close();
    ffi.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function measure(db: Db, owner: string, fn: () => Promise<void>) {
  const execute = db.ffi.execute.bind(db.ffi);
  const writes: Record<string, number> = {};
  db.ffi.execute = async (...args: Parameters<Turso['execute']>) => {
    const n = await execute(...args);
    const table = /^(?:INSERT INTO|UPDATE) (\w+)/.exec(args[1])?.[1];
    if (table) writes[table] = (writes[table] ?? 0) + n;
    return n;
  };
  const start = performance.now();
  try {
    await fn();
  } finally {
    db.ffi.execute = execute;
  }
  console.log(
    JSON.stringify({ owner, writes, elapsed_ms: performance.now() - start }),
  );
  return writes;
}

Deno.test('hot-path work: repeated and regressing notification horizons do not rewrite the row', () =>
  withDb(serverSchema, async (db) => {
    for (const pos of [1, 2]) {
      await db.execute(
        "INSERT INTO event_index(event,room,pos,standing,grounding,seq) VALUES(?,'!r:test',?,'accepted','grounded',?)",
        ['$' + pos, pos, pos],
      );
    }
    await db.tx((tx) =>
      advanceNotificationRead(tx, '@a:test', '!r:test', '', '$2', 100)
    );
    const writes = await measure(
      db,
      'notification horizon replay',
      async () => {
        await db.tx((tx) =>
          advanceNotificationRead(tx, '@a:test', '!r:test', '', '$2', 200)
        );
        await db.tx((tx) =>
          advanceNotificationRead(tx, '@a:test', '!r:test', '', '$1', 300)
        );
      },
    );
    assertEquals(
      await db.query('SELECT event_seq FROM notification_horizons'),
      [{ event_seq: 2 }],
    );
    assertEquals(writes.notification_horizons, 0);
    // A newly reconciled unread fact behind an old horizon must still be read.
    await db.execute(
      "INSERT INTO notifications VALUES(1,'test','@a:test','$1','!r:test',1,'main','[]',0,0,NULL,1)",
    );
    await db.tx((tx) =>
      advanceNotificationRead(tx, '@a:test', '!r:test', '', '$1', 400)
    );
    assertEquals(await db.query('SELECT read_ms FROM notifications'), [{
      read_ms: 400,
    }]);
  }));

Deno.test('hot-path work: ordinary and sliding inbox acknowledgments only persist an advancing issued cut', () =>
  withDb(tenantSchema, async (db) => {
    const device = { localpart: 'a', deviceId: 'PHONE', generation: 7 };
    const token = {
      eSeq: 0,
      pSeq: 0,
      tSeq: 0,
      rSeq: 0,
      aSeq: 0,
      dSeq: 0,
      mSeq: 1,
      kSeq: 0,
    };
    await db.exec(
      "INSERT INTO users(localpart) VALUES('a'); INSERT INTO devices VALUES('PHONE','a',7,NULL); INSERT INTO counters VALUES('to_device',2)",
    );
    await db.tx((tx) => acknowledge(tx, device, null));
    const writes = await measure(
      db,
      'ordinary/sliding ack replay',
      async () => {
        await db.tx((tx) => acknowledge(tx, device, null));
        await db.tx((tx) => acknowledgeSliding(tx, device, 'room-list', null));
      },
    );
    assertEquals(await db.query('SELECT msg_pos FROM device_ack'), [{
      msg_pos: 0,
    }]);
    const tokenHash = await hashToken(encodeStreamToken(token));
    await db.execute("INSERT INTO sync_deliveries VALUES('a','PHONE',7,?,1)", [
      tokenHash,
    ]);
    for (const pos of [1, 2]) {
      await db.execute(
        "INSERT INTO to_device_inbox VALUES('a','PHONE',7,?,?, '{}')",
        [pos, 'source-' + pos],
      );
    }
    await db.tx((tx) => acknowledge(tx, device, token));
    await db.tx((tx) => acknowledge(tx, device, token));
    await db.tx((tx) => acknowledge(tx, device, { ...token, mSeq: 2 }));
    assertEquals(await db.query('SELECT msg_pos FROM device_ack'), [{
      msg_pos: 1,
    }]);
    assertEquals(await db.query('SELECT msg_pos FROM to_device_inbox'), [{
      msg_pos: 2,
    }]);
    assertEquals(writes.device_ack, 0);
  }));

Deno.test('hot-path work: room status and state retries preserve null transitions without rewriting equal rows', () =>
  withDb(roomSchema, async (db) => {
    const status = {
      standing: 'accepted' as const,
      grounding: 'evidence' as const,
      origin: null,
      received_ts: 1,
    };
    await db.tx(async (tx) => {
      await insertEvent(
        tx,
        '$e',
        JSON.stringify({
          type: 'm.room.message',
          sender: '@a:test',
          depth: 1,
          origin_server_ts: 1,
          content: {},
        }),
      );
      await setStatus(tx, '$e', status);
      await setEventState(tx, '$e', null, null, 'none');
    });
    const writes = await measure(db, 'room status/state replay', async () => {
      await db.tx(async (tx) => {
        await setStatus(tx, '$e', status);
        await setEventState(tx, '$e', null, null, 'none');
      });
    });
    await db.tx(async (tx) => {
      const group = await newGroup(tx, null, []);
      await setEventState(tx, '$e', group, group, 'dag');
      await setStatus(tx, '$e', {
        ...status,
        grounding: 'grounded',
        origin: 'peer.test',
      });
      assertEquals(
        (await tx.query(
          'SELECT before_group,after_group,provenance FROM event_state',
        ))[0],
        { before_group: group, after_group: group, provenance: 'dag' },
      );
      assertEquals(
        (await tx.query('SELECT origin,grounding FROM event_status'))[0],
        { origin: 'peer.test', grounding: 'grounded' },
      );
    });
    assertEquals(writes, { event_status: 0, event_state: 0 });
  }));

Deno.test('hot-path work: unchanged current state and retained wait retries do not rewrite rows', () =>
  withDb(roomSchema, async (db) => {
    const wait = {
      missing: '$missing',
      waiting: '$waiting',
      kind: 'prev',
      since: 1,
      expires: null,
      state: 'pending',
    };
    let group: number;
    await db.tx(async (tx) => {
      group = await newGroup(tx, null, []);
      await tx.execute(
        "INSERT INTO segments(id,kind,current_group,status) VALUES(1,'stay',?,'open')",
        [group],
      );
      await addWait(tx, wait);
    });
    const writes = await measure(db, 'room current/wait replay', async () => {
      await db.tx(async (tx) => {
        await setCurrent(tx, 1, group);
        await addWait(tx, wait);
        await deferWait(tx, wait);
      });
    });
    await assertRejects(
      () => db.tx((tx) => setCurrent(tx, 2, group)),
      Error,
      'unknown stay 2',
    );
    await db.tx((tx) => addWait(tx, { ...wait, expires: 200 }));
    assertEquals(await db.query('SELECT expires FROM waits'), [{
      expires: 200,
    }]);
    assertEquals(writes, { segments: 0, waits: 0 });
  }));

Deno.test('hot-path work: readding an eligible wait never cycles ready through pending', () =>
  withDb(roomSchema, async (db) => {
    const wait = {
      missing: '$held',
      waiting: '$child',
      kind: 'prev',
      since: 1,
      expires: null,
      state: 'pending',
    };
    await db.tx(async (tx) => {
      await insertEvent(
        tx,
        '$held',
        JSON.stringify({
          type: 'm.room.message',
          sender: '@a:test',
          depth: 1,
          origin_server_ts: 1,
          content: {},
        }),
      );
      await setStatus(tx, '$held', {
        standing: 'accepted',
        grounding: 'grounded',
        origin: null,
        received_ts: 1,
      });
      await addWait(tx, wait);
    });
    const writes = await measure(db, 'eligible wait replay', async () => {
      await db.tx((tx) => addWait(tx, wait));
    });
    assertEquals(await db.query('SELECT state FROM waits'), [{
      state: 'ready',
    }]);
    assertEquals(writes.waits, 0);
  }));
