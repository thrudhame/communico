// Current published network admission, not DAG event authorization. This owner
// is network-free so admission can be rechecked inside the room write boundary.
import { isIP } from 'node:net';
import { MatrixError } from '#engine/matrix-error.ts';
import type { RoomTx } from './index.ts';

function hostname(server: string): string | null {
  if (server.length > 261) return null;
  const match = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]+))?$/.exec(
    server,
  );
  if (match === null) return null;
  if (
    match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535)
  ) return null;
  const host = match[1];
  if (host.startsWith('[') && isIP(host.slice(1, -1)) !== 6) return null;
  return host;
}

function matches(pattern: string, host: string): boolean {
  // Matrix globs, not regular expressions. A bounded host and iterative
  // wildcard walk avoid regex backtracking on attacker-authored patterns.
  pattern = pattern.toLowerCase();
  host = host.toLowerCase();
  let p = 0, h = 0, star = -1, retry = 0;
  while (h < host.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === host[h])) {
      p++;
      h++;
    } else if (pattern[p] === '*') {
      star = p++;
      retry = h;
    } else if (star >= 0) {
      p = star + 1;
      h = ++retry;
    } else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

export function serverAllowed(
  server: string,
  content: unknown | null,
): boolean {
  const host = hostname(server);
  if (host === null) return false;
  if (content === null) return true; // Absent event, not an empty ACL.
  const acl =
    content !== null && typeof content === 'object' && !Array.isArray(content)
      ? content as Record<string, unknown>
      : {};
  if (
    acl.allow_ip_literals === false &&
    (host.startsWith('[') || isIP(host) !== 0)
  ) return false;
  const list = (key: string) =>
    Array.isArray(acl[key])
      ? (acl[key] as unknown[]).filter((p): p is string =>
        typeof p === 'string'
      )
      : [];
  if (list('deny').some((p) => matches(p, host))) return false;
  return list('allow').some((p) => matches(p, host));
}

export async function aclAllows(tx: RoomTx, server: string): Promise<boolean> {
  const stay = await tx.segments.openStay() ?? await tx.segments.latestStay();
  if (stay === null) return serverAllowed(server, null);
  const group = await tx.state.current(stay.id);
  if (group === null) {
    throw new Error('E_ACL_STATE_UNKNOWN: published room state missing');
  }
  const id = await tx.state.groupKey(group, 'm.room.server_acl', '');
  if (id === null) return serverAllowed(server, null);
  const row = await tx.events.get(id);
  if (row === null) throw new Error('E_ACL_STATE_UNKNOWN: ACL event missing');
  if (await tx.changes.redactionOf(id) !== null) {
    return serverAllowed(server, {});
  }
  return serverAllowed(server, JSON.parse(row.pdu).content ?? {});
}

export async function assertAcl(tx: RoomTx, server: string): Promise<void> {
  if (!await aclAllows(tx, server)) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'server denied by room ACL');
  }
}
