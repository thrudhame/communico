// Storage-neutral doltgres stream grammar; shared with room pagination.
export type StreamToken = {
  eSeq: number;
  pSeq: number;
  tSeq: number;
  rSeq: number;
  aSeq: number;
};

export function parseStreamToken(raw: string | null): StreamToken | null {
  if (raw === null) return null;
  const m = /^s(\d+)(?:_p(\d+))?(?:_t(\d+))?(?:_r(\d+))?(?:_a(\d+))?$/.exec(
    raw,
  );
  if (!m) return null;
  return {
    eSeq: Number(m[1]),
    pSeq: m[2] ? Number(m[2]) : 0,
    tSeq: m[3] ? Number(m[3]) : 0,
    rSeq: m[4] ? Number(m[4]) : 0,
    aSeq: m[5] ? Number(m[5]) : 0,
  };
}

export function formatStreamToken(
  eSeq: number,
  pSeq: number,
  tSeq = 0,
  rSeq = 0,
  aSeq = 0,
): string {
  return `s${eSeq}_p${pSeq}_t${tSeq}_r${rSeq}_a${aSeq}`;
}
