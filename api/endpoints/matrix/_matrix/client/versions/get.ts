// Public, cumulative API labels approved after the v1.16 source audit.
// MATRIX-VERSIONS.md and versions-checklist.test.ts guard routes/contracts;
// the known-red Complement baseline is not itself an advertising criterion.
// The three Element creation-policy flags describe the configured presets.
import { config } from '#engine/config.ts';
// deno-lint-ignore require-await
export default async function () {
  return {
    versions: [
      'v1.1',
      'v1.2',
      'v1.3',
      'v1.4',
      'v1.5',
      'v1.6',
      'v1.7',
      'v1.8',
      'v1.9',
      'v1.10',
      'v1.11',
      'v1.12',
      'v1.13',
      'v1.14',
      'v1.15',
      'v1.16',
    ],
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
