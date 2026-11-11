// api/engine/federation/gate.ts — the admission gate. Order: (1) block
// globs → 403; (2) closed mode + no roster row → the unverified claim is
// bucketed and 403'd (server administration is a separate plane — the
// operator approves through the tool; EVERY local user's outbound intent
// queues the same way); (3) open mode + no roster row: inbound proceeds
// (the knock records after the signature verifies), outbound by
// authenticated user intent lands on the roster as trust 'ca'; (4) a
// 'blocking' key change → 403. Read-only discovery never becomes outbound
// participation intent or adds a roster row. approve/reject are the operator's doors on the door
// log (a 'refused' row is a delivery record, not a knock). Ported from
// doltgres; the server file's Db is explicit (no global database).
import { config } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Database as Db } from '#engine/store/db.ts';
import {
  addBlock,
  addPeer,
  isBlocked,
  lookupPeer,
  recordPending,
} from './peers.ts';

export type GateContext =
  | { kind: 'inbound'; endpoint: string }
  | { kind: 'outbound'; user: string; what: string }
  | { kind: 'lookup'; what: string };

async function hasBlockingChange(server: Db, name: string): Promise<boolean> {
  const rows = await server.query(
    "SELECT 1 FROM server_key_changes WHERE server_name = ? AND status = 'blocking' LIMIT 1",
    [name],
  );
  return rows.length > 0;
}

export async function admit(
  server: Db,
  name: string,
  ctx: GateContext,
): Promise<'ok'> {
  // (1) blocks
  if (await isBlocked(server, name)) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      `federation with ${name} is blocked`,
    );
  }
  const peer = await lookupPeer(server, name);
  const mode = config().federation.mode;
  // (2) closed mode: the unverified claim is bucketed, then refused
  if (peer === null && mode === 'closed') {
    if (ctx.kind === 'lookup') {
      throw new MatrixError(
        403,
        'M_FORBIDDEN',
        `server ${name} is not in this federation`,
      );
    }
    const detail = ctx.kind === 'inbound'
      ? ctx.endpoint
      : `${ctx.user} - ${ctx.what}`;
    await recordPending(
      server,
      name,
      ctx.kind === 'inbound' ? 'inbound' : 'outbound',
      false,
      detail,
    );
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      `server ${name} is not in this federation; the admin has been asked`,
    );
  }
  // (3) open mode: inbound proceeds; outbound user intent joins the roster
  if (peer === null && mode === 'open' && ctx.kind === 'outbound') {
    await addPeer(server, {
      name,
      host: null,
      port: null,
      trust: 'ca',
      addedBy: ctx.user,
    });
  }
  // (4) a blocking key change pauses the server until the admin accepts
  if (await hasBlockingChange(server, name)) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      `server ${name} changed its signing key; paused until the admin accepts`,
    );
  }
  return 'ok';
}

/** approve → move the pending claim onto the roster. */
export async function approvePending(
  server: Db,
  name: string,
  host: string | null,
  port: number | null,
): Promise<void> {
  // a 'refused' row is a delivery record, not a knock — nothing to admit
  const refused = await server.query(
    "SELECT 1 FROM federation_pending WHERE name = ? AND kind = 'refused'",
    [name],
  );
  if (refused.length > 0) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      `${name} has a delivery record, not a knock — see federation-outbox list`,
    );
  }
  const existing = await lookupPeer(server, name);
  if (existing !== null) return;
  await addPeer(server, {
    name,
    host,
    port,
    trust: 'ca',
    addedBy: 'approval',
  });
}

/** reject → drop the claim; with block=true also refuse the name forward. */
export async function rejectPending(
  server: Db,
  name: string,
  block: boolean,
): Promise<void> {
  await server.execute('DELETE FROM federation_pending WHERE name = ?', [name]);
  if (block) await addBlock(server, name, 'rejected at the door');
}
