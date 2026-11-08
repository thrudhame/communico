// Persisted delivery outcomes are atomic, including when their peer/door-log
// write fails. Instrument the existing Store capability, not production hooks.
import { assert, assertEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { listPending, recordPending } from '#engine/federation/peers.ts';
import {
  listOutbox,
  peerStatus,
  startSender,
} from '#engine/federation/sender.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { type Conn, operations } from '#engine/store/db.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { startFakeServer } from './federation/fake-server.ts';
import { testRemoteServer, testSigner } from './fixtures/signer.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
} from '#engine/signing-primitives.js';

function failWrite(
  store: Store,
  table: string,
  beforeCommit: () => Promise<void>,
) {
  const original = store.server.bind(store);
  let failed = false;
  let enabled = true;
  store.server = async () => {
    const db = await original();
    return operations(
      (fn, options) =>
        db.tx((conn) =>
          fn(
            new Proxy(conn, {
              get(target, key) {
                if (key === 'execute') {
                  return async (...args: Parameters<Conn['execute']>) => {
                    const result = await target.execute(...args);
                    if (
                      result > 0 &&
                      (args[0].startsWith(`INSERT INTO ${table}`) ||
                        args[0].startsWith(`UPDATE ${table}`))
                    ) {
                      if (enabled) {
                        failed = true;
                        throw new Error(`injected ${table} write failure`);
                      }
                      await beforeCommit();
                    }
                    return result;
                  };
                }
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ), options),
      db.path,
    );
  };
  return {
    failed: () => failed,
    allowWrites: () => {
      enabled = false;
    },
    restore: () => {
      store.server = original;
    },
  };
}

async function waitFor(what: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 25000;
  while (!await what()) {
    assert(Date.now() < deadline, 'sender outcome timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const outcome of ['expiry', '4xx', '5xx', 'success'] as const) {
  for (
    const coalesce of outcome === 'expiry' || outcome === '4xx'
      ? [false, true]
      : [false]
  ) {
    Deno.test(`sender atomicity: ${outcome} ${coalesce ? 'coalesced' : 'new'} record rolls back with outbox`, async () => {
      const dir = await Deno.makeTempDir();
      const store = await openStore({
        dir,
        library: './.native/libturso_ffi.so',
        checkpointlogbytes: 65536,
        maxopenfiles: 8,
        idleseconds: 300,
      }, { schemas: { server: serverSchema } });
      setConfigForTests({
        federation: {
          cacerts: ['tests/fixtures/tls/ca.crt'],
          backoffstartmillihours: 1000,
        },
      });
      resetCaCertsForTests();
      const us = await testRemoteServer('test');
      const key = b64encodeStd(await exportPublicKeyRaw(us.kp.publicKey));
      const fake = await startFakeServer({
        ourKeyDoc: () =>
          Promise.resolve({
            server_name: us.name,
            verify_keys: { [us.keyId]: { key } },
          }),
        handlers: () =>
          Response.json(
            outcome === 'success'
              ? { pdus: {} }
              : { errcode: 'M_FORBIDDEN', error: 'refused' },
            { status: outcome === '4xx' ? 403 : outcome === '5xx' ? 500 : 200 },
          ),
      });
      const signer = await testSigner('test');
      const server = await store.server();
      const table = outcome === 'expiry' || outcome === '4xx'
        ? 'federation_pending'
        : outcome === '5xx'
        ? 'outbox'
        : 'peer_status';
      let unpublished = 0;
      const baseline = async () => ({
        outbox: await listOutbox(server),
        peer: await peerStatus(server, fake.name),
        pending: await listPending(server),
      });
      let before: Awaited<ReturnType<typeof baseline>>;
      const fault = failWrite(store, table, async () => {
        // A second reader still sees the old outcome even after the real
        // peer/refusal write; neither half is published before commit.
        assertEquals(await baseline(), before);
        unpublished++;
      });
      let sender: ReturnType<typeof startSender> | undefined;
      try {
        // Direct server-file fixture: expiry needs no network; sends may carry
        // no PDU if the room has disappeared (the sender's existing behavior).
        for (let pos = 1; pos <= 2; pos++) {
          await server.execute(
            'INSERT INTO feed(seq,room,pos,event,stay) VALUES(?,?,?,?,1)',
            [pos, '!missing:test', pos, `$e${pos}`],
          );
          await server.execute(
            "INSERT INTO outbox(room,pos,destination,event,state,added_ms) VALUES(?,?,?,?,'pending',?)",
            [
              '!missing:test',
              pos,
              fake.name,
              `$e${pos}`,
              outcome === 'expiry' ? Date.now() - 257000 * 3600 : Date.now(),
            ],
          );
        }
        if (coalesce) {
          await recordPending(server, fake.name, 'refused', true, 'earlier');
        }
        before = await baseline();
        sender = startSender({ store, signer });
        await waitFor(fault.failed);
        await sender.stop(); // awaits the failed transaction's rollback
        assertEquals(await listOutbox(server), before.outbox);
        assertEquals(await peerStatus(server, fake.name), before.peer);
        assertEquals(await listPending(server), before.pending);

        fault.allowWrites();
        sender = startSender({ store, signer });
        await waitFor(async () => {
          const rows = await listOutbox(server);
          if (outcome === 'expiry') {
            return rows.every((r) => r.state === 'failed');
          }
          if (outcome === 'success') {
            return rows.every((r) => r.state === 'sent');
          }
          return rows.every((r) => r.attempts === 1);
        });
        await sender.stop();
        assertEquals(unpublished, outcome === '5xx' ? 2 : 1);
        const rows = await listOutbox(server);
        assertEquals(rows.length, 2);
        const peer = await peerStatus(server, fake.name);
        if (outcome === 'expiry' || outcome === '4xx') {
          const pending = await listPending(server);
          assertEquals(pending.length, 1);
          assertEquals(pending[0].kind, 'refused');
          assertEquals(pending[0].count, coalesce ? 2 : 1);
          const detail = JSON.parse(pending[0].detail!);
          assertEquals(detail.expired_rows, outcome === 'expiry' ? 2 : 0);
          assertEquals(detail.last.code, outcome === 'expiry' ? null : 403);
          if (outcome === 'expiry') {
            assert(detail.last.error.includes('expired'));
          }
        }
        if (outcome === '4xx' || outcome === '5xx') {
          assertEquals(peer.failures, 1);
          assertEquals(peer.attemptsTotal, 1);
          assert(
            rows.every((r) =>
              r.state === 'pending' && r.nextAttemptMs === peer.nextAttemptMs
            ),
          );
        }
        if (outcome === 'success') {
          assert(peer.lastSuccessMs !== null);
          assertEquals(peer.attemptsTotal, 1);
          assertEquals(peer.failures, 0);
        }
      } finally {
        await sender?.stop();
        fault.restore();
        await fake.close();
        await store.close();
        await Deno.remove(dir, { recursive: true });
        setConfigForTests({
          federation: { cacerts: [], backoffstartmillihours: 125 },
        });
        resetCaCertsForTests();
      }
    });
  }
}
