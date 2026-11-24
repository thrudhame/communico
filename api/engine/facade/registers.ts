// Causal register mechanics shared by semantic owners. Callers authenticate
// imports and materialize the returned winner in this SAME owning transaction.
// No row cloning, foreign stream positions, wall clocks or owner side effects.
import { createHash } from 'node:crypto';
import type { Conn } from '#engine/store/db.ts';

export type RegisterSource = { source: string; incarnation: string };
export type RegisterDot = RegisterSource & { sequence: number };
export type RegisterOperation = RegisterDot & {
  operationId: string;
  stream: string;
  semanticKey: string;
  kind: string;
  context: RegisterDot[];
  payloadHash: string;
  // Opaque JSON travels as a string: Matrix canonical JSON's integer-only
  // restriction applies to PDUs, not to account data, profiles or tag order.
  payload: string;
};

export type RegisterView = {
  winner: RegisterOperation | null;
  frontier: RegisterOperation[];
  conflicts: RegisterOperation[];
  pending: RegisterOperation[];
};

function ascii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compare(a: RegisterDot, b: RegisterDot): number {
  return ascii(a.source, b.source) || ascii(a.incarnation, b.incarnation) ||
    a.sequence - b.sequence;
}

function domain(dot: RegisterSource): string {
  return JSON.stringify([dot.source, dot.incarnation]);
}

function identity(dot: RegisterDot, stream: string): string {
  return JSON.stringify([dot.source, dot.incarnation, stream, dot.sequence]);
}

function sourceOf(value: RegisterSource): void {
  if (
    typeof value.source !== 'string' || !/^[\x21-\x7e]+$/.test(value.source) ||
    typeof value.incarnation !== 'string' ||
    !/^[\x21-\x7e]+$/.test(value.incarnation)
  ) throw new Error('invalid register source');
}

function dotOf(value: RegisterDot): void {
  sourceOf(value);
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new Error('invalid register sequence');
  }
}

/** JSON, not Matrix canonical JSON. Sorting keys provides stable value/hash
 * identity without changing valid fractional numbers or interpreting secrets. */
export function registerJson(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Parser diagnostics can quote secret-storage ciphertext or profile data.
    throw new Error('invalid register JSON');
  }
  function ordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(ordered);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => ascii(a, b)).map(([k, v]) => [
          k,
          ordered(v),
        ]),
      );
    }
    // JSON.parse accepts 1e400 as Infinity. It is not a JSON numeric value we
    // can preserve; silently serializing it as null would corrupt the payload.
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('invalid register JSON number');
    }
    return value;
  }
  return JSON.stringify(ordered(parsed));
}

function hash(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

function checked(raw: RegisterOperation): RegisterOperation {
  dotOf(raw);
  if (
    typeof raw.semanticKey !== 'string' || !raw.semanticKey ||
    typeof raw.kind !== 'string' || !raw.kind ||
    raw.stream !== 'register:' + raw.semanticKey ||
    raw.operationId !== identity(raw, raw.stream) ||
    !Array.isArray(raw.context) || typeof raw.payload !== 'string'
  ) throw new Error('invalid register operation');
  const seen = new Set<string>();
  const context = raw.context.map((dot) => {
    dotOf(dot);
    const key = domain(dot);
    if (
      seen.has(key) ||
      (key === domain(raw) && dot.sequence >= raw.sequence)
    ) throw new Error('invalid register causal context');
    seen.add(key);
    return {
      source: dot.source,
      incarnation: dot.incarnation,
      sequence: dot.sequence,
    };
  }).sort(compare);
  const payload = registerJson(raw.payload);
  if (raw.payloadHash !== hash(payload)) {
    throw new Error('register payload hash mismatch');
  }
  return {
    operationId: raw.operationId,
    source: raw.source,
    incarnation: raw.incarnation,
    stream: raw.stream,
    sequence: raw.sequence,
    semanticKey: raw.semanticKey,
    kind: raw.kind,
    context,
    payloadHash: raw.payloadHash,
    payload,
  };
}

export function registerOperationFromRow(
  row: Record<string, unknown>,
): RegisterOperation {
  return {
    operationId: String(row.operation_id),
    source: String(row.source),
    incarnation: String(row.incarnation),
    stream: String(row.stream),
    sequence: Number(row.sequence),
    semanticKey: String(row.semantic_key),
    kind: String(row.kind),
    context: JSON.parse(String(row.context_json)),
    payloadHash: String(row.payload_hash),
    payload: String(row.payload_json),
  };
}

export async function registerOperations(
  conn: Conn,
  key: string,
): Promise<RegisterOperation[]> {
  return (await conn.query(
    'SELECT * FROM domain_operations WHERE semantic_key=?',
    [key],
  )).map(registerOperationFromRow).sort(compare);
}

/** Capture a pre-semantic local value only before authentic history exists.
 * An incoming local dot, or a foreign dot with incomplete history, may be
 * restoring this writer's original baseline. Never manufacture that identity
 * from a stale materialization. Only a foreign root is provably concurrent;
 * otherwise import the original history and retain the held value meanwhile. */
export async function captureRegisterBaseline(
  conn: Conn,
  source: RegisterSource,
  semanticKey: string,
  kind: string,
  payload: string,
  incoming?: RegisterOperation,
): Promise<void> {
  if (incoming) {
    const operation = checked(incoming);
    if (operation.semanticKey !== semanticKey || operation.kind !== kind) {
      throw new Error('register baseline semantic mismatch');
    }
    if (domain(operation) === domain(source) || operation.context.length) {
      return;
    }
  }
  if ((await registerOperations(conn, semanticKey)).length) return;
  await writeRegister(conn, source, semanticKey, kind, payload);
}

function join(vector: Map<string, RegisterDot>, dot: RegisterDot): void {
  const key = domain(dot), old = vector.get(key);
  if (!old || old.sequence < dot.sequence) {
    vector.set(key, {
      source: dot.source,
      incarnation: dot.incarnation,
      sequence: dot.sequence,
    });
  }
}

function maxima(
  rows: RegisterOperation[],
  history: RegisterOperation[] = rows,
): RegisterOperation[] {
  const observed = new Map<string, RegisterDot>();
  const retained = new Map(history.map((row) => [row.operationId, row]));
  const visited = new Set<string>();
  for (const row of rows) {
    const pending = [...row.context];
    while (pending.length) {
      const dot = pending.pop()!;
      join(observed, dot);
      const id = identity(dot, row.stream);
      if (visited.has(id)) continue;
      visited.add(id);
      const predecessor = retained.get(id);
      if (predecessor) pending.push(...predecessor.context);
    }
  }
  return rows.filter((row) =>
    row.sequence > (observed.get(domain(row))?.sequence ?? 0)
  );
}

/** A type owner may project a subset of a shared causal history (tag/reset
 * operations affecting one tag). The same ordering and dominance still apply. */
export function registerWinner(
  rows: RegisterOperation[],
  history: RegisterOperation[] = rows,
): RegisterOperation | null {
  return maxima([...rows].sort(compare), history).at(-1) ?? null;
}

/** Context entries name predecessor dots in this semantic key's counter domain.
 * Sparse contexts are allowed: a predecessor carries its own transitive context.
 * Retain out-of-order operations, but never publish them before that closure is
 * present. This also keeps a missing dependency from entering a local write's
 * observed context. No arrival-order-dependent rejection or guessed ancestor. */
function resolved(rows: RegisterOperation[]): RegisterOperation[] {
  const ready = new Set(
    causalRegisterOrder(rows).map(({ operationId }) => operationId),
  );
  return rows.filter((row) => ready.has(row.operationId));
}

/** Resolved operations in publishable order, with every predecessor before its
 * successors. Unresolved operations cannot be included in the stream. */
export function causalRegisterOrder(
  rows: RegisterOperation[],
): RegisterOperation[] {
  const ready = new Set<string>();
  const ordered: RegisterOperation[] = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const row of rows) {
      if (ready.has(row.operationId)) continue;
      if (!row.context.every((dot) => ready.has(identity(dot, row.stream)))) {
        continue;
      }
      ready.add(row.operationId);
      ordered.push(row);
      progress = true;
    }
  }
  return ordered;
}

export async function readRegister(
  conn: Conn,
  key: string,
): Promise<RegisterView> {
  return registerView(await registerOperations(conn, key));
}

/** Scalar and batched owners use the same causal closure and frontier verdict. */
export function registerView(
  operations: readonly RegisterOperation[],
): RegisterView {
  const all = [...operations].sort(compare), rows = resolved(all);
  const frontier = maxima(rows), winner = frontier.at(-1) ?? null;
  const ready = new Set(rows.map((row) => row.operationId));
  return {
    winner,
    frontier,
    conflicts: rows.filter((r) => r.operationId !== winner?.operationId),
    pending: all.filter((row) => !ready.has(row.operationId)),
  };
}

/** Import has no local authorship or export echo. Missing predecessor closure is
 * durably pending, not a winner. A later predecessor can release successors in
 * this same owning transaction; materialize the returned winner, not raw input.
 * Sparse contexts resolve transitively, so every delivery permutation converges.
 * Complete held operations remain publishable while other facts are pending;
 * receiving a future fact does not make its unavailable ancestors known. */
export async function importRegisterOperation(
  conn: Conn,
  raw: RegisterOperation,
): Promise<{
  operation: RegisterOperation;
  winner: RegisterOperation | null;
  inserted: boolean;
  changed: boolean;
}> {
  const operation = checked(raw);
  const before = await readRegister(conn, operation.semanticKey);
  const [existing] = await conn.query(
    'SELECT * FROM domain_operations WHERE operation_id=? OR (source=? AND incarnation=? AND stream=? AND sequence=?)',
    [
      operation.operationId,
      operation.source,
      operation.incarnation,
      operation.stream,
      operation.sequence,
    ],
  );
  if (existing) {
    if (
      JSON.stringify(registerOperationFromRow(existing)) !==
        JSON.stringify(operation)
    ) {
      throw new Error('register operation divergence');
    }
    return {
      operation,
      winner: before.winner,
      inserted: false,
      changed: false,
    };
  }
  const [kind] = await conn.query(
    'SELECT kind FROM domain_operations WHERE semantic_key=? LIMIT 1',
    [operation.semanticKey],
  );
  if (kind && kind.kind !== operation.kind) {
    throw new Error('register semantic kind mismatch');
  }
  await conn.execute(
    `INSERT INTO domain_operations(operation_id,source,incarnation,stream,sequence,semantic_key,kind,context_json,payload_hash,payload_json)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [
      operation.operationId,
      operation.source,
      operation.incarnation,
      operation.stream,
      operation.sequence,
      operation.semanticKey,
      operation.kind,
      JSON.stringify(operation.context),
      operation.payloadHash,
      operation.payload,
    ],
  );
  const after = await readRegister(conn, operation.semanticKey);
  await conn.execute('DELETE FROM domain_frontiers WHERE semantic_key=?', [
    operation.semanticKey,
  ]);
  for (const row of after.frontier) {
    await conn.execute(
      'INSERT INTO domain_frontiers(semantic_key,operation_id) VALUES(?,?)',
      [operation.semanticKey, row.operationId],
    );
  }
  // A predecessor may release several pending successors. Index newly resolved
  // losers without rewriting the already indexed retained history.
  const previousConflicts = new Set(
    before.conflicts.map((row) => row.operationId),
  );
  for (const row of after.conflicts) {
    if (previousConflicts.has(row.operationId)) continue;
    await conn.execute(
      'INSERT INTO domain_conflicts(semantic_key,operation_id) VALUES(?,?) ON CONFLICT DO NOTHING',
      [operation.semanticKey, row.operationId],
    );
  }
  if (after.winner) {
    await conn.execute(
      'DELETE FROM domain_conflicts WHERE semantic_key=? AND operation_id=?',
      [operation.semanticKey, after.winner.operationId],
    );
  }
  return {
    operation,
    winner: after.winner,
    inserted: true,
    changed: before.winner?.payload !== after.winner?.payload,
  };
}

/** The stable per-key source counter and complete observed context commit with
 * the owner's value. No identity allocation or side effects outside this Conn. */
export async function writeRegister(
  conn: Conn,
  source: RegisterSource,
  semanticKey: string,
  kind: string,
  rawPayload: string,
) {
  sourceOf(source);
  const all = await registerOperations(conn, semanticKey), rows = resolved(all);
  const ready = new Set(rows.map((row) => row.operationId));
  if (
    all.some((row) =>
      (domain(row) === domain(source) && !ready.has(row.operationId)) ||
      row.context.some((dot) =>
        domain(dot) === domain(source) && !ready.has(identity(dot, row.stream))
      )
    )
  ) {
    // A restored writer cannot skip its own previously authored causal cut.
    // Foreign pending operations may remain concurrent unless they expose a
    // missing dot authored by this writer. Referenced absence is not recovery.
    throw new Error('local register predecessor unavailable');
  }
  const vector = new Map<string, RegisterDot>();
  for (const row of rows) {
    join(vector, row);
    for (const dot of row.context) join(vector, dot);
  }
  const stream = 'register:' + semanticKey;
  const counter = 'domain:' + JSON.stringify([
    source.source,
    source.incarnation,
    stream,
  ]);
  let observed = 0;
  for (const row of all) {
    if (domain(row) === domain(source)) {
      observed = Math.max(observed, row.sequence);
    }
  }
  await conn.execute(
    'INSERT INTO counters(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=MAX(value,excluded.value)',
    [counter, observed],
  );
  await conn.execute('UPDATE counters SET value=value+1 WHERE name=?', [
    counter,
  ]);
  const [row] = await conn.query('SELECT value FROM counters WHERE name=?', [
    counter,
  ]);
  const sequence = Number(row.value);
  const payload = registerJson(rawPayload);
  return await importRegisterOperation(conn, {
    ...source,
    operationId: identity({ ...source, sequence }, stream),
    sequence,
    stream,
    semanticKey,
    kind,
    context: [...vector.values()].sort(compare),
    payloadHash: hash(payload),
    payload,
  });
}
