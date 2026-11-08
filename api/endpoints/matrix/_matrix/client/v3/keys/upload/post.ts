// POST /_matrix/client/v3/keys/upload — stub (phase-2 step 2.4; the
// capture lists this endpoint: matrix-commander constructs nio with
// encryption_enabled=True + a store, so nio uploads device keys on its
// first sync). E2EE is out of scope; --plain everywhere.
// deno-lint-ignore require-await
export default async function () {
  return { one_time_key_counts: {} };
}
