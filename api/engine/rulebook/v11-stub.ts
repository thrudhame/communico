// api/engine/rulebook/v11-stub.ts — server-side entry to the shared
// refusing stub. The implementation lives in exactly one source file,
// lite/web/sync/rulebook/v11-stub.js, consumed by both engines
// (byte-identical selection is a correctness requirement). This module
// only re-exports it with server-side types.
export {
  authorized,
  resolveState,
  selectAuthEvents,
  stateKeyOf,
  version,
} from '../../../lite/web/sync/rulebook/v11-stub.js';
