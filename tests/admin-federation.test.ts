import { assert, assertEquals } from '@std/assert';
import { startAdmin } from '#root/api/admin/index.ts';
import { startFederationServices } from '#engine/app.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { recordPending } from '#engine/federation/peers.ts';
import { ourKeyDocument } from '#engine/federation/keys.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { startHttp } from '#tests/http-app.ts';
import { adminCall } from '#tests/admin-client.ts';
import { genesis } from '#tests/fixtures/genesis.ts';
import { startFakeServer } from '#tests/federation/fake-server.ts';

Deno.test('admin federation operations cross the socket and affect their consumers', async (t) => {
  const dir = await Deno.makeTempDir();
  const http = await startHttp();
  const app = http.app;
  const admin = await startAdmin(app, `${dir}/a.sock`);
  const call = async (op: string, body: unknown = {}) => {
    const result = await adminCall(admin.path, op, body);
    assertEquals(result.status, 200, JSON.stringify(result));
    assert(result.body.ok);
    return result.body.result;
  };
  try {
    await t.step(
      'block add/list/remove changes federation HTTP admission',
      async () => {
        await call('federation-block/add', {
          pattern: '*.evil.test',
          note: 'operator',
        });
        assertEquals(
          (await call('federation-block/list'))[0].pattern,
          '*.evil.test',
        );
        const res = await http.matrix(
          new Request('http://localhost/_matrix/federation/v1/query/nope', {
            headers: {
              authorization:
                'X-Matrix origin="x.evil.test",key="ed25519:1",sig="AAAA"',
            },
          }),
        );
        assertEquals(res.status, 403);
        await res.body?.cancel();
        assertEquals(
          await call('federation-block/remove', { pattern: '*.evil.test' }),
          true,
        );
        assertEquals(await call('federation-block/list'), []);
        assertEquals(
          await call('federation-block/remove', { pattern: '*.evil.test' }),
          false,
        );
      },
    );
    await t.step(
      'peer add/remove and pending approve/reject preserve door semantics',
      async () => {
        await call('federation-peer/add', {
          name: 'one.test',
          host: '127.0.0.1',
          port: 8448,
          trust: 'pinned',
          pin: 'abcd',
        });
        const peers = await call('federation-peer/list');
        assertEquals(peers[0].added_by, 'operator');
        assertEquals(peers[0].pin_spki_sha256, 'abcd');
        assertEquals(
          await call('federation-peer/remove', { name: 'one.test' }),
          true,
        );
        await recordPending(app.server, 'knock.test', 'inbound', false, '/x');
        assertEquals((await call('federation-peer/pending')).length, 1);
        await call('federation-peer/approve', {
          name: 'knock.test',
          host: '127.0.0.1',
          port: 8449,
        });
        assertEquals(await call('federation-peer/pending'), []);
        assertEquals(
          (await call('federation-peer/list'))[0].added_by,
          'approval',
        );
        await recordPending(app.server, 'no.test', 'inbound', false, '/x');
        await call('federation-peer/reject', { name: 'no.test', block: true });
        assertEquals(await call('federation-peer/pending'), []);
        assert(
          (await call('federation-block/list')).some((b: { pattern: string }) =>
            b.pattern === 'no.test'
          ),
        );
        await recordPending(
          app.server,
          'refused.test',
          'refused',
          true,
          'delivery',
        );
        const refusal = await adminCall(admin.path, 'federation-peer/approve', {
          name: 'refused.test',
        });
        assertEquals(refusal.status, 400);
        assertEquals(refusal.body.error.code, 'M_INVALID_PARAM');
        assertEquals(
          (await adminCall(admin.path, 'federation-peer/add', {
            name: 'bad',
            trust: 'invalid',
          })).status,
          400,
        );
      },
    );
    await t.step(
      'key list/accept/forget changes admission and remembered material',
      async () => {
        const doc = {
          server_name: 'changed.test',
          verify_keys: { 'ed25519:new': { key: 'new' } },
          old_verify_keys: {},
          valid_until_ts: Date.now() + 10000,
          signatures: {},
        };
        await app.server.execute(
          "INSERT INTO server_key_changes(server_name,seen_ms,old_keys,new_keys,status,acknowledged_old,candidate_json) VALUES(?,1,'{}','{}','blocking',0,?)",
          ['changed.test', JSON.stringify({ via: 'direct', doc })],
        );
        assertEquals(
          (await call('federation-key/list', { name: 'changed.test' }))
            .changes[0].status,
          'blocking',
        );
        assertEquals(
          await call('federation-key/accept', { name: 'changed.test' }),
          true,
        );
        const accepted = await call('federation-key/list', {
          name: 'changed.test',
        });
        assertEquals(accepted.servers[0].rows[0].pubkey_b64, 'new');
        assertEquals(accepted.changes[0].status, 'accepted');
        assertEquals(
          await call('federation-key/accept', { name: 'changed.test' }),
          false,
        );
        await call('federation-key/forget', { name: 'changed.test' });
        assertEquals(
          (await call('federation-key/list', { name: 'changed.test' }))
            .servers[0].rows,
          [],
        );
      },
    );
    await t.step(
      'outbox retry wakes live sender, snapshot is real and prune removes work',
      async () => {
        setConfigForTests({
          federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
        });
        resetCaCertsForTests();
        let release!: () => void;
        let received!: () => void;
        const held = new Promise<void>((resolve) => release = resolve);
        const seen = new Promise<void>((resolve) => received = resolve);
        const fake = await startFakeServer({
          ourKeyDoc: () =>
            ourKeyDocument(app.tenant.signer(), app.tenant.publicB64),
          handlers: (request) => {
            if (!request.url.pathname.includes('/send/')) return null;
            const body = request.json() as { pdus: unknown[] };
            assertEquals(body.pdus.length, 1);
            received();
            return held.then(() => Response.json({ pdus: {} }));
          },
        });
        try {
          const g = await genesis(app.store, {
            roomId: '!admin-delivery:test',
          });
          await app.server.execute(
            "INSERT INTO outbox(room,pos,destination,event,state,added_ms,next_attempt_ms) VALUES(?,999,?,?,'pending',?,?)",
            [g.roomId, fake.name, g.tipId, Date.now(), Date.now() + 600000],
          );
          await app.server.execute(
            'INSERT INTO peer_status(destination,failures,next_attempt_ms) VALUES(?,4,?)',
            [fake.name, Date.now() + 600000],
          );
          startFederationServices(app);
          const before = await call('federation-outbox/list', {
            destination: fake.name,
          });
          assertEquals(before.rows[0].id, `${g.roomId}:999`);
          assertEquals(before.rows[0].inflightTxn, null);
          await call('federation-outbox/retry', { destination: fake.name });
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              seen,
              new Promise((_, reject) =>
                timer = setTimeout(
                  () => reject(new Error('delivery timeout')),
                  5000,
                )
              ),
            ]);
          } finally {
            clearTimeout(timer);
          }
          const during = await call('federation-outbox/list', {
            destination: fake.name,
          });
          assert(typeof during.rows[0].inflightTxn === 'string');
          release();
          const deadline = Date.now() + 5000;
          while (
            (await call('federation-outbox/list', { destination: fake.name }))
              .rows.length
          ) {
            assert(Date.now() < deadline);
            await new Promise((r) => setTimeout(r, 10));
          }
          await app.sender!.stop();
          app.sender = null;
          await app.server.execute(
            "INSERT INTO outbox(room,pos,destination,event,state,added_ms) VALUES(?,1000,?,?,'pending',?)",
            [g.roomId, fake.name, g.tipId, Date.now()],
          );
          assertEquals(
            await call('federation-outbox/prune', { destination: fake.name }),
            2,
          );
          assertEquals(
            (await call('federation-outbox/list', { destination: fake.name }))
              .rows,
            [],
          );
        } finally {
          release();
          await app.sender?.stop();
          app.sender = null;
          await fake.close();
          setConfigForTests({});
          resetCaCertsForTests();
        }
      },
    );
    await t.step(
      'reject-invite jobs are visible and operator prune settles them',
      async () => {
        await app.server.execute(
          "INSERT INTO prejoin_memberships(room_id,user_id,event_id,room_version,event_json,invite_room_state,origin,received_ms,status,seq) VALUES('!invite|part:remote','@a:localhost','$invite','11','{}','[]','remote.test',1,'rejecting',1)",
        );
        const review = await call('federation-outbox/list', {
          destination: 'remote.test',
        });
        assertEquals(review.rows[0].kind, 'intent');
        assertEquals(review.rows[0].intent.what, 'reject-invite');
        assertEquals(
          await call('federation-outbox/prune', { destination: 'remote.test' }),
          1,
        );
        assertEquals(
          (await call('federation-outbox/list', { destination: 'remote.test' }))
            .rows,
          [],
        );
        assertEquals(
          (await app.server.query(
            "SELECT status FROM prejoin_memberships WHERE room_id='!invite|part:remote'",
          ))[0].status,
          'rejected',
        );
      },
    );
    await t.step(
      'outbox destination selects statuses as well as queued work',
      async () => {
        await call('federation-outbox/retry', { destination: 'selected.test' });
        await call('federation-outbox/retry', {
          destination: 'status-only.test',
        });
        const selected = await call('federation-outbox/list', {
          destination: 'selected.test',
        });
        assertEquals(
          selected.statuses.map((s: { destination: string }) => s.destination),
          ['selected.test'],
        );
        for (const body of [{}, { destination: null }]) {
          const all = await call('federation-outbox/list', body);
          assert(
            all.statuses.some((s: { destination: string }) =>
              s.destination === 'status-only.test'
            ),
          );
        }
      },
    );
    await t.step(
      'real outbox CLI preserves future retry and expired age',
      async () => {
        const now = Date.now();
        await app.server.execute(
          'INSERT INTO peer_status(destination,next_attempt_ms,unreachable_since_ms) VALUES(?,?,?)',
          ['clock.test', now + 125000, now - 125000],
        );
        await app.server.execute(
          "INSERT INTO outbox(room,pos,destination,event,state,added_ms) VALUES('!clock:test',1,'clock.test','$clock','pending',?)",
          [now - 125000 - config().federation.refusedmillihours * 3600],
        );
        const out = await new Deno.Command(Deno.execPath(), {
          args: [
            'run',
            '--allow-env',
            '--allow-read',
            '--allow-write',
            '--allow-net',
            'tools/federation-outbox.ts',
            'list',
            'clock.test',
          ],
          env: { COMMUNICO_ADMIN_SOCKET: admin.path },
          stdout: 'piped',
          stderr: 'piped',
        }).output();
        assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
        const text = new TextDecoder().decode(out.stdout);
        assert(text.includes('next attempt in 2m'), text);
        assert(text.includes('expired 2m ago'), text);
        assert(!text.includes('from now'), text);
      },
    );
  } finally {
    await admin.shutdown();
    await http.close();
    await Deno.remove(dir, { recursive: true });
  }
});
