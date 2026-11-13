// Local authoring policy, separate from Matrix auth and remote validity.
import { config } from '#engine/config.ts';
import { domainOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { RoomTx } from '#engine/room/index.ts';
import type { BuildPartial } from '#engine/room/build.ts';
import { openRoom } from '#engine/room/index.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import type { Store } from '#engine/store/index.ts';

export const MEGOLM = 'm.megolm.v1.aes-sha2';
type InitialState = { type: string; state_key?: string; content: unknown };

export function usableEncryption(content: unknown): boolean {
  return content !== null && typeof content === 'object' &&
    !Array.isArray(content) &&
    (content as Record<string, unknown>).algorithm === MEGOLM;
}

export function encryptionError(message: string): MatrixError {
  return new MatrixError(400, 'M_FORBIDDEN', message);
}

export function assertJoinEncryption(content: unknown): void {
  if (
    !config().encryption.allowunencryptedjoining && !usableEncryption(content)
  ) {
    throw encryptionError('Joining unencrypted rooms is disabled');
  }
}

// Archived known state can refuse before a new remote membership side effect.
// A later authoritative snapshot still has to pass the same policy.
export async function assertKnownJoinEncryption(
  store: Store,
  roomId: string,
): Promise<void> {
  if (config().encryption.allowunencryptedjoining) return;
  let room;
  try {
    room = await openRoom(store, roomId);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return;
    throw e;
  }
  await withRoomLock(roomId, () =>
    room.tx(async (tx) => {
      const stay = await tx.segments.latestStay();
      if (stay === null) return;
      const group = await tx.state.current(stay.id);
      assertJoinEncryption(
        (await stateEvent(tx, group, 'm.room.encryption'))?.content,
      );
    }));
}

function validateEncryption(content: unknown): void {
  if (!usableEncryption(content)) {
    throw encryptionError('Only m.megolm.v1.aes-sha2 encryption is supported');
  }
  for (const key of ['rotation_period_ms', 'rotation_period_msgs']) {
    const value = (content as Record<string, unknown>)[key];
    if (
      value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0)
    ) {
      throw encryptionError('Invalid encryption ' + key);
    }
  }
}

// Creation and later local state writes apply the same independent switch.
// Permissive creation retains unknown encryption algorithms like ordinary
// Matrix state; a supported algorithm still validates its supported settings.
function assertEncryptionState(content: unknown): void {
  if (
    !config().encryption.allowunencryptedcreation || usableEncryption(content)
  ) {
    validateEncryption(content);
  }
}

// Return a new plan; never mutate the caller's initial_state. Spaces have
// state content only. There is no client-controlled server-notice exemption.
export function encryptedInitialState(
  initial: readonly InitialState[],
  roomType: unknown,
): InitialState[] {
  const entries = initial.filter((e) => e.type === 'm.room.encryption');
  if (entries.length > 1 || entries.some((e) => (e.state_key ?? '') !== '')) {
    throw encryptionError('One empty-key encryption state event is required');
  }
  if (entries.length) assertEncryptionState(entries[0].content);
  const result = [...initial];
  if (
    !entries.length && roomType !== 'm.space' &&
    !config().encryption.allowunencryptedcreation
  ) {
    result.push({
      type: 'm.room.encryption',
      state_key: '',
      content: { algorithm: MEGOLM },
    });
  }
  return result;
}

async function stateEvent(
  tx: RoomTx,
  group: number | null,
  type: string,
  key = '',
): Promise<Pdu | null> {
  const id = group === null ? null : await tx.state.groupKey(group, type, key);
  const row = id === null ? null : await tx.events.get(id);
  return row === null ? null : JSON.parse(row.pdu) as Pdu;
}

// The finite verification vocabulary is the Matrix in-room protocol. The
// request is a room message, unlike the remaining verification event types.
const VERIFICATION = new Set([
  'm.key.verification.ready',
  'm.key.verification.start',
  'm.key.verification.accept',
  'm.key.verification.key',
  'm.key.verification.mac',
  'm.key.verification.done',
  'm.key.verification.cancel',
]);
function plaintextException(event: BuildPartial): boolean {
  return event.type === 'm.room.redaction' || VERIFICATION.has(event.type) ||
    (event.type === 'm.room.message' &&
      event.content.msgtype === 'm.key.verification.request');
}

// Matrix exposes the entire annotation relation, even on encrypted envelopes.
// Admit that exact content contract, not arbitrary payloads under a trusted type.
function relationOnlyReaction(event: BuildPartial): boolean {
  if (event.type !== 'm.reaction' || Object.keys(event.content).length !== 1) {
    return false;
  }
  const relation = event.content['m.relates_to'];
  if (!relation || typeof relation !== 'object' || Array.isArray(relation)) {
    return false;
  }
  const fields = relation as Record<string, unknown>;
  return Object.keys(fields).length === 3 &&
    ['rel_type', 'event_id', 'key'].every((key) =>
      Object.hasOwn(fields, key)
    ) &&
    fields.rel_type === 'm.annotation' && typeof fields.event_id === 'string' &&
    typeof fields.key === 'string';
}

// Called inside the shared locked ingest, AFTER receipt lookup and BEFORE
// storage. Current resolved state, not the event's possibly old parents,
// decides local policy. Imports/remote events never cross this boundary.
export async function assertLocalEncryption(
  tx: RoomTx,
  group: number | null,
  event: BuildPartial,
  self: string,
  initializing = false,
): Promise<void> {
  if (domainOf(event.sender) !== self) return;
  const policy = config().encryption;
  const encryption = await stateEvent(tx, group, 'm.room.encryption');
  const encrypted = usableEncryption(encryption?.content);
  if (event.type === 'm.room.encryption') {
    if (event.state_key !== '') {
      throw encryptionError('Encryption state key must be empty');
    }
    assertEncryptionState(event.content);
  }
  if (!policy.allowunencryptedcreation && event.type === 'm.room.redaction') {
    const targetId = event.redacts ?? event.content.redacts;
    const target = typeof targetId === 'string'
      ? await tx.events.get(targetId)
      : null;
    if (target?.type === 'm.room.encryption' && target.state_key === '') {
      throw encryptionError('Encryption state cannot be redacted');
    }
  }
  if (event.state_key !== undefined) {
    if (
      event.type === 'm.room.member' && event.sender === event.state_key &&
      ['join', 'knock'].includes(String(event.content.membership)) &&
      !policy.allowunencryptedjoining &&
      !initializing
    ) {
      const current = await stateEvent(
        tx,
        group,
        'm.room.member',
        event.sender,
      );
      // Existing memberships are never auto-evicted. Initialization uses
      // the complete encrypted creation plan in an unpublished room file.
      if (
        current?.content.membership !== 'join' &&
        await stateEvent(tx, group, 'm.room.create') !== null && !encrypted
      ) {
        throw encryptionError('Joining unencrypted rooms is disabled');
      }
    }
    return;
  }
  if (
    encrypted && !policy.allowunencryptedmessages &&
    event.type !== 'm.room.encrypted' && !plaintextException(event) &&
    !(policy.allowunencryptedreactions && relationOnlyReaction(event))
  ) {
    throw encryptionError(
      'Unencrypted messages in encrypted rooms are disabled',
    );
  }
}
