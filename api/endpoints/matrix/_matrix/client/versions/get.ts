// No auth (per spec). matrix-nio's observed flows never call this
// (capture conclusion 3) — provided for spec shape / other clients.
// Honesty (amendment-1 C): advertise only labels whose requirements we
// meet — this list grows per milestone; a label is added when its
// Complement set is green. M2: v1.1 only (every later label implies
// room/sync features M3/M4 don't have yet). The inherited r0.6.1/v1.6
// placeholder is gone. Do not add v1.16 until the user rules it.
// unstable_features stays empty — no unstable features.
// deno-lint-ignore require-await
export default async function () {
  return {
    versions: ['v1.1'],
    unstable_features: {},
  };
}
