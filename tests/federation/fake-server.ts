// tests/federation/fake-server.ts — a fake remote server for federation
// tests: real TLS (the tracked fixture leaf, fixture CA), its own ed25519
// keypair, serves /_matrix/key/v2/server for itself, acts as a notary
// witness when handed documents, records every request, and verifies
// inbound X-Matrix against OUR key doc (fetched from the app under test
// by an injected getter).
import {
  b64decode,
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
  importPublicKeyFromRaw,
  signJson,
} from '#engine/signing-primitives.js';
import { canonicalJson } from '#engine/canonical.ts';
import { parseXMatrixHeaders } from '#engine/federation/xmatrix.ts';

const FIXTURE = 'tests/fixtures/tls';

export type FakeRequest = {
  method: string;
  path: string;
  origin: string | null;
  verified: boolean;
  body: Uint8Array | null;
};

export type FakeServer = {
  port: number;
  name: string; // 'localhost' or 'localhost:port'
  keyId: string;
  publicB64: string;
  requests: FakeRequest[];
  // sign any JSON object as this server (for building inbound requests)
  sign: (obj: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
  // the fake's own document for seeding the remembered-keys tables
  keyDoc: () => Promise<Record<string, unknown>>;
};

type OurKey = { serverName: string; keyId: string; pub: CryptoKey };

export async function startFakeServer(opts: {
  // witness role: documents to notarize, by server name
  keyDocs?: Record<string, unknown>;
  // our app's key doc getter — the test hands an in-process app call
  ourKeyDoc: () => Promise<unknown>;
  // M5b: custom routes, consulted BEFORE the built-ins — return a
  // Response to handle, null to fall through (the fake-room builder
  // hangs its room endpoints here)
  handlers?: (
    req: FakeRequest & { url: URL; json(): unknown },
  ) => Response | Promise<Response> | null;
}): Promise<FakeServer> {
  const kp = (await generateSigningKeypair()) as unknown as CryptoKeyPair;
  const publicB64 = b64encodeStd(await exportPublicKeyRaw(kp.publicKey));
  const keyId = 'ed25519:test';
  const requests: FakeRequest[] = [];
  // the fake's own names, bare and with-port (destination accepted for either)
  const ownNames = ['localhost'];
  // server_name as presented by this fake: the ephemeral port is part of it
  let selfName = 'localhost';

  const ourRaw = (await opts.ourKeyDoc()) as Record<string, unknown>;
  const ourName = String(ourRaw.server_name);
  const ourKeyEntries = Object.entries(
    ourRaw.verify_keys as Record<string, { key: string }>,
  );
  const ourKey: OurKey = {
    serverName: ourName,
    keyId: ourKeyEntries[0][0],
    pub: await importPublicKeyFromRaw(b64decode(ourKeyEntries[0][1].key)),
  };

  async function keyDoc(): Promise<Record<string, unknown>> {
    const doc: Record<string, unknown> = {
      server_name: selfName,
      verify_keys: { [keyId]: { key: publicB64 } },
      old_verify_keys: {},
      valid_until_ts: Date.now() + 7 * 86400_000,
      signatures: {},
    };
    return (await signJson(doc, selfName, keyId, kp.privateKey)) as Record<
      string,
      unknown
    >;
  }

  function verifyInbound(
    request: Request,
    body: Uint8Array | null,
  ): Promise<string | null> {
    return (async () => {
      const authHeader = request.headers.get('authorization');
      if (authHeader === null) return null;
      const url = new URL(request.url);
      const uri = url.pathname + url.search;
      for (const c of parseXMatrixHeaders([authHeader])) {
        if (c.destination !== null && !ownNames.includes(c.destination)) {
          continue;
        }
        const obj: Record<string, unknown> = {
          method: request.method,
          uri,
          origin: c.origin,
          destination: c.destination !== null ? c.destination : ownNames[0],
        };
        if (body !== null && body.length > 0) {
          obj.content = JSON.parse(new TextDecoder().decode(body));
        }
        // the signature comes from the header, never the body — verify
        // over the canonical JSON of the unsigned object directly
        const sig = b64decode(c.signature);
        const data = new TextEncoder().encode(canonicalJson(obj));
        const ok = await crypto.subtle.verify(
          { name: 'Ed25519' },
          ourKey.pub,
          sig,
          data,
        );
        if (ok) return c.origin;
      }
      return null;
    })();
  }

  const server = Deno.serve({
    port: 0,
    cert: await Deno.readTextFile(`${FIXTURE}/localhost.crt`),
    key: await Deno.readTextFile(`${FIXTURE}/localhost.key`),
  }, async (request: Request) => {
    const url = new URL(request.url);
    const bodyBytes = request.method === 'GET'
      ? null
      : new Uint8Array(await request.arrayBuffer());
    let origin: string | null = null;
    try {
      origin = await verifyInbound(request, bodyBytes);
    } catch { /* unparseable — recorded unverified */ }
    const recorded: FakeRequest & { url: URL; json(): unknown } = {
      method: request.method,
      path: url.pathname + url.search,
      origin,
      verified: origin !== null,
      body: bodyBytes,
      url,
      json: () =>
        bodyBytes === null
          ? null
          : JSON.parse(new TextDecoder().decode(bodyBytes)),
    };
    requests.push(recorded);
    const custom = await opts.handlers?.(recorded);
    if (custom) return custom;
    if (url.pathname === '/_matrix/key/v2/server') {
      return Response.json(await keyDoc());
    }
    if (url.pathname.startsWith('/_matrix/key/v2/query/')) {
      const name = decodeURIComponent(
        url.pathname.slice('/_matrix/key/v2/query/'.length),
      );
      const witnessDoc = opts.keyDocs !== undefined &&
          opts.keyDocs[name] !== undefined
        ? opts.keyDocs[name]
        : null;
      return Response.json({
        server_keys: witnessDoc === null ? [] : [witnessDoc],
      });
    }
    return Response.json(
      { errcode: 'M_UNRECOGNIZED', error: 'fake 404' },
      { status: 404 },
    );
  });
  const port = (server.addr as Deno.NetAddr).port;
  ownNames.push(`localhost:${port}`);
  selfName = `localhost:${port}`;
  return {
    port,
    name: selfName,
    keyId,
    publicB64,
    requests,
    sign: async (obj) =>
      (await signJson(obj, selfName, keyId, kp.privateKey)) as Record<
        string,
        unknown
      >,
    close: async () => {
      await server.shutdown();
    },
    keyDoc,
  };
}
