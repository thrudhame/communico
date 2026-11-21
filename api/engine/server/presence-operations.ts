// Explicit status is a causal register. Activity and sync leases never enter
// this durable history and importing status never refreshes an observation.
import type { Conn, Database } from '#engine/store/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { domainOf } from '#engine/ids.ts';
import { receivedFence } from '#engine/facade/journal.ts';
import {
  type DomainHistoryProof,
  requireDomainSources,
} from '#engine/facade/domain-control.ts';
import {
  importRegisterOperation,
  readRegister,
  registerJson,
  type RegisterOperation,
  registerOperations,
  writeRegister,
} from '#engine/facade/registers.ts';

async function authority(conn: Pick<Conn, 'query'>) {
  const [row] = await conn.query(
    'SELECT c.signed_json,p.node FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision CROSS JOIN publication_domain p WHERE p.singleton=1',
  );
  if (!row) return null;
  const body = JSON.parse(String(row.signed_json)).body;
  const nodes = body.nodes as { node: string; incarnation: string }[];
  const own = nodes.find((node) => node.node === row.node);
  if (!own) throw new Error('presence status source unavailable');
  return {
    server: String(body.server),
    source: own.node,
    incarnation: own.incarnation,
    nodes,
  };
}

function key(user: string) {
  return JSON.stringify(['presence-status', user.slice(1, user.indexOf(':'))]);
}

export async function requirePresenceStatus(
  conn: Pick<Conn, 'query'>,
  user: string,
) {
  const current = 'path' in conn && 'tx' in conn
    ? receivedFence(conn as Database)
    : undefined;
  const [binding] = await conn.query(
    "SELECT a.pairing,r.server_name FROM runtime_identity r LEFT JOIN facade_owner_activation a ON 1=1 WHERE r.singleton=1 AND r.role='facade'",
  );
  if (!binding || domainOf(user) !== binding.server_name) return;
  const [cut] = await conn.query(
    "SELECT s.received,s.received_hash,s.applied,s.applied_hash,f.ready,f.pending_hash FROM facade_streams s JOIN facade_scopes f ON f.incarnation=s.incarnation AND f.scope=? WHERE s.peer='home' AND s.direction='in' AND s.source='home' AND s.incarnation=? AND s.stream=?",
    ['presence-status:' + user, binding.pairing, 'domain:' + user],
  );
  if (
    !cut || cut.ready !== 1 || cut.pending_hash !== null ||
    cut.received !== cut.applied || cut.received_hash !== cut.applied_hash ||
    (current &&
      !current('home', {
        source: 'home',
        incarnation: String(binding.pairing),
        stream: 'domain:' + user,
      }))
  ) {
    throw new MatrixError(503, 'M_UNAVAILABLE', 'presence status unavailable');
  }
}

export async function presenceStatusOperations(conn: Conn, user: string) {
  return await registerOperations(conn, key(user));
}

export async function recordPresenceStatus(
  conn: Conn,
  user: string,
  status: string | null,
) {
  const source = await authority(conn);
  if (!source || domainOf(user) !== source.server) return;
  await requirePresenceStatus(conn, user);
  await writeRegister(
    conn,
    source,
    key(user),
    'presence-status',
    JSON.stringify({ user, status }),
  );
}

export async function capturePresenceStatus(conn: Conn, user: string) {
  const source = await authority(conn);
  if (!source || source.source !== 'home' || domainOf(user) !== source.server) {
    throw new Error('presence status source unavailable');
  }
  if (!(await presenceStatusOperations(conn, user)).length) {
    const [row] = await conn.query(
      'SELECT status_msg FROM presence WHERE user_id=?',
      [user],
    );
    await recordPresenceStatus(
      conn,
      user,
      row?.status_msg == null ? null : String(row.status_msg),
    );
  }
  return await presenceStatusOperations(conn, user);
}

export async function acceptPresenceStatus(
  conn: Conn,
  operation: RegisterOperation,
  history?: DomainHistoryProof,
) {
  const source = await authority(conn);
  const value = JSON.parse(operation.payload);
  if (
    !source || !value || typeof value.user !== 'string' ||
    !/^@[^:]+:.+$/.test(value.user) ||
    domainOf(value.user) !== source.server ||
    !(value.status === null || typeof value.status === 'string') ||
    operation.kind !== 'presence-status' ||
    operation.semanticKey !== key(value.user) ||
    operation.payload !==
      registerJson(JSON.stringify({ user: value.user, status: value.status }))
  ) {
    throw new Error('invalid presence status');
  }
  await requireDomainSources(
    conn,
    operation,
    source.nodes.map((node) => ({
      source: node.node,
      incarnation: node.incarnation,
    })),
    value.user.slice(1, value.user.indexOf(':')),
    history,
  );
  if (
    source.source === 'home' &&
    !(await presenceStatusOperations(conn, value.user)).length
  ) {
    await capturePresenceStatus(conn, value.user);
  }
  const result = await importRegisterOperation(conn, operation);
  const winner = (await readRegister(conn, operation.semanticKey)).winner;
  return {
    user: value.user as string,
    status: winner ? JSON.parse(winner.payload).status as string | null : null,
    changed: result.changed,
    available: winner !== null,
  };
}
