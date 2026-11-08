// api/engine/federation/witness.ts — ask roster peers (the servers a
// person vouched for) about a stranger's key document, in parallel, by
// seniority. The most senior USABLE answer wins. Any other usable answer
// carrying different key material is a disagreement — recorded for the
// admin, never acted on. A single usable answer is single-source trust;
// the caller's comment says so.
import { b64decode } from '#engine/signing-primitives.js';

export type KeyDocShape = {
  server_name: string;
  verify_keys: Record<string, { key: string }>;
  old_verify_keys: Record<string, { key: string; expired_ts: number }>;
  valid_until_ts: number;
  signatures: Record<string, Record<string, string>>;
};

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
  for (const [id, entry] of Object.entries(doc.old_verify_keys)) {
    pairs.push(id + ' ' + hexOf(b64decode(entry.key)));
  }
  return pairs.sort().join('\n');
}

export function keyMapOf(doc: KeyDocShape): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, entry] of Object.entries(doc.verify_keys)) {
    out[id] = entry.key;
  }
  for (const [id, entry] of Object.entries(doc.old_verify_keys)) {
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
// ({server_keys: [...]}); a bare document is also accepted.
export function documentsFromAnswer(
  raw: unknown,
  serverName: string,
): KeyDocShape[] {
  if (raw === null || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const list: unknown[] = Array.isArray(obj.server_keys)
    ? obj.server_keys
    : [raw];
  const out: KeyDocShape[] = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const doc = item as KeyDocShape;
    if (doc.server_name !== serverName) continue;
    out.push(doc);
  }
  return out;
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
          const checked = await opts.selfCheck(doc);
          if (checked === null) continue;
          if (!(await opts.witnessCheck(peer, checked))) continue;
          return { peer, doc: checked };
        }
        return null;
      } catch {
        return null; // an unreachable or misbehaving witness is no answer
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
