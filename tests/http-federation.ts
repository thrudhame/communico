import { theApp } from '#engine/app.ts';
import { serverName } from '#engine/config.ts';
import { finalizeBuilt } from '#engine/room/build.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Signer } from '#engine/room/signer.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import { b64encodeStd, signJson } from '#engine/signing-primitives.js';
import {
  makeServer,
  seedServer,
  type TestServer,
} from './federation/doc-helper.ts';

export type Json = Record<string, unknown>;

export async function remoteServer(name = 'remote.test') {
  const server = await makeServer(name);
  await seedServer(theApp().server, server);
  return server;
}

export function signerFor(server: TestServer): Signer {
  return {
    serverName: server.name,
    keyId: server.keyId,
    sign: async (canonical) =>
      b64encodeStd(
        new Uint8Array(
          await crypto.subtle.sign(
            'Ed25519',
            server.kp.privateKey,
            new TextEncoder().encode(canonical),
          ),
        ),
      ),
  };
}

export function fedCaller(
  matrix: (req: Request) => Promise<Response>,
  server: TestServer,
) {
  return async (method: string, path: string, body?: unknown) => {
    const signed = await signJson(
      {
        method,
        uri: path,
        origin: server.name,
        destination: serverName(),
        ...(body === undefined ? {} : { content: body }),
      },
      server.name,
      server.keyId,
      server.kp.privateKey,
    );
    const sigs = signed.signatures as Record<string, Record<string, string>>;
    const res = await matrix(
      new Request('http://x' + path, {
        method,
        headers: {
          authorization:
            `X-Matrix origin="${server.name}",key="${server.keyId}",sig="${
              sigs[server.name][server.keyId]
            }"`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json() as Json };
  };
}

export async function signTemplate(
  template: Json,
  server: TestServer,
  version = '11',
) {
  return await finalizeBuilt(
    {
      ...template,
      origin_server_ts: Date.now(),
      hashes: { sha256: '' },
      signatures: {},
    } as Pdu,
    getRulebook(version),
    signerFor(server),
  );
}
