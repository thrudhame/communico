// api/engine/federation/auth.ts — inbound X-Matrix request verification
// (the function the stage-5 federation endpoints call; the old
// auth-middleware.ts without the pathfinder coupling). Steps: enabled →
// parse EVERY Authorization header (all candidates; sig OR signature
// names; RFC 9110 grammar) → none usable → 401; a present destination
// must be the tenant this request arrived at → 401; the admission gate
// (blocks/closed/pending/blocking) → 403; rebuild the signed object with
// destination ALWAYS ours (even when the header omitted it); get the
// origin's key (remembered → witnesses → direct per the ladder); a
// signature that verifies → authenticated: the contact hook fires
// (delivery-backoff reset + sender wake — the old D2, injected) and the
// open-mode knock is recorded, nowhere before the verification.
import { MatrixError } from '#engine/matrix-error.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { b64decode } from '#engine/signing-primitives.js';
import type { Database as Db } from '#engine/store/db.ts';
import { admit } from './gate.ts';
import { assertFederationEnabled } from './keydoc.ts';
import type { KeyStore } from './keys.ts';
import { lookupPeer, recordPending } from './peers.ts';
import { parseXMatrixHeaders } from './xmatrix.ts';

export type FederationRequest_ = {
  method: string;
  // the request target exactly as received (path + query — SS:285-288)
  uri: string;
  // the joined Authorization header value, null when absent
  authorization: string | null;
  // the raw body (empty when there is none)
  body: Uint8Array;
};

export type AuthDeps = {
  server: Db;
  keys: KeyStore;
  // After a request verifies: the sender's contact hook (peer-alive
  // reset + queue wake). Injected so auth stands alone (commit 1) and
  // every authenticated endpoint wires the same hook (old D2).
  onContact?: (origin: string) => void;
};

function unauthorized(): never {
  throw new MatrixError(401, 'M_UNAUTHORIZED', 'missing or invalid signature');
}

export async function authenticateRequest(
  deps: AuthDeps,
  destination: string,
  req: FederationRequest_,
): Promise<string> {
  // 1. federation must be on
  assertFederationEnabled();

  // 2. parse every Authorization header; fetch Headers joins duplicates
  //    on commas — the parser's candidate grouping recovers them
  const candidates = req.authorization === null
    ? []
    : parseXMatrixHeaders([req.authorization]);
  if (candidates.length === 0) unauthorized();

  const now = Date.now();
  for (const candidate of candidates) {
    // 3. destination, when present, must be the tenant we arrived at
    if (
      candidate.destination !== null && candidate.destination !== destination
    ) {
      continue;
    }
    // 4. the admission gate — 403s; in closed mode the unverified claim
    //    is bucketed here (bounded by coalescing, cap, expiry)
    await admit(deps.server, candidate.origin, {
      kind: 'inbound',
      endpoint: req.uri,
    });
    // 5. rebuild the signed object — destination always OURS
    const obj: Record<string, unknown> = {
      method: req.method,
      uri: req.uri,
      origin: candidate.origin,
      destination,
    };
    let canonical: string;
    try {
      if (req.body.length > 0) {
        obj.content = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(req.body),
        );
      }
      canonical = canonicalJson(obj);
    } catch {
      unauthorized();
    }
    let sig: ReturnType<typeof b64decode>;
    try {
      sig = b64decode(candidate.signature);
    } catch {
      continue;
    }
    // 6. the origin's key from what we remember, witnesses, or — open
    //    mode — a direct fetch; then the signature must verify
    let pub: CryptoKey;
    try {
      pub = await deps.keys.getVerifyKey(
        candidate.origin,
        candidate.key,
        now,
        'request',
      );
    } catch {
      continue; // key unobtainable → try the next candidate
    }
    const ok = await crypto.subtle.verify(
      { name: 'Ed25519' },
      pub,
      sig,
      new TextEncoder().encode(canonical),
    );
    if (!ok) continue;
    // 7. authenticated — and only NOW the first contact is recorded (open
    //    mode, no roster row: nothing durable on a stranger's word before
    //    this point). The contact hook resets the destination's delivery
    //    backoff and wakes its queue (old D2 — every authenticated
    //    endpoint, not just /send; Synapse _base.py:140-155).
    if (deps.onContact !== undefined) deps.onContact(candidate.origin);
    const peer = await lookupPeer(deps.server, candidate.origin);
    if (peer === null) {
      await recordPending(
        deps.server,
        candidate.origin,
        'inbound',
        true,
        req.uri,
      );
    }
    return candidate.origin;
  }
  unauthorized();
}
