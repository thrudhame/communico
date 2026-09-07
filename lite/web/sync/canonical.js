// sync/canonical.js — browser port of api/engine/canonical.ts (MS0 step 0).
// Identity port fidelity (README rule 7): sorted keys at every level,
// arrays in order. Spec v1.11 appendices § Canonical JSON: integers in
// [-(2^53)+1, 2^53-1], no -0. Test vectors identical to
// tests/canonical.test.ts.
const INT_MIN = -(2 ** 53) + 1;
const INT_MAX = 2 ** 53 - 1;

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      out[k] = sortValue(v[k]);
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
