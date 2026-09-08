import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';

// No auth (per spec). matrix-nio's observed flows never call this
// (capture conclusion 3) — provided for spec shape / other clients.
// M0: advertises unstable_features (empty — no unstable features).
// deno-lint-ignore require-await
export default async function (
  _request: TApiComponentRequest,
): TApiComponentOutcome {
  return [null, {
    versions: ['r0.6.1', 'v1.1', 'v1.6'],
    unstable_features: {},
  }];
}
