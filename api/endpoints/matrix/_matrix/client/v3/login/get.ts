export const auth = false;

// Login flows list (no auth). matrix-commander probes the r0 alias of
// this exact shape (see demo/capture/endpoints-capture.md row 1).
// deno-lint-ignore require-await
export default async function () {
  return { flows: [{ type: 'm.login.password' }] };
}
