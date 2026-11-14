// Schemas for peer-produced request bodies. HTTP status mapping lives at the
// request owner; malformed ephemeral entries never synthesize ordinary values.
import { arrayOf, objectOf, stringOf } from '#engine/net/json.ts';
import { limit, protocol } from '#engine/net/upstream-error.ts';
import { transactionPdus } from './responses.ts';

function integer(raw: unknown, phase: string): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    protocol(phase, 'expected safe integer');
  }
  return raw;
}
export function eduEnvelope(raw: unknown) {
  const edu = objectOf(raw, 'edu');
  return {
    type: stringOf(edu.edu_type, 'edu'),
    content: objectOf(edu.content, 'edu'),
  };
}
export function transactionEnvelope(body: Record<string, unknown>) {
  if (!Array.isArray(body.pdus)) protocol('transaction', 'expected PDU array');
  if (body.edus !== undefined && !Array.isArray(body.edus)) {
    protocol('transaction', 'expected EDU array');
  }
  const edus = body.edus === undefined ? [] : body.edus;
  if (body.pdus.length > 50 || (edus as unknown[]).length > 100) {
    limit('transaction', 'too many PDUs or EDUs');
  }
  const pdus = transactionPdus(body, 'transaction');
  arrayOf(edus, eduEnvelope, 'transaction');
  return { pdus, edus: edus as unknown[] };
}
export function typingContent(content: Record<string, unknown>) {
  const roomId = stringOf(content.room_id, 'typing'),
    userId = stringOf(content.user_id, 'typing');
  if (typeof content.typing !== 'boolean') {
    protocol('typing', 'expected typing boolean');
  }
  return { roomId, userId, typing: content.typing };
}
export function receiptContent(raw: unknown) {
  const mark = objectOf(raw, 'receipt'), data = objectOf(mark.data, 'receipt');
  const eventIds = arrayOf(
    mark.event_ids,
    (id) => stringOf(id, 'receipt'),
    'receipt',
  );
  if (!eventIds.length) {
    protocol('receipt', 'expected receipt extremities');
  }
  const ts = integer(data.ts, 'receipt');
  const threadId = data.thread_id === undefined
    ? undefined
    : stringOf(data.thread_id, 'receipt');
  return { eventIds, ts, threadId };
}
export function presenceContent(raw: unknown) {
  const p = objectOf(raw, 'presence'), userId = stringOf(p.user_id, 'presence');
  const presence = stringOf(p.presence, 'presence');
  if (!['online', 'offline', 'unavailable'].includes(presence)) {
    protocol('presence', 'invalid presence');
  }
  const status = p.status_msg === undefined
    ? undefined
    : stringOf(p.status_msg, 'presence');
  const lastActiveAgo = integer(p.last_active_ago, 'presence');
  if (
    p.currently_active !== undefined && typeof p.currently_active !== 'boolean'
  ) protocol('presence', 'invalid currently_active');
  return {
    userId,
    presence,
    status,
    lastActiveAgo,
    currentlyActive: p.currently_active === true,
  };
}
