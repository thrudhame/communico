// api/engine/federation/gate.ts — the admission gate. Order: (1) block
// globs → 403; (2) closed mode + no roster row → the unverified claim is
// bucketed and 403'd (server administration is a separate plane — the
// operator approves through the tool; EVERY local user's outbound intent
// queues the same way); (3) open mode + no roster row: inbound proceeds
// (the knock records after the signature verifies), outbound by
// authenticated user intent lands on the roster as trust 'ca'; (4) a
// 'blocking' key change → 403. Anonymous lookups never reach here as
// outbound intent.
import { config } from '#engine/config.ts';
import { serverDb, withDb } from '#engine/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { addPeer, isBlocked, lookupPeer, recordPending } from './peers.ts';

export type GateContext =
  | { kind: 'inbound'; endpoint: string }
  | { kind: 'outbound'; user: string; what: string };

async function hasBlockingChange(name: string): Promise<boolean> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      "SELECT 1 FROM server_key_changes WHERE server_name = $1 AND status = 'blocking' LIMIT 1;",
      [name],
    );
    return r.rows.length > 0;
  });
}

export async function admit(name: string, ctx: GateContext): Promise<'ok'> {
  // (1) blocks
  if (await isBlocked(name)) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      `federation with ${name} is blocked`,
    );
  }
  const peer = await lookupPeer(name);
  const mode = config().federation.mode;
  // (2) closed mode: the unverified claim is bucketed, then refused
  if (peer === null && mode === 'closed') {
    const detail = ctx.kind === 'inbound'
      ? ctx.endpoint
      : `${ctx.user} — ${ctx.what}`;
    await recordPending(name, ctx.kind, false, detail);
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      `server ${name} is not in this federation; the admin has been asked`,
    );
  }
  // (3) open mode: inbound proceeds; outbound user intent joins the roster
  if (peer === null && mode === 'open' && ctx.kind === 'outbound') {
    await addPeer({
      name,
      host: null,
      port: null,
      trust: 'ca',
      addedBy: ctx.user,
    });
  }
  // (4) a blocking key change pauses the server until the admin accepts
  if (await hasBlockingChange(name)) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      `server ${name} changed its signing key; paused until the admin accepts`,
    );
  }
  return 'ok';
}
