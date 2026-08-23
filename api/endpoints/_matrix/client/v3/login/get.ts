import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';

// Login flows list (no auth). matrix-commander probes the r0 alias of
// this exact shape (see demo/capture/endpoints-capture.md row 1).
// deno-lint-ignore require-await
export default async function (
  _request: TApiComponentRequest,
): TApiComponentOutcome {
  return [null, { flows: [{ type: 'm.login.password' }] }];
}
