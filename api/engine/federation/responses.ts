// Endpoint-owned envelopes. Parsing one of these is not PDU/signature/identity
// admission: the room/key owner still verifies the parsed records before use.
import {
  arrayOf,
  booleanOf,
  objectOf,
  optionalField,
  stringOf,
} from '#engine/net/json.ts';
import { protocol, UpstreamError } from '#engine/net/upstream-error.ts';
import type { Pdu } from '#engine/pdu.ts';

function integerOf(raw: unknown, endpoint: string): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    protocol(endpoint, 'expected safe integer');
  }
  return raw;
}
function pduOf(raw: unknown, endpoint: string): Pdu {
  // The endpoint promises an object. Room-version event shape, cryptography and
  // authorization remain with room/verify, never this envelope parser.
  return objectOf(raw, endpoint) as unknown as Pdu;
}
export function pduList(raw: unknown, endpoint: string): Pdu[] {
  return arrayOf(raw, (entry) => pduOf(entry, endpoint), endpoint);
}
function strings(raw: unknown, endpoint: string): string[] {
  return arrayOf(raw, (entry) => stringOf(entry, endpoint), endpoint);
}
export function transactionPdus(raw: unknown, endpoint: string): Pdu[] {
  const body = objectOf(raw, endpoint);
  stringOf(body.origin, endpoint);
  integerOf(body.origin_server_ts, endpoint);
  return pduList(body.pdus, endpoint);
}
export function eventResponse(raw: unknown): Pdu {
  const pdus = transactionPdus(raw, 'event');
  if (pdus.length !== 1) protocol('event', 'expected one event');
  return pdus[0];
}
export function stateIdsResponse(raw: unknown) {
  const body = objectOf(raw, 'state-ids');
  return {
    pduIds: strings(body.pdu_ids, 'state-ids'),
    authChainIds: strings(body.auth_chain_ids, 'state-ids'),
  };
}
export function stateResponse(raw: unknown) {
  const body = objectOf(raw, 'state');
  return {
    state: pduList(body.pdus, 'state'),
    authChain: pduList(body.auth_chain, 'state'),
  };
}
export function timestampResponse(raw: unknown) {
  const body = objectOf(raw, 'timestamp');
  return {
    event_id: stringOf(body.event_id, 'timestamp'),
    origin_server_ts: integerOf(body.origin_server_ts, 'timestamp'),
  };
}
export function membershipTemplate(
  raw: unknown,
  endpoint: string,
  versions: readonly string[],
) {
  const body = objectOf(raw, endpoint);
  // An absent optional version means legacy v1/v2, never our preferred version.
  const version = optionalField(
    body.room_version,
    (raw) => stringOf(raw, endpoint),
  );
  const roomVersion = version === undefined ? '1' : version;
  if (!versions.includes(roomVersion)) {
    throw new UpstreamError('validation', {
      phase: endpoint,
      reason: 'unsupported room version',
    });
  }
  const event = pduOf(body.event, endpoint);
  stringOf(event.type, endpoint);
  stringOf(event.sender, endpoint);
  stringOf(event.state_key, endpoint);
  stringOf(event.room_id, endpoint);
  const content = objectOf(event.content, endpoint);
  stringOf(content.membership, endpoint);
  strings(event.prev_events, endpoint);
  strings(event.auth_events, endpoint);
  if (integerOf(event.depth, endpoint) < 0) protocol(endpoint, 'invalid depth');
  return { roomVersion, event };
}
export function legacyResponse(
  raw: unknown,
  endpoint: string,
): Record<string, unknown> {
  if (!Array.isArray(raw) || raw.length !== 2 || raw[0] !== 200) {
    protocol(endpoint, 'invalid v1 response tuple');
  }
  return objectOf(raw[1], endpoint);
}
export function sendJoinResponse(raw: unknown, legacy = false) {
  const body = legacy
    ? legacyResponse(raw, 'send-join')
    : objectOf(raw, 'send-join');
  const omitted = optionalField(
    body.members_omitted,
    (raw) => booleanOf(raw, 'send-join'),
  );
  optionalField(body.servers_in_room, (raw) => strings(raw, 'send-join'));
  // This caller did not request partial state and has no partial-state owner.
  if (omitted === true) {
    protocol('send-join', 'unsolicited partial state');
  }
  return {
    state: pduList(body.state, 'send-join'),
    authChain: pduList(body.auth_chain, 'send-join'),
    event: optionalField(body.event, (raw) => pduOf(raw, 'send-join')),
  };
}
export function inviteResponse(raw: unknown): Pdu {
  return pduOf(objectOf(raw, 'invite').event, 'invite');
}
export function knockResponse(raw: unknown): Pdu[] {
  return pduList(objectOf(raw, 'send-knock').knock_room_state, 'send-knock');
}
export function leaveResponse(raw: unknown, legacy = false): void {
  if (legacy) legacyResponse(raw, 'send-leave');
  else objectOf(raw, 'send-leave');
}

export function sendVerdicts(raw: unknown): Record<string, { error?: string }> {
  const body = objectOf(raw, 'send-verdict');
  const pdus = objectOf(body.pdus, 'send-verdict');
  const result: Record<string, { error?: string }> = Object.create(null);
  for (const [id, value] of Object.entries(pdus)) {
    const verdict = objectOf(value, 'send-verdict');
    const error = optionalField(
      verdict.error,
      (raw) => stringOf(raw, 'send-verdict'),
    );
    const decoded = { ...verdict };
    if (error === undefined) delete decoded.error;
    else decoded.error = error;
    result[id] = decoded;
  }
  return result;
}
