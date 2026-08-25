// sync/canonical.js — browser port of api/engine/canonical.ts (MS0 step 0).
// Identity port fidelity (README rule 7): sorted keys at every level,
// arrays in order, non-integer numbers rejected. Test vectors identical
// to tests/canonical.test.ts.
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
  if (typeof v === 'number' && !Number.isInteger(v)) {
    throw new Error('canonical JSON forbids non-integer numbers');
  }
  return v;
}
