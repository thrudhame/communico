// Canonical JSON (spec v1.11 appendices § Canonical JSON): shortest
// UTF-8 JSON with dictionary keys lexicographically sorted. Numbers must
// be integers in [-(2^53)+1, 2^53-1] with no exponents/decimal places,
// and -0 MUST NOT appear. Out-of-range integers throw (a ts=2^53 seize
// is refused at ingest, not normalized).
import { MatrixError } from './matrix-error.ts';

const INT_MIN = -(2 ** 53) + 1;
const INT_MAX = 2 ** 53 - 1;

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

// D9 pre-flight over event content: the same number rules as sortValue,
// thrown as M_BAD_JSON so a non-canonical client body is a 400, never a
// signing-time 500 (spec appendices § Canonical JSON, v1.16 lines 90-94).
export function assertCanonicalNumbers(value: unknown): void {
  if (Array.isArray(value)) {
    for (const v of value) assertCanonicalNumbers(v);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      assertCanonicalNumbers(v);
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new MatrixError(
        400,
        'M_BAD_JSON',
        'canonical JSON forbids non-integer numbers',
      );
    }
    if (Object.is(value, -0) || value < INT_MIN || value > INT_MAX) {
      throw new MatrixError(
        400,
        'M_BAD_JSON',
        'canonical JSON forbids out-of-range integers',
      );
    }
  }
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
