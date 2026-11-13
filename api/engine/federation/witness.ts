// api/engine/federation/witness.ts — ask roster peers (the servers a
// person vouched for) about a stranger's key document, in parallel, by
// seniority. The most senior USABLE answer wins. Any other usable answer
// carrying different key material is a disagreement — recorded for the
// admin, never acted on. A single usable answer is single-source trust;
// the caller's comment says so.
import { b64decode } from '#engine/signing-primitives.js';
import { arrayOf, objectOf } from '#engine/net/json.ts';
import {
  recoverableUpstream,
  upstreamCategory,
} from '#engine/net/upstream-error.ts';
import { type KeyDocShape, keyDocument, oldKeysOf } from './key-document.ts';
export type { KeyDocShape } from './key-document.ts';

export type WitnessDisagreement = {
  senior: string;
  junior: string;
  seniorKeys: Record<string, string>;
  juniorKeys: Record<string, string>;
};

// (id, bytes) material of a document's verify_keys ∪ old_verify_keys,
// rendered as a sorted, joined string for equality comparison.
export function materialFingerprint(doc: KeyDocShape): string {
  const pairs: string[] = [];
  for (const [id, entry] of Object.entries(doc.verify_keys)) {
    pairs.push(id + ' ' + hexOf(b64decode(entry.key)));
  }
  for (const [id, entry] of Object.entries(oldKeysOf(doc))) {
    pairs.push(id + ' ' + hexOf(b64decode(entry.key)));
  }
  return pairs.sort().join('\n');
}

export function keyMapOf(doc: KeyDocShape): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, entry] of Object.entries(doc.verify_keys)) {
    out[id] = entry.key;
  }
  for (const [id, entry] of Object.entries(oldKeysOf(doc))) {
    out[id] = entry.key;
  }
  return out;
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
}

// Extract candidate documents for `serverName` from a notary answer
// ({server_keys: [...]}). A malformed answer is not a valid empty answer.
export function documentsFromAnswer(
  raw: unknown,
  serverName: string,
): KeyDocShape[] {
  const obj = objectOf(raw, 'notary');
  return arrayOf(obj.server_keys, keyDocument, 'notary')
    .filter((doc) => doc.server_name === serverName);
}

export async function askWitnesses(opts: {
  serverName: string;
  minimumValidUntilTs: number;
  peers: string[]; // seniority order, already cut to federation.witnesses
  query: (
    peer: string,
    serverName: string,
    minimumValidUntilTs: number,
  ) => Promise<unknown>;
  // server_name match + required fields + self-signature — returns the doc
  // or null when unusable
  selfCheck: (doc: KeyDocShape) => Promise<KeyDocShape | null>;
  // the witness's own signature over the doc verifies with its cached key
  witnessCheck: (peer: string, doc: KeyDocShape) => Promise<boolean>;
}): Promise<
  {
    winner: { peer: string; doc: KeyDocShape };
    disagreements: WitnessDisagreement[];
  } | null
> {
  const answers = await Promise.all(
    opts.peers.map(async (peer) => {
      try {
        const raw = await opts.query(
          peer,
          opts.serverName,
          opts.minimumValidUntilTs,
        );
        for (const doc of documentsFromAnswer(raw, opts.serverName)) {
          try {
            const checked = await opts.selfCheck(doc);
            if (checked === null) continue;
            if (!(await opts.witnessCheck(peer, checked))) continue;
            return { peer, doc: checked };
          } catch (error) {
            if (
              upstreamCategory(error) === 'cancellation' ||
              !recoverableUpstream(error)
            ) throw error;
            // A well-shaped but unverifiable document does not hide a later
            // usable document from this same notary answer.
          }
        }
        return null;
      } catch (error) {
        // Cancellation and local/store failures belong to the caller, not a
        // witness fallback. Only a classified peer failure is no answer.
        if (
          upstreamCategory(error) === 'cancellation' ||
          !recoverableUpstream(error)
        ) throw error;
        return null;
      }
    }),
  );
  const usable = answers.filter((a) => a !== null) as {
    peer: string;
    doc: KeyDocShape;
  }[];
  if (usable.length === 0) return null;
  // peers arrived in seniority order — the first usable is the most senior
  const winner = usable[0];
  const winnerMaterial = materialFingerprint(winner.doc);
  const disagreements: WitnessDisagreement[] = [];
  for (const other of usable.slice(1)) {
    if (materialFingerprint(other.doc) !== winnerMaterial) {
      disagreements.push({
        senior: winner.peer,
        junior: other.peer,
        seniorKeys: keyMapOf(winner.doc),
        juniorKeys: keyMapOf(other.doc),
      });
    }
  }
  return { winner, disagreements };
}
