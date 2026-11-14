// Replicate the home-approved peer policy, never delivery state, credentials,
// pending admission claims, cached key evidence or operator annotations.
import { MatrixError } from '#engine/matrix-error.ts';
import type { Conn } from '#engine/store/db.ts';
import {
  exportFederationPolicy,
  type FederationPolicy,
  policyOf,
} from './policy.ts';

export type PeerPolicy = {
  federation: FederationPolicy;
  peers: {
    name: string;
    host: string | null;
    port: number | null;
    trust: 'ca' | 'pinned' | 'keyname';
    pin: string | null;
    added: number;
    by: string;
  }[];
  blocks: { pattern: string; added: number }[];
};
function bad(): never {
  throw new MatrixError(400, 'M_BAD_JSON', 'invalid public peer policy');
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad();
  return raw as Record<string, unknown>;
}
function text(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) bad();
  return raw;
}
function integer(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) bad();
  return raw;
}
export function peerPolicyOf(raw: unknown): PeerPolicy {
  const value = object(raw);
  if (!Array.isArray(value.peers) || !Array.isArray(value.blocks)) bad();
  const peers = value.peers.map((raw): PeerPolicy['peers'][number] => {
    const p = object(raw);
    if (p.trust !== 'ca' && p.trust !== 'pinned' && p.trust !== 'keyname') {
      bad();
    }
    const host = p.host === null ? null : text(p.host);
    const port = p.port === null ? null : integer(p.port);
    if (port !== null && (port === 0 || port > 65535)) bad();
    const pin = p.pin === null ? null : text(p.pin);
    if (pin !== null && !/^[a-f0-9]{64}$/.test(pin)) bad();
    return {
      name: text(p.name),
      host,
      port,
      trust: p.trust,
      pin,
      added: integer(p.added),
      by: text(p.by),
    };
  });
  const blocks = value.blocks.map((raw) => {
    const b = object(raw);
    return { pattern: text(b.pattern), added: integer(b.added) };
  });
  if (
    new Set(peers.map((p) => p.name)).size !== peers.length ||
    new Set(blocks.map((b) => b.pattern)).size !== blocks.length
  ) bad();
  return { peers, blocks, federation: policyOf(value.federation) };
}
export async function exportPeerPolicy(conn: Conn): Promise<PeerPolicy> {
  return peerPolicyOf({
    federation: await exportFederationPolicy(conn),
    peers: (await conn.query(
      'SELECT name,host,port,trust,pin_spki_sha256,added_ms,added_by FROM federation_peers ORDER BY added_ms,name',
    )).map((p) => ({
      name: String(p.name),
      host: p.host === null ? null : String(p.host),
      port: p.port === null ? null : Number(p.port),
      trust: String(p.trust),
      pin: p.pin_spki_sha256 === null ? null : String(p.pin_spki_sha256),
      added: Number(p.added_ms),
      by: String(p.added_by),
    })),
    blocks: (await conn.query(
      'SELECT pattern,added_ms FROM federation_blocks ORDER BY added_ms,pattern',
    )).map((b) => ({
      pattern: String(b.pattern),
      added: Number(b.added_ms),
    })),
  });
}
export async function installPeerPolicy(
  conn: Conn,
  raw: unknown,
): Promise<void> {
  const policy = peerPolicyOf(raw);
  await conn.execute(
    'INSERT INTO federation_policy(singleton,policy_json) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET policy_json=excluded.policy_json',
    [JSON.stringify(policy.federation)],
  );
  await conn.execute('DELETE FROM federation_peers');
  for (const p of policy.peers) {
    await conn.execute(
      'INSERT INTO federation_peers(name,host,port,trust,pin_spki_sha256,added_ms,added_by,note) VALUES(?,?,?,?,?,?,?,NULL)',
      [p.name, p.host, p.port, p.trust, p.pin, p.added, p.by],
    );
    await conn.execute(
      "DELETE FROM federation_pending WHERE name=? AND kind IN ('inbound','outbound')",
      [p.name],
    );
  }
  await conn.execute('DELETE FROM federation_blocks');
  for (const b of policy.blocks) {
    await conn.execute(
      'INSERT INTO federation_blocks(pattern,added_ms,note) VALUES(?,?,NULL)',
      [b.pattern, b.added],
    );
  }
}
