// Canonical JSON (spec v1.11 appendices § Canonical JSON): shortest
// UTF-8 JSON with dictionary keys lexicographically sorted. Numbers must
// be integers in [-(2^53)+1, 2^53-1] with no exponents/decimal places,
// and -0 MUST NOT appear. Out-of-range integers throw (a ts=2^53 seize
// is refused at ingest, not normalized).
const INT_MIN = -(2 ** 53) + 1;
const INT_MAX = 2 ** 53 - 1;

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) {
      throw new Error('canonical JSON forbids non-integer numbers');
    }
    if (Object.is(v, -0) || v < INT_MIN || v > INT_MAX) {
      throw new Error('canonical JSON forbids out-of-range integers');
    }
  }
  return v;
}
