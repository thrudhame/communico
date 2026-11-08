// Uncaught non-HttpError → the 500 outcome (fixture for
// tests/http-contract.test.ts — proves the outcome cascade + CORS stamp
// composition without needing a broken DB).
// deno-lint-ignore require-await
export default async function () {
  throw new Error('boom');
}
