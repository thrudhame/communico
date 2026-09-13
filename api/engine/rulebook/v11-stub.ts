// api/engine/rulebook/v11-stub.ts — server-side entry to the shared
// refusing stub. The implementation lives in exactly one source file,
// (was lite/web/sync/rulebook/v11-stub.js, moved into the engine; the shim itself is unused)
// (byte-identical selection is a correctness requirement). This module
// only re-exports it with server-side types.
export {
  authorized,
  resolveState,
  selectAuthEvents,
  stateKeyOf,
  version,
} from '#engine/rulebook/v11-stub.js';
