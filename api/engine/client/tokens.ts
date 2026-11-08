// Storage-neutral doltgres stream grammar; shared with room pagination.
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
};

export function parseStreamToken(raw: string | null): StreamToken | null {
  if (raw === null) return null;
  const m =
    /^s(\d+)(?:_p(\d+))?(?:_t(\d+))?(?:_r(\d+))?(?:_a(\d+))?(?:_d(\d+))?(?:_m(\d+))?(?:_k(\d+))?(?:_n(\d+))?$/
      .exec(
        raw,
      );
  if (!m) return null;
  if (
    m.slice(1).some((n) => n !== undefined && !Number.isSafeInteger(Number(n)))
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
): string {
  return `s${eSeq}_p${pSeq}_t${tSeq}_r${rSeq}_a${aSeq}_d${dSeq}_m${mSeq}_k${kSeq}` +
    (nSeq === undefined ? '' : `_n${nSeq}`);
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
  );
}
