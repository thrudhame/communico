// tests/federation-client.test.ts — the signed outbound client against
// the fake remote server (real TLS, fixture CA): header grammar,
// destination sent, Content-Type on bodies, Matrix error passthrough,
// connect timeout → 502, the resolver's explicit-port and roster
// round trips (doltgres tests/federation-client.test.ts, restored) —
// and the node:tls dialer: pinned peers match the roster SPKI hash,
// key-is-name peers the raw 32-byte key equality, mismatches a 502
// before any request bytes are written (doltgres
// tests/federation-dial.test.ts, restored).
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from '@std/assert';
import { createHash, X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import { config, setConfigForTests } from '#engine/config.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { addPeer, removePeer } from '#engine/federation/peers.ts';
import { resetWellKnownCache, resolve } from '#engine/federation/resolve.ts';
import {
  FederationHttpError,
  federationRequest,
  federationRequestRaw,
  resetCaCertsForTests,
} from '#engine/federation/client.ts';
import {
  b32encode,
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
} from '#engine/signing-primitives.js';
import type { Signer } from '#engine/room/signer.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { randomSigner } from './fixtures/signer.ts';
import { type FakeServer, startFakeServer } from './federation/fake-server.ts';

async function withStore(
  fn: (store: Store) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore(
    {
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    },
    { schemas: { server: serverSchema } },
  );
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

type Identity = { signer: Signer; doc: Record<string, unknown> };

async function makeIdentity(name: string): Promise<Identity> {
  const { signer, publicKey } = await randomSigner(name);
  return {
    signer,
    doc: {
      server_name: name,
      verify_keys: {
        [signer.keyId]: {
          key: b64encodeStd(await exportPublicKeyRaw(publicKey)),
        },
      },
      old_verify_keys: {},
      valid_until_ts: Date.now() + 86400_000,
      signatures: {},
    },
  };
}

async function withFake<T>(
  identity: Identity,
  fn: (fake: FakeServer) => Promise<T>,
  handlers?: Parameters<typeof startFakeServer>[0]['handlers'],
): Promise<T> {
  setConfigForTests({
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  resetCaCertsForTests();
  const fake = await startFakeServer({
    ourKeyDoc: () => Promise.resolve(identity.doc),
    handlers,
  });
  try {
    return await fn(fake);
  } finally {
    await fake.close();
    setConfigForTests({ federation: { cacerts: [] } });
    resetCaCertsForTests();
  }
}

Deno.test('client: certificate material is acquired only for leaf-key trust', async () => {
  const identity = await makeIdentity('certificate-material.test');
  const pem = await Deno.readTextFile('tests/fixtures/tls/localhost.crt');
  await withStore(async (store) => {
    await withFake(identity, async (fake) => {
      const server = await store.server();
      for (const kind of ['ca', 'pinned'] as const) {
        await addPeer(server, {
          name: 'localhost',
          host: '127.0.0.1',
          port: fake.port,
          trust: kind,
          ...(kind === 'pinned' ? { pin: pinOf(pem) } : {}),
          addedBy: 'operator',
        });
        let postHandshakeCalls = 0;
        const connect = tls.connect;
        // Leave the runtime's chain/hostname validation untouched. Intercept
        // only work the consumer requests after secureConnect has fired.
        tls.connect = ((...args: Parameters<typeof tls.connect>) => {
          const socket = connect(...args);
          socket.prependOnceListener('secureConnect', () => {
            const getPeerCertificate = socket.getPeerCertificate.bind(socket);
            socket.getPeerCertificate = ((detailed?: boolean) => {
              postHandshakeCalls++;
              if (kind === 'ca' || detailed === true) {
                throw new Error('unneeded post-handshake certificate chain');
              }
              return getPeerCertificate(detailed);
            }) as tls.TLSSocket['getPeerCertificate'];
          });
          return socket;
        }) as typeof tls.connect;
        try {
          const before = fake.requests.length;
          const response = await federationRequest(server, identity.signer, {
            destination: 'localhost',
            method: 'GET',
            path: '/_matrix/key/v2/server',
            body: null,
          });
          assertEquals(response.status, 200);
          assertEquals(fake.requests.length, before + 1);
          assert(fake.requests.at(-1)!.verified);
          assertEquals(postHandshakeCalls, kind === 'ca' ? 0 : 1);
        } finally {
          tls.connect = connect;
          await removePeer(server, 'localhost');
        }
      }
    });
  });
});

Deno.test('client: CA root expansion belongs to the configured trust snapshot', async () => {
  const identity = await makeIdentity('roots.test');
  await withStore(async (store) => {
    await withFake(identity, async (fake) => {
      const server = await store.server();
      const getRoots = tls.getCACertificates;
      let reads = 0;
      tls.getCACertificates = ((type) => {
        reads++;
        return getRoots(type);
      }) as typeof getRoots;
      try {
        const start = performance.now();
        for (let i = 0; i < 10; i++) {
          const response = await federationRequest(server, identity.signer, {
            destination: `localhost:${fake.port}`,
            method: 'GET',
            path: '/_matrix/key/v2/server',
            body: null,
          });
          assertEquals(response.status, 200);
        }
        console.log(
          JSON.stringify({
            tlsRequests: 10,
            elapsedMs: performance.now() - start,
            rootReads: reads,
          }),
        );
        assertEquals(
          reads,
          2,
          'bundled/system roots expanded once per trust snapshot',
        );
        resetCaCertsForTests();
        const response = await federationRequest(server, identity.signer, {
          destination: `localhost:${fake.port}`,
          method: 'GET',
          path: '/_matrix/key/v2/server',
          body: null,
        });
        assertEquals(response.status, 200);
        assertEquals(reads, 4, 'reset creates a new trust snapshot');
      } finally {
        tls.getCACertificates = getRoots;
      }
    });
  });
});

Deno.test('client: raw streaming shares verified signing and completed-error provenance', async () => {
  const identity = await makeIdentity('raw.test');
  const bytes = new Uint8Array(100000).fill(93);
  await withStore(async (store) => {
    await withFake(
      identity,
      async (fake) => {
        const server = await store.server();
        let received = 0;
        const res = await federationRequestRaw(server, identity.signer, {
          destination: `localhost:${fake.port}`,
          method: 'GET',
          path: '/raw',
          body: null,
          sink: (status, headers) => {
            assertEquals(status, 200);
            assertEquals(
              headers.get('content-type'),
              'application/octet-stream',
            );
            return new WritableStream<Uint8Array>({
              write: (part) => {
                assert(part.every((byte) => byte === 93));
                received += part.length;
              },
            });
          },
        });
        assertEquals(received, bytes.length);
        assertEquals(res.body.length, 0);
        assertEquals(fake.requests.at(-1)!.verified, true);
        let opened = false;
        const err = await assertRejects(
          () =>
            federationRequestRaw(server, identity.signer, {
              destination: `localhost:${fake.port}`,
              method: 'GET',
              path: '/missing',
              body: null,
              sink: () => {
                opened = true;
                return new WritableStream();
              },
            }),
          FederationHttpError,
        );
        assertEquals(err.remoteStatus, 404);
        assertEquals(err.errcode, 'M_UNRECOGNIZED');
        assertEquals(
          opened,
          false,
          'error JSON is never written to a media sink',
        );
      },
      (req) =>
        req.url.pathname === '/raw'
          ? new Response(bytes, {
            headers: { 'Content-Type': 'application/octet-stream' },
          })
          : null,
    );
  });
});

Deno.test('client: total deadline includes a blocked raw sink', async () => {
  const identity = await makeIdentity('raw-timeout.test');
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await withStore(async (store) => {
    const server = await store.server();
    await withFake(identity, async (fake) => {
      const previous = config().federation.timeoutms;
      setConfigForTests({
        federation: { timeoutms: 200, cacerts: ['tests/fixtures/tls/ca.crt'] },
      });
      const started = Date.now();
      try {
        const error = await assertRejects(
          () =>
            federationRequestRaw(server, identity.signer, {
              destination: `localhost:${fake.port}`,
              method: 'GET',
              path: '/raw',
              body: null,
              sink: () =>
                new WritableStream<Uint8Array>({ write: () => blocked }),
            }),
          UpstreamError,
        );
        assert(error.message.includes('timeout'), error.message);
        assert(Date.now() - started < 2000);
      } finally {
        release();
        setConfigForTests({ federation: { timeoutms: previous } });
      }
    }, (req) => req.url.pathname === '/raw' ? new Response('bytes') : null);
  });
});

Deno.test('client: valid TLS cannot rename protocol or local sink failures to transport', async () => {
  const identity = await makeIdentity('sink-errors.test');
  await withStore(async (store) => {
    await withFake(identity, async (fake) => {
      const server = await store.server();
      for (
        const fault of [
          new Error('disk full'),
          new UpstreamError('protocol', {
            phase: 'media-multipart',
            reason: 'invalid envelope',
          }),
        ]
      ) {
        const result = await federationRequestRaw(server, identity.signer, {
          destination: `localhost:${fake.port}`,
          method: 'GET',
          path: '/bytes',
          body: null,
          sink: () =>
            new WritableStream({
              write() {
                throw fault;
              },
            }),
        }).catch((e) => e);
        assertStrictEquals(result, fault);
      }
    }, (req) => req.path === '/bytes' ? new Response('bytes') : null);
  });
});

Deno.test('client: GET to the fake verifies — header grammar, destination, no body type', async () => {
  const identity = await makeIdentity('client1.test');
  await withStore(async (store) => {
    await withFake(identity, async (fake) => {
      const res = await federationRequest(
        await store.server(),
        identity.signer,
        {
          destination: `localhost:${fake.port}`,
          method: 'GET',
          path: '/_matrix/key/v2/server',
          body: null,
        },
      );
      assertEquals(res.status, 200);
      const last = fake.requests[fake.requests.length - 1];
      assertEquals(last.method, 'GET');
      assertEquals(last.verified, true);
      const doc = res.json as Record<string, unknown>;
      assertEquals(doc.server_name, `localhost:${fake.port}`);
    });
  });
});

Deno.test('client: POST carries Content-Type and signs the content', async () => {
  const identity = await makeIdentity('client2.test');
  await withStore(async (store) => {
    await withFake(identity, async (fake) => {
      const body = new TextEncoder().encode('{"x":1}');
      const err = await federationRequest(
        await store.server(),
        identity.signer,
        {
          destination: `localhost:${fake.port}`,
          method: 'POST',
          path: '/whatever',
          body,
        },
      ).then(() => 'ok', (e: unknown) => e);
      assert(err instanceof FederationHttpError);
      assertEquals(err.status, 404);
      const last = fake.requests[fake.requests.length - 1];
      assertEquals(last.method, 'POST');
      const gotBody = last.body;
      assert(gotBody !== null);
      assertEquals(new TextDecoder().decode(gotBody), '{"x":1}');
      assertEquals(last.verified, true);
    });
  });
});

Deno.test('client: a Matrix error body passes through with its own status and errcode', async () => {
  const identity = await makeIdentity('client3.test');
  await withStore(async (store) => {
    await withFake(identity, async (fake) => {
      const err = await federationRequest(
        await store.server(),
        identity.signer,
        {
          destination: `localhost:${fake.port}`,
          method: 'GET',
          path: '/nothing-real',
          body: null,
        },
      ).then(
        () => 'resolved',
        (e) => e as FederationHttpError,
      );
      assert(err instanceof FederationHttpError);
      assertEquals(err.status, 404);
      assertEquals(err.errcode, 'M_UNRECOGNIZED');
    });
  });
});

Deno.test('client: connect timeout → 502 within connectms + margin', async () => {
  const identity = await makeIdentity('client4.test');
  setConfigForTests({ federation: { connectms: 300 } });
  await withStore(async (store) => {
    const t0 = Date.now();
    const err = await federationRequest(await store.server(), identity.signer, {
      destination: '10.255.255.1:8448',
      method: 'GET',
      path: '/x',
      body: null,
    }).then(() => 'ok', (e: unknown) => e);
    const ms = Date.now() - t0;
    assert(err instanceof UpstreamError);
    assertEquals(err.category, 'transport');
    assert(ms < 3000, `took ${ms}ms`);
  });
  setConfigForTests({ federation: { connectms: 5000 } });
});

Deno.test('resolver round trip: explicit port against the fake', async () => {
  const identity = await makeIdentity('client5.test');
  await withStore(async (store) => {
    await withFake(identity, async (fake) => {
      const ep = await resolve(await store.server(), `localhost:${fake.port}`);
      assertEquals(ep.port, fake.port);
      const res = await federationRequest(
        await store.server(),
        identity.signer,
        {
          destination: `localhost:${fake.port}`,
          method: 'GET',
          path: '/_matrix/key/v2/server',
          body: null,
        },
      );
      assertEquals(res.status, 200);
    });
  });
});

Deno.test('resolver round trip: roster override connects; identity stays the server name', async () => {
  const identity = await makeIdentity('client6.test');
  await withStore(async (store) => {
    await withFake(identity, async (fake) => {
      const server = await store.server();
      await addPeer(server, {
        name: 'localhost',
        host: '127.0.0.1',
        port: fake.port,
        trust: 'ca',
        addedBy: 'operator',
      });
      const ro = await server.query(
        'SELECT name FROM federation_peers WHERE name = ?',
        ['localhost'],
      );
      assertEquals(ro.length, 1);
      const ep = await resolve(server, 'localhost');
      assertEquals(ep.port, fake.port);
      assertEquals(ep.connectIp, '127.0.0.1');
      const res = await federationRequest(server, identity.signer, {
        destination: 'localhost',
        method: 'GET',
        path: '/_matrix/key/v2/server',
        body: null,
      });
      assertEquals(res.status, 200);
      await removePeer(server, 'localhost');
    });
  });
});

// --- the node:tls dialer -------------------------------------------------

function pinOf(pem: string): string {
  const x = new X509Certificate(pem);
  const spki = x.publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('hex');
}

async function withTlsFake<T>(
  certPem: string,
  keyPem: string,
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const server = Deno.serve(
    { port: 0, cert: certPem, key: keyPem },
    () => new Response('dial test'),
  );
  const port = (server.addr as Deno.NetAddr).port;
  try {
    return await fn(port);
  } finally {
    await server.shutdown();
  }
}

Deno.test('dial: pinned peer → SPKI match round trips; wrong pin → 502', async () => {
  const identity = await makeIdentity('dial1.test');
  await withStore(async (store) => {
    const server = await store.server();
    const pem = await Deno.readTextFile('tests/fixtures/tls/localhost.crt');
    const key = await Deno.readTextFile('tests/fixtures/tls/localhost.key');
    const pin = pinOf(pem);
    await withTlsFake(pem, key, async (port) => {
      await addPeer(server, {
        name: 'localhost',
        host: '127.0.0.1',
        port,
        trust: 'pinned',
        pin,
        addedBy: 'operator',
      });
      const ok = await federationRequestRaw(server, identity.signer, {
        destination: 'localhost',
        method: 'GET',
        path: '/x',
        body: null,
      });
      assertEquals(ok.status, 200);
      // wrong pin → 502 with the pin message
      await addPeer(server, {
        name: 'localhost',
        host: '127.0.0.1',
        port,
        trust: 'pinned',
        pin: 'f'.repeat(64),
        addedBy: 'operator',
      });
      const err = await federationRequest(server, identity.signer, {
        destination: 'localhost',
        method: 'GET',
        path: '/x',
        body: null,
      }).then(() => 'ok', (e: unknown) => e);
      assert(err instanceof UpstreamError);
      assertEquals(err.category, 'validation');
      assert(err.message.includes('pin'));
      await removePeer(server, 'localhost');
    });
  });
});

Deno.test('dial: key-is-name peer → raw key equality round trips', async () => {
  const identity = await makeIdentity('dial2.test');
  await withStore(async (store) => {
    const server = await store.server();
    const kp = (await generateSigningKeypair()) as unknown as CryptoKeyPair;
    const rawPub = await exportPublicKeyRaw(kp.publicKey);
    const name = b32encode(rawPub).toLowerCase().replace(/=+$/, '');
    // mint a self-signed Ed25519 cert from that key (openssl CLI)
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    const der = new Uint8Array(pkcs8);
    const b64 = btoa(String.fromCharCode(...der));
    const lines = (b64.match(/.{1,64}/g) ?? []).join(String.fromCharCode(10));
    const pem = '-----BEGIN PRIVATE KEY-----\n' + lines +
      '\n-----END PRIVATE KEY-----\n';
    const tmp = await Deno.makeTempFile();
    await Deno.writeTextFile(tmp, pem);
    const certPath = await Deno.makeTempFile();
    const out = await new Deno.Command('openssl', {
      args: [
        'req',
        '-x509',
        '-key',
        tmp,
        '-subj',
        `/CN=${name}`,
        '-days',
        '3650',
        '-out',
        certPath,
      ],
      stderr: 'null',
    }).output();
    assert(out.success);
    const certPem = await Deno.readTextFile(certPath);
    await withTlsFake(certPem, pem, async (port) => {
      await addPeer(server, {
        name,
        host: '127.0.0.1',
        port,
        trust: 'keyname',
        addedBy: 'operator',
      });
      const ok = await federationRequestRaw(server, identity.signer, {
        destination: name,
        method: 'GET',
        path: '/x',
        body: null,
      });
      assertEquals(ok.status, 200);
      // a wrong raw key → 502 with the key message
      const other =
        (await generateSigningKeypair()) as unknown as CryptoKeyPair;
      const otherRaw = await exportPublicKeyRaw(other.publicKey);
      const otherName = b32encode(otherRaw).toLowerCase().replace(/=+$/, '');
      await addPeer(server, {
        name: otherName,
        host: '127.0.0.1',
        port,
        trust: 'keyname',
        addedBy: 'operator',
      });
      const err = await federationRequest(server, identity.signer, {
        destination: otherName,
        method: 'GET',
        path: '/x',
        body: null,
      }).then(() => 'ok', (e: unknown) => e);
      assert(err instanceof UpstreamError);
      assertEquals(err.category, 'validation');
      assert(err.message.includes('key'));
      await removePeer(server, name);
      await removePeer(server, otherName);
    });
  });
});

Deno.test('client: caller cancellation closes both CA and pinned sockets during handshake and response reads', async () => {
  const identity = await makeIdentity('cancel-client.test');
  const cert = await Deno.readTextFile('tests/fixtures/tls/localhost.crt');
  const key = await Deno.readTextFile('tests/fixtures/tls/localhost.key');
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  try {
    await withStore(async (store) => {
      const server = await store.server();
      for (const trust of ['ca', 'pinned'] as const) {
        for (
          const mode of [
            'response-abort',
            'handshake-abort',
            'handshake-deadline',
          ]
        ) {
          const handshake = mode !== 'response-abort';
          setConfigForTests({
            federation: {
              cacerts: ['tests/fixtures/tls/ca.crt'],
              timeoutms: mode === 'handshake-deadline' ? 150 : 30_000,
            },
          });
          const listener = handshake
            ? Deno.listen({ hostname: '127.0.0.1', port: 0 })
            : Deno.listenTls({ hostname: '127.0.0.1', port: 0, cert, key });
          const port = (listener.addr as Deno.NetAddr).port;
          await addPeer(server, {
            name: 'localhost',
            host: '127.0.0.1',
            port,
            trust,
            pin: trust === 'pinned' ? pinOf(cert) : null,
            addedBy: 'operator',
          });
          const ac = new AbortController();
          const pending = federationRequest(server, identity.signer, {
            destination: 'localhost',
            method: 'POST',
            path: '/claim',
            body: new TextEncoder().encode('{}'),
            signal: ac.signal,
          }).then(() => 'unexpected success', (error: unknown) => error);
          let peer: Deno.Conn | undefined;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            peer = await Promise.race([
              listener.accept(),
              pending.then((result) => {
                throw new Error(
                  'request ended before connection: ' + String(result),
                );
              }),
            ]);
            const buffer = new Uint8Array(4096);
            // A real handshake or signed request has reached the consumer.
            assert((await peer.read(buffer))! > 0);
            if (mode !== 'handshake-deadline') ac.abort();
            const result = await Promise.race([
              pending,
              new Promise<string>((resolve) => {
                timer = setTimeout(() => resolve('stalled'), 500);
              }),
            ]);
            assert(
              mode === 'handshake-deadline'
                ? result instanceof UpstreamError &&
                  result.category === 'transport' &&
                  result.message.includes('timeout')
                : result instanceof DOMException,
              `${trust}/${mode}: ${result}`,
            );
            // Drain any already-written bytes; cancellation must close the peer.
            const closed = (async () => {
              try {
                while (await peer!.read(buffer) !== null) { /* drain */ }
              } catch { /* TLS reset is also closure */ }
              return 'closed';
            })();
            assertEquals(
              await Promise.race([
                closed,
                new Promise<string>((resolve) => {
                  clearTimeout(timer);
                  timer = setTimeout(() => resolve('still open'), 500);
                }),
              ]),
              'closed',
              `${trust}/${mode}: cancellation left the transport open`,
            );
          } finally {
            clearTimeout(timer);
            ac.abort();
            try {
              peer?.close();
            } catch { /* already closed */ }
            listener.close();
            await pending;
          }
        }
      }
    });
  } finally {
    setConfigForTests({ federation: { cacerts: [], timeoutms: 30_000 } });
    resetCaCertsForTests();
  }
});

Deno.test('client: CA transport verifies configured roots, IP SAN and server identity, refusing unknown CA and expired leaves', async () => {
  const identity = await makeIdentity('ca-client.test');
  const key = await Deno.readTextFile('tests/fixtures/tls/localhost.key');
  const valid = await Deno.readTextFile('tests/fixtures/tls/localhost.crt');
  const dir = await Deno.makeTempDir();
  const openssl = async (...args: string[]) => {
    const output = await new Deno.Command('openssl', {
      args,
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    assert(output.success, new TextDecoder().decode(output.stderr));
  };
  try {
    await Deno.writeTextFile(dir + '/index', '');
    await Deno.writeTextFile(dir + '/serial', '01\n');
    await Deno.writeTextFile(
      dir + '/ca.cnf',
      `[ca]\ndefault_ca=local\n[local]\ndatabase=${dir}/index\nserial=${dir}/serial\nnew_certs_dir=${dir}\ndefault_md=sha256\npolicy=policy\nx509_extensions=extensions\n[policy]\ncommonName=supplied\n[extensions]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n`,
    );
    await openssl(
      'req',
      '-new',
      '-key',
      'tests/fixtures/tls/localhost.key',
      '-subj',
      '/CN=localhost',
      '-out',
      dir + '/leaf.csr',
    );
    await openssl(
      'ca',
      '-batch',
      '-notext',
      '-config',
      dir + '/ca.cnf',
      '-keyfile',
      'tests/fixtures/tls/ca.key',
      '-cert',
      'tests/fixtures/tls/ca.crt',
      '-in',
      dir + '/leaf.csr',
      '-out',
      dir + '/expired.crt',
      '-startdate',
      '20200101000000Z',
      '-enddate',
      '20210101000000Z',
    );
    const expired = await Deno.readTextFile(dir + '/expired.crt');
    await withStore(async (store) => {
      const server = await store.server();
      for (
        const kind of [
          'valid-name',
          'valid-ip',
          'wrong-name',
          'unknown-ca',
          'expired',
        ]
      ) {
        let requests = 0;
        const peer = Deno.serve({
          hostname: '127.0.0.1',
          port: 0,
          cert: kind === 'expired' ? expired : valid,
          key,
        }, () => {
          requests++;
          return Response.json({ accepted: true });
        });
        const name = kind === 'valid-ip'
          ? '127.0.0.1'
          : kind === 'wrong-name'
          ? 'wrong.test'
          : 'localhost';
        setConfigForTests({
          federation: {
            cacerts: kind === 'unknown-ca' ? [] : ['tests/fixtures/tls/ca.crt'],
          },
        });
        resetCaCertsForTests();
        try {
          await addPeer(server, {
            name,
            host: '127.0.0.1',
            port: (peer.addr as Deno.NetAddr).port,
            trust: 'ca',
            addedBy: 'operator',
          });
          const result = await federationRequest(server, identity.signer, {
            destination: name,
            method: 'POST',
            path: '/keys/claim',
            body: new TextEncoder().encode('{}'),
          }).then((x) => x.status, (e: unknown) => e);
          if (kind.startsWith('valid')) {
            assertEquals(result, 200);
            assertEquals(requests, 1);
          } else {
            assert(
              result instanceof UpstreamError,
              kind + ': ' + String(result),
            );
            assertEquals(result.category, 'transport');
            assertEquals(
              requests,
              0,
              'wrote consuming request before trust verification',
            );
          }
        } finally {
          await peer.shutdown();
          await removePeer(server, name);
        }
      }
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
    setConfigForTests({ federation: { cacerts: [] } });
    resetCaCertsForTests();
  }
});

Deno.test('resolve: real well-known handshake cancellation closes its socket without poisoning the next discovery', async () => {
  const identity = await makeIdentity('discovery-cancel.test');
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  resetWellKnownCache();
  try {
    await withStore(async (store) => {
      const server = await store.server();
      const listener = Deno.listen({ hostname: '127.0.0.1', port: 443 });
      const ac = new AbortController();
      const pending = resolve(server, 'localhost', ac.signal).then(
        () => 'unexpected success',
        (e: unknown) => e,
      );
      let peer: Deno.Conn | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        peer = await listener.accept();
        const buffer = new Uint8Array(4096);
        assert((await peer.read(buffer))! > 0);
        ac.abort();
        assert((await pending) instanceof DOMException);
        const closed = (async () => {
          try {
            while (await peer!.read(buffer) !== null) { /* drain */ }
          } catch { /* reset */ }
          return 'closed';
        })();
        assertEquals(
          await Promise.race([
            closed,
            new Promise<string>((resolve) => {
              timer = setTimeout(() => resolve('still open'), 500);
            }),
          ]),
          'closed',
        );
      } finally {
        clearTimeout(timer);
        ac.abort();
        try {
          peer?.close();
        } catch { /* already closed */ }
        listener.close();
        await pending;
      }
      const fake = await startFakeServer({
        ourKeyDoc: () => Promise.resolve(identity.doc),
      });
      const wk = Deno.serve({
        hostname: '127.0.0.1',
        port: 443,
        cert: await Deno.readTextFile('tests/fixtures/tls/localhost.crt'),
        key: await Deno.readTextFile('tests/fixtures/tls/localhost.key'),
      }, () => Response.json({ 'm.server': fake.name }));
      try {
        const endpoint = await resolve(server, 'localhost');
        assertEquals(endpoint.port, fake.port);
        const response = await federationRequest(server, identity.signer, {
          destination: 'localhost',
          method: 'GET',
          path: '/_matrix/key/v2/server',
          body: null,
        });
        assertEquals(response.status, 200);
      } finally {
        await wk.shutdown();
        await fake.close();
      }
    });
  } finally {
    resetWellKnownCache();
    setConfigForTests({ federation: { cacerts: [] } });
    resetCaCertsForTests();
  }
});

Deno.test('client: cancellation during signing prevents a late consuming dial', async () => {
  const identity = await makeIdentity('cancel-sign.test');
  await withStore(async (store) => {
    await withFake(identity, async (fake) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const signing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const signer: Signer = {
        ...identity.signer,
        sign: async (data) => {
          entered();
          await held;
          return await identity.signer.sign(data);
        },
      };
      const ac = new AbortController();
      const pending = federationRequest(await store.server(), signer, {
        destination: fake.name,
        method: 'POST',
        path: '/claim',
        body: new TextEncoder().encode('{}'),
        signal: ac.signal,
      }).then(() => 'unexpected success', (error: unknown) => error);
      await signing;
      ac.abort();
      try {
        assert((await pending) instanceof DOMException);
      } finally {
        release();
      }
      await held;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assertEquals(fake.requests.length, 0);
    });
  });
});
