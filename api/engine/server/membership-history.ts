// Retained membership facts are dependencies, never room/PDU/register winners.
// The authenticated link adapter owns source authority and PDU verification;
// this owner checks immutable identity and closure in its SAME transaction.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { validEventUserId } from '#engine/ids.ts';
import type { RegisterDot } from '#engine/facade/registers.ts';
import type { Conn } from '#engine/store/db.ts';
import {
  type MembershipOperation,
  membershipOperations,
  type MembershipState,
} from './membership-operations.ts';

function invalid(): never {
  throw new Error('invalid membership operation');
}

function json(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Parser diagnostics may quote private invite or departure content.
    invalid();
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function domain(dot: RegisterDot) {
  return canonicalJson([dot.source, dot.incarnation]);
}

function identity(dot: RegisterDot, stream: string) {
  return canonicalJson([dot.source, dot.incarnation, stream, dot.sequence]);
}

function checkedDot(dot: RegisterDot): RegisterDot {
  if (
    !object(dot) || typeof dot.source !== 'string' ||
    !/^[\x21-\x7e]+$/.test(dot.source) ||
    typeof dot.incarnation !== 'string' ||
    !/^[\x21-\x7e]+$/.test(dot.incarnation) ||
    !Number.isSafeInteger(dot.sequence) || dot.sequence < 1
  ) invalid();
  const result = {
    source: dot.source,
    incarnation: dot.incarnation,
    sequence: dot.sequence,
  };
  if (canonicalJson(result) !== canonicalJson(dot)) invalid();
  return result;
}

function stateOf(payload: string): MembershipState {
  const value = json(payload);
  if (
    !object(value) || !text(value.roomId) || !value.roomId.startsWith('!') ||
    !validEventUserId(value.userId) || !text(value.eventId) ||
    !value.eventId.startsWith('$') ||
    !text(value.roomVersion) || !text(value.eventJson) ||
    !object(json(value.eventJson)) ||
    typeof value.inviteRoomState !== 'string' ||
    !Array.isArray(json(value.inviteRoomState)) ||
    !text(value.origin) ||
    ![
      'pending',
      'attempting',
      'failed-attempt',
      'rejecting',
      'failed-retract',
      'rejected',
      'joined',
    ].includes(String(value.status)) ||
    (value.kind !== 'invite' && value.kind !== 'knock') ||
    (value.localLeaveJson !== null &&
      (typeof value.localLeaveJson !== 'string' ||
        !object(json(value.localLeaveJson))))
  ) invalid();
  const publication = value.publication;
  if (
    publication !== null &&
    (!object(publication) || !text(publication.eventId) ||
      !['invite', 'knock', 'join', 'leave', 'ban'].includes(
        String(publication.membership),
      ) || typeof publication.follows !== 'boolean' ||
      canonicalJson(publication) !==
        canonicalJson({
          eventId: publication.eventId,
          membership: publication.membership,
          follows: publication.follows,
        }))
  ) invalid();
  const state = {
    roomId: value.roomId,
    userId: value.userId,
    eventId: value.eventId,
    roomVersion: value.roomVersion,
    eventJson: value.eventJson,
    inviteRoomState: value.inviteRoomState,
    origin: value.origin,
    status: value.status,
    kind: value.kind,
    localLeaveJson: value.localLeaveJson,
    publication,
  } as MembershipState;
  if (canonicalJson(state) !== payload) invalid();
  return state;
}

export function checkedMembershipOperation(
  raw: MembershipOperation,
): MembershipOperation {
  if (!object(raw)) invalid();
  const dot = checkedDot({
    source: raw.source,
    incarnation: raw.incarnation,
    sequence: raw.sequence,
  });
  if (typeof raw.payload !== 'string' || !Array.isArray(raw.context)) invalid();
  const state = stateOf(raw.payload);
  const stream = 'membership:' + state.userId;
  if (
    raw.kind !== 'membership' || raw.stream !== stream ||
    raw.operationId !== identity(dot, stream) ||
    raw.semanticKey !==
      canonicalJson(['membership', state.roomId, state.userId]) ||
    raw.payloadHash !== createHash('sha256').update(raw.payload).digest('hex')
  ) invalid();
  const seen = new Set<string>();
  const context = raw.context.map((value) => {
    const predecessor = checkedDot(value), key = domain(predecessor);
    if (
      seen.has(key) ||
      (key === domain(dot) && predecessor.sequence >= dot.sequence)
    ) invalid();
    seen.add(key);
    return predecessor;
  });
  const operation: MembershipOperation = {
    ...dot,
    operationId: raw.operationId,
    stream,
    semanticKey: raw.semanticKey,
    kind: 'membership',
    context,
    payloadHash: raw.payloadHash,
    payload: raw.payload,
  };
  if (canonicalJson(operation) !== canonicalJson(raw)) invalid();
  return operation;
}

/** Admit only already-authenticated facts. Retention is not application and
 * never allocates receiver publication, source counters, frontiers or jobs. */
export async function retainMembershipOperation(
  conn: Conn,
  raw: MembershipOperation,
): Promise<boolean> {
  const operation = checkedMembershipOperation(raw);
  const [prior] = await conn.query(
    'SELECT * FROM domain_operations WHERE operation_id=? OR (source=? AND incarnation=? AND stream=? AND sequence=?)',
    [
      operation.operationId,
      operation.source,
      operation.incarnation,
      operation.stream,
      operation.sequence,
    ],
  );
  if (prior) {
    const retained = {
      source: prior.source,
      incarnation: prior.incarnation,
      sequence: Number(prior.sequence),
      operationId: prior.operation_id,
      stream: prior.stream,
      semanticKey: prior.semantic_key,
      kind: prior.kind,
      context: json(String(prior.context_json)),
      payloadHash: prior.payload_hash,
      payload: prior.payload_json,
    };
    if (canonicalJson(retained) !== canonicalJson(operation)) {
      throw new Error('membership operation divergence');
    }
    return false;
  }
  await conn.execute(
    'INSERT INTO domain_operations(operation_id,source,incarnation,stream,sequence,semantic_key,kind,context_json,payload_hash,payload_json,applied) VALUES(?,?,?,?,?,?,?,?,?,?,0)',
    [
      operation.operationId,
      operation.source,
      operation.incarnation,
      operation.stream,
      operation.sequence,
      operation.semanticKey,
      operation.kind,
      canonicalJson(operation.context),
      operation.payloadHash,
      operation.payload,
    ],
  );
  return true;
}

/** Contexts refer to the same room/user lifecycle, even though source counters
 * span that user's rooms. Missing/retired source history stays pending; arrival
 * order and source lexical order cannot select a membership display winner. */
export async function membershipHistory(
  conn: Conn,
  semanticKey: string,
): Promise<{
  ready: MembershipOperation[];
  pending: MembershipOperation[];
  frontier: MembershipOperation[];
}> {
  const key = json(semanticKey);
  if (
    !Array.isArray(key) || key.length !== 3 || key[0] !== 'membership' ||
    typeof key[1] !== 'string' || typeof key[2] !== 'string'
  ) invalid();
  const all = (await membershipOperations(conn, key[2])).filter((operation) =>
    operation.semanticKey === semanticKey
  );
  const ready = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const operation of all) {
      if (
        ready.has(operation.operationId) ||
        !operation.context.every((dot) =>
          ready.has(identity(dot, operation.stream))
        )
      ) continue;
      ready.add(operation.operationId);
      changed = true;
    }
  }
  const complete = all.filter((operation) => ready.has(operation.operationId));
  const observed = new Set(
    complete.flatMap((operation) =>
      operation.context.map((dot) => identity(dot, operation.stream))
    ),
  );
  return {
    ready: complete,
    pending: all.filter((operation) => !ready.has(operation.operationId)),
    frontier: complete.filter((operation) =>
      !observed.has(operation.operationId)
    ),
  };
}
