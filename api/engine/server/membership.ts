import type { Conn, Database } from '#engine/store/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { domainOf, localpartOf } from '#engine/ids.ts';
import {
  type DomainHistoryProof,
  requireDomainSources,
} from '#engine/facade/domain-control.ts';
import {
  captureRegisterBaseline,
  importRegisterOperation,
  readRegister,
  registerJson,
  type RegisterOperation,
  registerOperations,
  writeRegister,
} from '#engine/facade/registers.ts';
import type { LocalJoinObservation } from '#engine/room/hooks.ts';
import { receivedFence } from '#engine/facade/journal.ts';

async function authority(conn: Pick<Conn, 'query'>) {
  const [row] = await conn.query(
    'SELECT c.signed_json,p.node FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision CROSS JOIN publication_domain p WHERE p.singleton=1',
  );
  if (!row) {
    // Standalone home writes already have a boot-independent publication
    // identity. Enrollment later signs that same incarnation, not a new writer.
    const [home] = await conn.query(
      "SELECT p.node,p.incarnation,r.server_name FROM publication_domain p JOIN runtime_identity r ON r.singleton=1 AND r.role='home' WHERE p.singleton=1",
    );
    if (!home) return null;
    return {
      server: String(home.server_name),
      source: String(home.node),
      incarnation: String(home.incarnation),
      nodes: [{
        node: String(home.node),
        incarnation: String(home.incarnation),
      }],
    };
  }
  const body = JSON.parse(String(row.signed_json)).body;
  const nodes = body.nodes as { node: string; incarnation: string }[];
  const node = nodes.find((node) => node.node === row.node);
  if (!node) throw new Error('forget source unavailable');
  return {
    server: String(body.server),
    source: node.node,
    incarnation: node.incarnation,
    nodes,
  };
}
const keyOf = (user: string, room: string) =>
  JSON.stringify(['forget', localpartOf(user), room]);
type ForgetValue = { action: 'forget' } | {
  action: 'rejoin';
  eventId: string;
  observed: string[];
};
export type RejoinObservation = {
  user: string;
  source: string | null;
  incarnation: string | null;
  observed: string[];
};

function valueOf(operation: RegisterOperation): ForgetValue {
  let value: ForgetValue;
  try {
    value = JSON.parse(operation.payload);
  } catch {
    throw new Error('invalid forget fact');
  }
  if (
    !value || (value.action !== 'forget' && value.action !== 'rejoin') ||
    registerJson(JSON.stringify(value)) !== operation.payload ||
    (value.action === 'forget'
      ? Object.keys(value).length !== 1
      : Object.keys(value).length !== 3 || typeof value.eventId !== 'string' ||
        !value.eventId.startsWith('$') || !Array.isArray(value.observed) ||
        value.observed.some((id) => typeof id !== 'string') ||
        new Set(value.observed).size !== value.observed.length)
  ) {
    throw new Error('invalid forget fact');
  }
  return value;
}

async function purgeable(conn: Conn, room: string, self: string) {
  const rows = await conn.query(
    "SELECT m.user FROM memberships m LEFT JOIN forgotten f ON f.user=m.user AND f.room=m.room WHERE m.room=? AND (f.user IS NULL OR m.membership='join')",
    [room],
  );
  if (rows.some((row) => domainOf(String(row.user)) === self)) {
    await conn.execute(
      'UPDATE directory SET purgeable_ms=NULL WHERE room_id=?',
      [room],
    );
  } else {
    await conn.execute(
      'INSERT INTO directory(room_id,purgeable_ms) VALUES(?,?) ON CONFLICT(room_id) DO UPDATE SET purgeable_ms=COALESCE(directory.purgeable_ms,excluded.purgeable_ms)',
      [room, Date.now()],
    );
  }
}

async function materialize(
  conn: Conn,
  user: string,
  room: string,
  self: string,
) {
  // This type is remove-wins, not the generic register's tuple winner. An
  // observation names exact forget facts, never projection-time causal context.
  const view = await readRegister(conn, keyOf(user, room));
  const ready = [view.winner, ...view.conflicts].filter((
    op,
  ): op is RegisterOperation => op !== null);
  if (!ready.length && view.pending.length) return;
  const removed = new Set(ready.flatMap((op) => {
    const value = valueOf(op);
    return value.action === 'rejoin' ? value.observed : [];
  }));
  if (
    ready.some((op) =>
      valueOf(op).action === 'forget' && !removed.has(op.operationId)
    )
  ) {
    await conn.execute(
      'INSERT INTO forgotten(user,room) VALUES(?,?) ON CONFLICT DO NOTHING',
      [user, room],
    );
  } else {
    await conn.execute('DELETE FROM forgotten WHERE user=? AND room=?', [
      user,
      room,
    ]);
  }
  await purgeable(conn, room, self);
}

/** Old manifests do not prove absence of private visibility intent. */
export async function requireForgetKnowledge(
  conn: Pick<Conn, 'query'>,
  user: string,
) {
  const current = 'path' in conn && 'tx' in conn
    ? receivedFence(conn as Database)
    : undefined;
  const [binding] = await conn.query(
    "SELECT a.pairing,r.server_name FROM facade_owner_activation a JOIN runtime_identity r ON r.singleton=1 AND r.role='facade'",
  );
  if (!binding || domainOf(user) !== binding.server_name) return;
  const [cut] = await conn.query(
    "SELECT s.received,s.received_hash,s.applied,s.applied_hash,f.ready FROM facade_streams s JOIN facade_scopes f ON f.incarnation=s.incarnation AND f.scope=? WHERE s.peer='home' AND s.direction='in' AND s.source='home' AND s.incarnation=? AND s.stream=?",
    ['forget:' + user, binding.pairing, 'domain:' + user],
  );
  const pending = await conn.query(
    "SELECT 1 FROM domain_operations o WHERE o.kind='forget' AND json_extract(o.semantic_key,'$[1]')=? AND NOT EXISTS (SELECT 1 FROM domain_frontiers f WHERE f.operation_id=o.operation_id) AND NOT EXISTS (SELECT 1 FROM domain_conflicts c WHERE c.operation_id=o.operation_id) LIMIT 1",
    [localpartOf(user)],
  );
  if (
    !cut || cut.ready !== 1 || cut.received !== cut.applied ||
    cut.received_hash !== cut.applied_hash || pending.length ||
    (current &&
      !current('home', {
        source: 'home',
        incarnation: String(binding.pairing),
        stream: 'domain:' + user,
      }))
  ) {
    throw new MatrixError(503, 'M_UNAVAILABLE', 'forget snapshot unavailable');
  }
}

export async function forgetOperations(conn: Conn, user: string) {
  const keys = await conn.query(
    "SELECT DISTINCT semantic_key FROM domain_operations WHERE kind='forget' AND json_extract(semantic_key,'$[1]')=? ORDER BY semantic_key",
    [localpartOf(user)],
  );
  const result: RegisterOperation[] = [];
  for (const row of keys) {
    result.push(...await registerOperations(conn, String(row.semantic_key)));
  }
  return result;
}

export async function captureForgetOperations(conn: Conn, user: string) {
  const source = await authority(conn);
  if (!source || source.source !== 'home' || domainOf(user) !== source.server) {
    throw new Error('forget bootstrap requires home authority');
  }
  for (
    const row of await conn.query('SELECT room FROM forgotten WHERE user=?', [
      user,
    ])
  ) {
    const key = keyOf(user, String(row.room));
    if (!(await registerOperations(conn, key)).length) {
      await writeRegister(
        conn,
        source,
        key,
        'forget',
        JSON.stringify({ action: 'forget' }),
      );
    }
  }
  return await forgetOperations(conn, user);
}

/** Prepared outside room transactions; only exact accepted joins retain it. */
export async function prepareRejoin(
  db: Database,
  room: string,
  user: string,
): Promise<LocalJoinObservation> {
  const observation = await db.tx(async (conn) => {
    const source = await authority(conn);
    if (source && domainOf(user) !== source.server) {
      throw new Error('forget account differs');
    }
    if (source) await requireForgetKnowledge(conn, user);
    if (source?.source === 'home') await captureForgetOperations(conn, user);
    const view = await readRegister(conn, keyOf(user, room));
    const ready = [view.winner, ...view.conflicts].filter((
      op,
    ): op is RegisterOperation => op !== null);
    return {
      user,
      source: source?.source ?? null,
      incarnation: source?.incarnation ?? null,
      observed: ready.filter((op) => valueOf(op).action === 'forget').map((
        op,
      ) => op.operationId).sort(),
    };
  });
  return observation;
}

export async function projectRejoin(
  conn: Conn,
  room: string,
  eventId: string,
  observation: RejoinObservation,
  self: string,
) {
  if (
    typeof observation.user !== 'string' ||
    domainOf(observation.user) !== self ||
    !Array.isArray(observation.observed) ||
    observation.observed.some((id) => typeof id !== 'string')
  ) throw new Error('invalid rejoin observation');
  const source = await authority(conn);
  if (observation.source === null) {
    // Standalone work cannot gain distributed authorship at later projection.
    if (!source) {
      await conn.execute('DELETE FROM forgotten WHERE user=? AND room=?', [
        observation.user,
        room,
      ]);
    }
    // A pre-identity observation cannot claim that it observed later enrolled
    // intent. Retain it as evidence without inventing distributed authorship.
  } else {
    if (
      !source || source.source !== observation.source ||
      source.incarnation !== observation.incarnation
    ) throw new Error('rejoin source changed');
    const key = keyOf(observation.user, room);
    if (
      !(await registerOperations(conn, key)).some((op) => {
        const value = valueOf(op);
        return op.source === source.source &&
          op.incarnation === source.incarnation && value.action === 'rejoin' &&
          value.eventId === eventId;
      })
    ) {
      await writeRegister(
        conn,
        source,
        key,
        'forget',
        JSON.stringify({
          action: 'rejoin',
          eventId,
          observed: observation.observed,
        }),
      );
    }
    await materialize(conn, observation.user, room, self);
  }
  await conn.execute('UPDATE directory SET purgeable_ms=NULL WHERE room_id=?', [
    room,
  ]);
}

export async function importForgetOperation(
  db: Database,
  operation: RegisterOperation,
  check: (conn: Conn) => Promise<void>,
  history?: DomainHistoryProof,
) {
  let key: unknown;
  try {
    key = JSON.parse(operation.semanticKey);
  } catch {
    throw new Error('invalid forget fact');
  }
  if (
    !Array.isArray(key) || key.length !== 3 || key[0] !== 'forget' ||
    typeof key[1] !== 'string' || !key[1] || typeof key[2] !== 'string' ||
    !key[2].startsWith('!') || operation.kind !== 'forget' ||
    JSON.stringify(key) !== operation.semanticKey
  ) throw new Error('invalid forget fact');
  valueOf(operation);
  const name = key[1], room = key[2];
  await db.tx(async (conn) => {
    await check(conn);
    const source = await authority(conn);
    if (!source) throw new Error('forget source unavailable');
    await requireDomainSources(
      conn,
      operation,
      source.nodes.map((node) => ({
        source: node.node,
        incarnation: node.incarnation,
      })),
      name,
      history,
    );
    if (
      source.source === 'home' &&
      (await conn.query('SELECT 1 FROM forgotten WHERE user=? AND room=?', [
        '@' + name + ':' + source.server,
        room,
      ])).length
    ) {
      await captureRegisterBaseline(
        conn,
        source,
        operation.semanticKey,
        'forget',
        JSON.stringify({ action: 'forget' }),
        operation,
      );
    }
    await importRegisterOperation(conn, operation);
    await materialize(
      conn,
      '@' + name + ':' + source.server,
      room,
      source.server,
    );
  });
}

/** Bootstrap reconciles an earlier F1 display snapshot, including an empty set. */
export async function installForgetInventory(
  conn: Conn,
  user: string,
  self: string,
) {
  const rooms = new Set(
    (await conn.query('SELECT room FROM forgotten WHERE user=?', [user])).map((
      row,
    ) => String(row.room)),
  );
  for (const op of await forgetOperations(conn, user)) {
    rooms.add(JSON.parse(op.semanticKey)[2]);
  }
  for (const room of rooms) await materialize(conn, user, room, self);
}

export async function clearPurgeable(
  db: Database,
  roomId: string,
  _userId: string,
) {
  await db.tx(async (tx) => {
    await tx.execute(
      'UPDATE directory SET purgeable_ms = NULL WHERE room_id = ?',
      [roomId],
    );
  });
}

export async function forget(
  db: Database,
  roomId: string,
  userId: string,
  self: string,
) {
  await db.tx(async (tx) => {
    const [current] = await tx.query(
      'SELECT membership FROM memberships WHERE user=? AND room=?',
      [userId, roomId],
    );
    if (current?.membership === 'join') {
      throw new MatrixError(
        400,
        'M_UNKNOWN',
        `User ${userId} is in room ${roomId}`,
      );
    }
    if (!current) {
      throw new MatrixError(400, 'M_UNKNOWN', 'no membership to forget');
    }
    const source = await authority(tx);
    if (source) {
      await requireForgetKnowledge(tx, userId);
      if (domainOf(userId) !== source.server || self !== source.server) {
        throw new Error('forget account differs');
      }
      await writeRegister(
        tx,
        source,
        keyOf(userId, roomId),
        'forget',
        JSON.stringify({ action: 'forget' }),
      );
    }
    await tx.execute(
      'INSERT INTO forgotten(user, room) VALUES(?,?) ON CONFLICT DO NOTHING',
      [userId, roomId],
    );
    await purgeable(tx, roomId, self);
  });
}
