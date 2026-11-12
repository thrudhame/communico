// Storage nullability is not the federation wire representation of an optional string.
import { assert, assertEquals, assertThrows } from '@std/assert';
import { eduQueues, eduState } from '#engine/federation/edus.ts';
import { wireEphemeral } from '#engine/federation/ephemeral.ts';
import { presenceContent } from '#engine/federation/peer-json.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { getPresence, setPresence } from '#engine/server/ephemeral.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';

Deno.test('presence wire: producer storage to EDU to remote persistence preserves status absence and empty strings', async () => {
  const dirs = await Promise.all([Deno.makeTempDir(), Deno.makeTempDir()]);
  const stores = await Promise.all(dirs.map((dir) =>
    openStore({
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema } })
  ));
  let stop: (() => Promise<void>) | undefined;
  try {
    const [producer, consumer] = await Promise.all(
      stores.map((s) => s.server()),
    );
    const local = '@alice:origin.test', remote = '@bob:resident.test';
    for (const server of [producer, consumer]) {
      for (const user of [local, remote]) {
        await server.execute('INSERT INTO memberships VALUES(?,?,?,?,?)', [
          user,
          '!presence:origin.test',
          'join',
          '$join',
          1,
        ]);
      }
    }
    let wake: (() => void) | undefined;
    const queues = eduQueues((u) => u.endsWith(':origin.test'), () => wake?.());
    stop = wireEphemeral(producer, 'origin.test', queues);
    const receiver = eduState(consumer, 'resident.test', stores[1]);
    for (
      const [presence, status] of [
        ['online', 'first status'],
        ['unavailable', undefined],
        ['offline', ''],
        ['online', undefined],
      ] as const
    ) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const queued = new Promise<void>((resolve, reject) => {
        wake = resolve;
        timer = setTimeout(
          () => reject(new Error('presence producer did not queue')),
          5000,
        );
      });
      try {
        await setPresence(producer, local, presence, status);
        await queued;
      } finally {
        clearTimeout(timer);
        wake = undefined;
      }
      const source = await getPresence(producer, local);
      assertEquals(source.statusMsg, status ?? null);
      const edus = queues.drain('resident.test', 100);
      assertEquals(edus.length, 1);
      const push = (edus[0].content.push as Record<string, unknown>[])[0];
      assertEquals(Object.hasOwn(push, 'status_msg'), status !== undefined);
      assertEquals(push.status_msg, status);
      assert(Number.isSafeInteger(push.last_active_ago));
      await receiver.dispatch('origin.test', edus[0]);
      const received = await getPresence(consumer, local);
      assertEquals(received.presence, presence);
      assertEquals(received.statusMsg, status ?? null);
      assert(received.seq > 0);
    }
  } finally {
    await stop?.();
    await Promise.all(stores.map((s) => s.close()));
    await Promise.all(dirs.map((dir) => Deno.remove(dir, { recursive: true })));
  }
});

Deno.test('presence wire: the consumer still rejects explicit null strings and absent required activity age', () => {
  const valid = {
    user_id: '@alice:origin.test',
    presence: 'unavailable',
    last_active_ago: 0,
  };
  assertEquals(presenceContent(valid).status, undefined);
  assertEquals(presenceContent({ ...valid, status_msg: '' }).status, '');
  assertThrows(
    () => presenceContent({ ...valid, status_msg: null }),
    UpstreamError,
  );
  const { last_active_ago: _age, ...missing } = valid;
  assertThrows(() => presenceContent(missing), UpstreamError);
});
