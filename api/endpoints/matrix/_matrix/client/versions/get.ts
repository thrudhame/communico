// No auth (per spec). matrix-nio's observed flows never call this
// (capture conclusion 3) — provided for spec shape / other clients.
// Honesty (amendment-1 C): advertise only labels whose requirements we
// meet — this list grows per milestone; a label is added when its
// Complement set is green. M2: v1.1 only (every later label implies
// room/sync features M3/M4 don't have yet). The inherited r0.6.1/v1.6
// placeholder is gone. Do not add v1.16 until the user rules it.
// The three Element creation-policy flags describe the configured presets.
import { config } from '#engine/config.ts';
// deno-lint-ignore require-await
export default async function () {
  return {
    versions: ['v1.1'],
    unstable_features: {
      'io.element.e2ee_forced.public': !config().encryption
        .allowunencryptedcreation,
      'io.element.e2ee_forced.private': !config().encryption
        .allowunencryptedcreation,
      'io.element.e2ee_forced.trusted_private': !config().encryption
        .allowunencryptedcreation,
    },
  };
}
