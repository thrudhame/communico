// Cryptographic preparation for the synchronous rulebook. Facts are scoped to
// one immutable event pack and keyed by both the member and key-event ids.
import type { EventStore, Pdu } from '#engine/rulebook/types.ts';
import {
  b64decode,
  importPublicKeyFromRaw,
  verifyJson,
} from '#engine/signing-primitives.js';

export async function withAuthProofs(
  store: EventStore,
  events: Iterable<Pdu>,
): Promise<EventStore> {
  const pack = [...events];
  const keys = new Map<string, Pdu[]>();
  for (const event of pack) {
    if (
      event.type !== 'm.room.third_party_invite' || event.event_id === undefined
    ) continue;
    const token = event.state_key;
    if (token === undefined) continue;
    const candidates = keys.get(token) ?? [];
    candidates.push(event);
    keys.set(token, candidates);
  }
  const proofs = new Map<string, Set<string>>();
  for (const member of pack) {
    if (member.type !== 'm.room.member' || member.event_id === undefined) {
      continue;
    }
    const invite = member.content?.third_party_invite as {
      signed?: {
        token?: unknown;
        signatures?: Record<string, Record<string, string>>;
      };
    } | undefined;
    const signed = invite?.signed;
    if (
      signed === undefined || signed === null || typeof signed !== 'object' ||
      typeof signed.token !== 'string'
    ) continue;
    for (const keyEvent of keys.get(signed.token) ?? []) {
      const rawKeys: string[] = [];
      if (typeof keyEvent.content.public_key === 'string') {
        rawKeys.push(keyEvent.content.public_key);
      }
      if (Array.isArray(keyEvent.content.public_keys)) {
        for (const entry of keyEvent.content.public_keys) {
          if (
            entry !== null && typeof entry === 'object' &&
            typeof entry.public_key === 'string'
          ) {
            rawKeys.push(entry.public_key);
          }
        }
      }
      let valid = false;
      for (const raw of rawKeys) {
        try {
          const key = await importPublicKeyFromRaw(b64decode(raw));
          for (
            const [entity, signatures] of Object.entries(
              signed.signatures ?? {},
            )
          ) {
            if (signatures === null || typeof signatures !== 'object') continue;
            for (const keyId of Object.keys(signatures)) {
              if (
                keyId.startsWith('ed25519:') &&
                await verifyJson(signed, entity, keyId, key)
              ) {
                valid = true;
              }
            }
          }
        } catch { /* malformed keys or signatures prove nothing */ }
        if (valid) break;
      }
      if (valid) {
        const ids = proofs.get(member.event_id) ?? new Set<string>();
        ids.add(keyEvent.event_id!);
        proofs.set(member.event_id, ids);
      }
    }
  }
  return {
    get: (id) => store.get(id),
    isRejected: (id) => store.isRejected(id),
    thirdPartyInviteVerified: (member, key) =>
      proofs.get(member)?.has(key) === true,
  };
}
