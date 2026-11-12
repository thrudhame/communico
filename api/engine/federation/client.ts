// api/engine/federation/client.ts — the signed outbound federation client.
// Resolve -> sign with the tenant Signer -> connect through the shared
// node:tls dialer for every trust kind -> send. The admission
// gate is the CALLER's job. The server file's Db is explicit (roster
// lookup inside resolve); the Signer is the tenant's event-signing
// identity. Ported from doltgres; maxBytes defaults to
// federation.maxbytes and can be raised per call (the fetcher's bulk
// endpoints use federation.bulkmaxbytes).
import { config } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { canonicalJson } from '#engine/canonical.ts';
import type { Signer } from '#engine/room/signer.ts';
import type { Database as Db } from '#engine/store/db.ts';
import { dialNodeTls } from './dial-node-tls.ts';
import { caCertsPem, resolve } from './resolve.ts';
import { buildXMatrixHeader } from './xmatrix.ts';
import { abortable } from '#engine/net/abort.ts';
import { assertRoomAcl } from './acl.ts';
import type { Store } from '#engine/store/index.ts';
import type { Http1Response, Http1WireOpts } from '#engine/net/http1.ts';
import { decodeJson, objectOf } from '#engine/net/json.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';

export { caCertsPem, resetCaCertsForTests } from './resolve.ts';

export type FederationRequest = {
  destination: string;
  method: string;
  path: string; // request target, with query
  body: Uint8Array | null;
  // response cap; defaults to federation.maxbytes
  maxBytes?: number;
  signal?: AbortSignal;
  // Typed scope from the owner, never inferred from paths or mixed /send bodies.
  room?: { store: Store; id: string; participation?: boolean };
};

export type FederationResponse = {
  status: number;
  json: unknown;
};

// Only a completed HTTP response carries this provenance. Local validation,
// discovery, signing and uncertain transport failures remain ordinary errors.
export class FederationHttpError extends MatrixError {
  constructor(
    readonly remoteStatus: number,
    readonly matrixBody: boolean,
    errcode: string,
    message: string,
  ) {
    super(matrixBody ? remoteStatus : 502, errcode, message);
  }
}

// v2 -> v1 fallback requires a completed endpoint-unknown response, not a
// client-facing mapped status or a local error with a coincidentally equal code.
export function isEndpointUnknown(error: unknown): boolean {
  if (!(error instanceof FederationHttpError)) return false;
  if (error.remoteStatus !== 404 && error.remoteStatus !== 405) return false;
  return !error.matrixBody || error.errcode === 'M_UNRECOGNIZED';
}

export async function federationRequest(
  server: Db,
  signer: Signer,
  req: FederationRequest,
): Promise<FederationResponse> {
  const res = await federationRequestRaw(server, signer, req);
  // Wire grammar is shared; roots (including v1 tuples) and endpoint schemas
  // belong to their consumers. Malformed success is never absence or success.
  return {
    status: res.status,
    json: decodeJson(res.body, res.headers.get('content-type')),
  };
}

// Raw bytes and streaming sinks share signing, ACL admission, discovery, TLS
// trust and cancellation with JSON federation. Non-success bodies stay bounded
// and buffered so completed HTTP error provenance is preserved for all callers.
export async function federationRequestRaw(
  server: Db,
  signer: Signer,
  req: FederationRequest & { sink?: Http1WireOpts['sink'] },
): Promise<Http1Response> {
  // disabled ⇒ refuse to dial at all
  if (!config().federation.enabled) {
    throw new MatrixError(502, 'M_UNKNOWN', 'federation disabled');
  }
  req.signal?.throwIfAborted();
  if (req.room !== undefined) {
    if (req.room.participation) {
      await assertRoomAcl(req.room.store, req.room.id, signer.serverName);
    }
    await assertRoomAcl(req.room.store, req.room.id, req.destination);
  }
  const endpoint = await resolve(server, req.destination, req.signal);
  const origin = signer.serverName;
  const obj: Record<string, unknown> = {
    method: req.method,
    uri: req.path,
    origin,
    destination: req.destination,
  };
  const body = req.body;
  if (body !== null) {
    obj.content = JSON.parse(new TextDecoder().decode(body));
  }
  // the X-Matrix signature covers the canonical request object (spec §
  // Request Authentication) — the Signer signs canonical bytes verbatim
  const signature = await abortable(
    req.signal,
    () => signer.sign(canonicalJson(obj)),
  );
  const auth = buildXMatrixHeader({
    origin,
    destination: req.destination,
    key: signer.keyId,
    signature,
  });
  const headers: Record<string, string> = { Authorization: auth };
  if (body !== null) headers['Content-Type'] = 'application/json';
  const maxBytes = req.maxBytes !== undefined
    ? req.maxBytes
    : config().federation.maxbytes;
  req.signal?.throwIfAborted();
  // Discovery/signing can yield while the ACL changes. Check again at the
  // final network boundary; room state is never locked across network I/O.
  if (req.room !== undefined) {
    if (req.room.participation) {
      await assertRoomAcl(req.room.store, req.room.id, signer.serverName);
    }
    await assertRoomAcl(req.room.store, req.room.id, req.destination);
  }
  const res = await dialNodeTls({
    connectIp: endpoint.connectIp,
    port: endpoint.port,
    sni: endpoint.sni,
    hostHeader: endpoint.hostHeader,
    trust: endpoint.trust.kind === 'ca'
      ? { kind: 'ca', caCerts: caCertsPem() }
      : endpoint.trust,
    method: req.method,
    path: req.path,
    headers,
    body,
    connectMs: config().federation.connectms,
    timeoutMs: config().federation.timeoutms,
    maxBytes,
    signal: req.signal,
    sink: (status, headers) =>
      status >= 200 && status < 300 && req.sink !== undefined
        ? req.sink(status, headers)
        : null,
  });
  if (res.status >= 200 && res.status < 300) {
    return res;
  }
  // non-2xx: a Matrix body surfaces verbatim
  try {
    const o = objectOf(
      decodeJson(res.body, res.headers.get('content-type')),
      'matrix-error',
    );
    // Matrix's error schema requires errcode; the human message is optional.
    if (
      typeof o.errcode === 'string' &&
      (o.error === undefined || typeof o.error === 'string')
    ) {
      throw new FederationHttpError(
        res.status,
        true,
        o.errcode,
        o.error === undefined ? o.errcode : o.error,
      );
    }
  } catch (e) {
    if (!(e instanceof UpstreamError)) throw e;
  }
  throw new FederationHttpError(
    res.status,
    false,
    'M_UNKNOWN',
    `upstream returned ${res.status}`,
  );
}
