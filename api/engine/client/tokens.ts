// Storage-neutral wire grammar. Sync recovery is applied by its consumer, never
// by room pagination, which reads only its own event/room cursor boundary.
import { Buffer } from 'node:buffer';

export type StreamToken = {
  eSeq: number;
  pSeq: number;
  tSeq: number;
  rSeq: number;
  aSeq: number;
  dSeq: number;
  mSeq: number;
  kSeq: number;
  nSeq?: number;
  epoch?: string;
  domain?: string;
};

export type DurableStreamHeads = Omit<
  Required<StreamToken>,
  'epoch' | 'domain' | 'tSeq'
>;

/** Synapse's future-token recovery: clamp durable streams to allocated maxima.
 * Typing is intentionally excluded because its process-local stream may reset.
 * Return identity when unchanged so callers never synthesize receipt authority.
 * This is a sync-consumer operation, not part of the pagination wire parser. */
export function boundFutureToken(
  token: StreamToken,
  heads: DurableStreamHeads,
): StreamToken {
  const bounded = { ...token };
  let changed = false;
  for (const key of Object.keys(heads) as (keyof DurableStreamHeads)[]) {
    if ((token[key] ?? 0) > heads[key]) {
      bounded[key] = heads[key];
      changed = true;
    }
  }
  return changed ? bounded : token;
}

export function parseStreamToken(raw: string | null): StreamToken | null {
  if (raw === null) return null;
  if (raw.startsWith('v1.')) {
    const envelope = parsePosition(raw);
    if (envelope === null) return null;
    // Only the existing numeric grammar can inhabit an envelope. Requiring the
    // issued spelling prevents padding, JSON and shorthand aliases from hashing
    // into another token's inbox receipt. Domain validation is the consumer's job.
    const cuts = parseLegacyToken(envelope.payload);
    if (cuts === null || encodeStreamToken(cuts) !== envelope.payload) {
      return null;
    }
    const token = { ...cuts, domain: envelope.domain };
    return encodeStreamToken(token) === raw ? token : null;
  }
  return parseLegacyToken(raw);
}

function validDomain(domain: string): boolean {
  return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(domain);
}

/** One canonical envelope for node-local positions. Each consumer still owns
 * its payload grammar, ordering and admission; this grants no ACK authority. */
export function formatPosition(domain: string, payload: string): string {
  if (!validDomain(domain)) throw new TypeError('invalid publication domain');
  return 'v1.' +
    Buffer.from(JSON.stringify([domain, payload])).toString('base64url');
}

export function parsePosition(
  raw: string,
): { domain: string; payload: string } | null {
  if (!/^v1\.[A-Za-z0-9_-]+$/.test(raw)) return null;
  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.from(raw.slice(3), 'base64url').toString());
  } catch {
    return null;
  }
  if (
    !Array.isArray(envelope) || envelope.length !== 2 ||
    typeof envelope[0] !== 'string' || !validDomain(envelope[0]) ||
    typeof envelope[1] !== 'string' ||
    formatPosition(envelope[0], envelope[1]) !== raw
  ) return null;
  return { domain: envelope[0], payload: envelope[1] };
}

function parseLegacyToken(raw: string): StreamToken | null {
  const m =
    /^s(\d+)(?:_p(\d+))?(?:_t(\d+))?(?:_r(\d+))?(?:_a(\d+))?(?:_d(\d+))?(?:_m(\d+))?(?:_k(\d+))?(?:_n(\d+))?(?:_z([a-f0-9]{32}))?$/
      .exec(
        raw,
      );
  if (!m) return null;
  if (
    m.slice(1, 10).some((n) =>
      n !== undefined && !Number.isSafeInteger(Number(n))
    )
  ) return null;
  return {
    eSeq: Number(m[1]),
    pSeq: m[2] ? Number(m[2]) : 0,
    tSeq: m[3] ? Number(m[3]) : 0,
    rSeq: m[4] ? Number(m[4]) : 0,
    aSeq: m[5] ? Number(m[5]) : 0,
    dSeq: m[6] ? Number(m[6]) : 0,
    mSeq: m[7] ? Number(m[7]) : 0,
    kSeq: m[8] ? Number(m[8]) : 0,
    ...(m[9] === undefined ? {} : { nSeq: Number(m[9]) }),
    ...(m[10] === undefined ? {} : { epoch: m[10] }),
  };
}

export function formatStreamToken(
  eSeq: number,
  pSeq: number,
  tSeq = 0,
  rSeq = 0,
  aSeq = 0,
  dSeq = 0,
  mSeq = 0,
  kSeq = 0,
  nSeq?: number,
  epoch?: string,
  domain?: string,
): string {
  const cuts =
    `s${eSeq}_p${pSeq}_t${tSeq}_r${rSeq}_a${aSeq}_d${dSeq}_m${mSeq}_k${kSeq}` +
    (nSeq === undefined ? '' : `_n${nSeq}`) +
    (epoch === undefined ? '' : `_z${epoch}`);
  if (domain === undefined) return cuts;
  return formatPosition(domain, cuts);
}

export function encodeStreamToken(t: StreamToken): string {
  return formatStreamToken(
    t.eSeq,
    t.pSeq,
    t.tSeq,
    t.rSeq,
    t.aSeq,
    t.dSeq,
    t.mSeq,
    t.kSeq,
    t.nSeq,
    t.epoch,
    t.domain,
  );
}
