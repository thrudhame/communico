// api/engine/federation/auth-middleware.ts — X-Matrix request
// authentication, placed as the 20-auth.ts one-liner of each protected
// federation folder. Steps: enabled → parse EVERY Authorization header
// (all candidates; sig OR signature names; RFC 9110 grammar) → none
// usable → 401; a present destination must equal our server name → 401;
// the admission gate (blocks/closed/pending/blocking) → 403; rebuild the
// signed object with destination ALWAYS ours (even when the header
// omitted it); get the origin's key (remembered → witnesses → direct per
// the ladder); a signature that verifies → authenticated and the open-mode
// knock is recorded (verified), nowhere before the verification.
import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { b64decode } from '#engine/signing-primitives.js';
import { admit } from './gate.ts';
import { assertFederationEnabled } from './keydoc.ts';
import { getVerifyKey } from './keys.ts';
import { lookupPeer, recordPending } from './peers.ts';
import { notifyPeerAlive } from './outbox.ts';
import { wakeDestination } from './sender.ts';
import { parseXMatrixHeaders } from './xmatrix.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

function unauthorized(): never {
  throw new MatrixError(401, 'M_UNAUTHORIZED', 'missing or invalid signature');
}

export default async function (
  request: PathfinderRequest,
  context: Context,
): Promise<void> {
  // 1. federation must be on
  assertFederationEnabled();

  // 2. parse every Authorization header; fetch Headers joins duplicates
  // on commas — the parser's candidate grouping recovers them
  const header = request.headers.get('authorization');
  const candidates = header === null ? [] : parseXMatrixHeaders([header]);
  if (candidates.length === 0) unauthorized();

  const rawUrl = new URL(request._raw.url);
  // the signed uri is the request target exactly as received (SS:285-288)
  const uri = rawUrl.pathname + rawUrl.search;
  const bodyBytes = await request.body.bytes(); // memoized in pathfinder 0.2.2 (pinned by a test)
  const now = Date.now();

  for (const candidate of candidates) {
    // 3. destination, when present, must be our server name
    if (
      candidate.destination !== null &&
      candidate.destination !== serverName()
    ) {
      continue;
    }
    // 4. the admission gate — 403s; in closed mode the unverified claim
    // is bucketed here (bounded by coalescing, cap, expiry)
    await admit(candidate.origin, {
      kind: 'inbound',
      endpoint: uri,
    });
    // 5. rebuild the signed object — destination always OURS
    const obj: Record<string, unknown> = {
      method: request.method,
      uri,
      origin: candidate.origin,
      destination: serverName(),
    };
    if (bodyBytes.length > 0) {
      obj.content = JSON.parse(new TextDecoder().decode(bodyBytes));
    }
    // 6. the origin's key from what we remember, witnesses, or — open
    // mode — a direct fetch; then the signature must verify
    let pub: CryptoKey;
    try {
      pub = await getVerifyKey(
        candidate.origin,
        candidate.key,
        now,
        'request',
      );
    } catch {
      continue; // key unobtainable → try the next candidate
    }
    const sig = b64decode(candidate.signature);
    const ok = await crypto.subtle.verify(
      { name: 'Ed25519' },
      pub,
      sig,
      new TextEncoder().encode(canonicalJson(obj)),
    );
    if (!ok) continue;
    // 7. authenticated — and only NOW the first contact is recorded (open
    // mode, no roster row: nothing durable on a stranger's word before
    // this point). M5b: inbound contact resets the destination's delivery
    // backoff and wakes its queue (D2 — every authenticated endpoint,
    // not just /send; Synapse _base.py:140-155).
    context.state.origin = candidate.origin;
    await notifyPeerAlive(candidate.origin);
    wakeDestination(candidate.origin);
    const peer = await lookupPeer(candidate.origin);
    if (peer === null) {
      await recordPending(candidate.origin, 'inbound', true, uri);
    }
    return;
  }
  unauthorized();
}
