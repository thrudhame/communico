// api/engine/federation/client.ts — the signed outbound federation client.
// Resolve → connect (http1 for trust 'ca'; the node:tls dialer for
// 'pinned'/'keyname') → sign with the tenant Signer → send. The admission
// gate is the CALLER's job. The server file's Db is explicit (roster
// lookup inside resolve); the Signer is the tenant's event-signing
// identity. Ported from doltgres; maxBytes defaults to
// federation.maxbytes and can be raised per call (the fetcher's bulk
// endpoints use federation.bulkmaxbytes).
import { config } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { canonicalJson } from '#engine/canonical.ts';
import type { Signer } from '#engine/room/signer.ts';
import type { Db } from '#engine/store/db.ts';
import { http1Request, type Http1Response } from '#engine/net/http1.ts';
import { dialNodeTls } from './dial-node-tls.ts';
import { caCertsPem, resolve } from './resolve.ts';
import { buildXMatrixHeader } from './xmatrix.ts';

export { caCertsPem, resetCaCertsForTests } from './resolve.ts';

export type FederationRequest = {
  destination: string;
  method: string;
  path: string; // request target, with query
  body: Uint8Array | null;
  // response cap; defaults to federation.maxbytes
  maxBytes?: number;
};

export type FederationResponse = {
  status: number;
  json: unknown;
};

export async function federationRequest(
  server: Db,
  signer: Signer,
  req: FederationRequest,
): Promise<FederationResponse> {
  // disabled ⇒ refuse to dial at all
  if (!config().federation.enabled) {
    throw new MatrixError(502, 'M_UNKNOWN', 'federation disabled');
  }
  const endpoint = await resolve(server, req.destination);
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
  const signature = await signer.sign(canonicalJson(obj));
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
  let res: Http1Response;
  if (endpoint.trust.kind === 'ca') {
    const tls = endpoint.sni === null
      ? { sni: null, caCerts: caCertsPem() }
      : { sni: endpoint.sni, caCerts: caCertsPem() };
    res = await http1Request({
      connectIp: endpoint.connectIp,
      port: endpoint.port,
      tls,
      hostHeader: endpoint.hostHeader,
      method: req.method,
      path: req.path,
      headers,
      body,
      connectMs: config().federation.connectms,
      timeoutMs: config().federation.timeoutms,
      maxBytes,
    });
  } else {
    // pinned / key-is-name → the node:tls dialer (roster trust kind)
    res = await dialNodeTls({
      connectIp: endpoint.connectIp,
      port: endpoint.port,
      sni: endpoint.sni,
      hostHeader: endpoint.hostHeader,
      trust: endpoint.trust,
      method: req.method,
      path: req.path,
      headers,
      body,
      connectMs: config().federation.connectms,
      timeoutMs: config().federation.timeoutms,
      maxBytes,
    });
  }
  if (res.status >= 200 && res.status < 300) {
    let json: unknown = null;
    if (res.body.length > 0) {
      try {
        json = JSON.parse(new TextDecoder().decode(res.body));
      } catch { /* a 2xx empty-ish body — tolerate */ }
    }
    return { status: res.status, json };
  }
  // non-2xx: a Matrix body surfaces verbatim
  try {
    const j = JSON.parse(new TextDecoder().decode(res.body));
    const o = j as Record<string, unknown>;
    if (o !== null && typeof o === 'object' && typeof o.errcode === 'string') {
      throw new MatrixError(
        res.status,
        o.errcode,
        typeof o.error === 'string' ? o.error : o.errcode,
      );
    }
  } catch (e) {
    if (e instanceof MatrixError) throw e;
  }
  throw new MatrixError(502, 'M_UNKNOWN', `upstream returned ${res.status}`);
}
