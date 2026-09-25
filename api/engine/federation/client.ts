// api/engine/federation/client.ts — the signed outbound federation client.
// Resolve → connect (http1 for trust 'ca'; the node:tls dialer for
// 'pinned'/'keyname' lands in the dialer commit) → sign with the tenant
// key → send. The admission gate is the CALLER's job (concilium 7m).
// caCerts = federation.cacerts files read once at startup.
import { config, serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getTenantKey } from '#engine/tenant.ts';
import { signJson } from '#engine/signing-primitives.js';
import { http1Request, type Http1Response } from '#engine/net/http1.ts';
import { dialNodeTls } from './dial-node-tls.ts';
import { resolve } from './resolve.ts';
import { buildXMatrixHeader } from './xmatrix.ts';
import { setKeysDeps } from './keys.ts';
import { listWitnesses } from './peers.ts';

export type FederationRequest = {
  destination: string;
  method: string;
  path: string; // request target, with query
  body: Uint8Array | null;
};

export type FederationResponse = {
  status: number;
  json: unknown;
};

let _cacerts: string[] | null = null;

function caCerts(): string[] {
  if (_cacerts !== null) return _cacerts;
  _cacerts = config().federation.cacerts.map((p) => Deno.readTextFileSync(p));
  return _cacerts;
}

/** Tests setConfigForTests after the first read — drop the memo. */
export function resetCaCertsForTests(): void {
  _cacerts = null;
}

export async function federationRequest(
  req: FederationRequest,
): Promise<FederationResponse> {
  // disabled ⇒ refuse to dial at all
  if (!config().federation.enabled) {
    throw new MatrixError(502, 'M_UNKNOWN', 'federation disabled');
  }
  const endpoint = await resolve(req.destination);
  const key = await getTenantKey();
  const keyId = 'ed25519:' + key.keyId;
  const obj: Record<string, unknown> = {
    method: req.method,
    uri: req.path,
    origin: serverName(),
    destination: req.destination,
  };
  const body = req.body;
  if (body !== null) {
    obj.content = JSON.parse(new TextDecoder().decode(body));
  }
  const signed = await signJson(obj, serverName(), keyId, key.privateKey);
  const signature =
    (signed.signatures as Record<string, Record<string, string>>)[serverName()][
      keyId
    ];
  const auth = buildXMatrixHeader({
    origin: serverName(),
    destination: req.destination,
    key: keyId,
    signature,
  });
  const headers: Record<string, string> = { Authorization: auth };
  if (body !== null) headers['Content-Type'] = 'application/json';
  let res: Http1Response;
  if (endpoint.trust.kind === 'ca') {
    const tls = endpoint.sni === null
      ? { sni: null, caCerts: caCerts() }
      : { sni: endpoint.sni, caCerts: caCerts() };
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
      maxBytes: config().federation.maxbytes,
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
      maxBytes: config().federation.maxbytes,
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

/** Wire the real transport (and the roster witness list) into keys.ts.
 *  Called by main.ts at startup and by the fake-server tests. */
export function wireFederationTransport(): void {
  setKeysDeps({
    directGet: async (name, _minimumValidUntilTs) => {
      const res = await federationRequest({
        destination: name,
        method: 'GET',
        path: '/_matrix/key/v2/server',
        body: null,
      });
      return res.json;
    },
    witnessQuery: async (peer, name, minimumValidUntilTs) => {
      const res = await federationRequest({
        destination: peer,
        method: 'GET',
        path: `/_matrix/key/v2/query/${
          encodeURIComponent(name)
        }?minimum_valid_until_ts=${minimumValidUntilTs}`,
        body: null,
      });
      return res.json;
    },
    listWitnesses,
  });
}
