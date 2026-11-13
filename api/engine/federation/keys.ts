// api/engine/federation/keys.ts — remembered server signing keys.
// Acquisition is WITNESSES-FIRST (design rung 5): a stranger's document is
// asked of roster peers a person vouched for; a direct dial to the origin
// happens only when no witness answered (open mode) or for a roster peer
// (closed mode — the gate stops strangers first). Key changes are decided
// by (id, bytes) MATERIAL before anything is persisted; `block` keeps the
// candidate only inside the change row. Acquisition state belongs to the
// store's stable server database capability, shared by admin and resolver
// views. Weak ownership keeps separate/reopened stores isolated without
// retaining a closed store's acquisition memory by its filesystem path.
// The cache tables are shared across tenants of the same server file
// (a fetched key serves every tenant). Ported from doltgres.
import { config } from '#engine/config.ts';
import type { Database as Db } from '#engine/store/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { canonicalJson } from '#engine/canonical.ts';
import type { Signer } from '#engine/room/signer.ts';
import {
  b32decode,
  b64decode,
  b64encodeStd,
  importPublicKeyFromRaw,
  isKeyName,
  verifyJson,
} from '#engine/signing-primitives.js';
import {
  askWitnesses,
  type KeyDocShape,
  keyMapOf,
  materialFingerprint,
  type WitnessDisagreement,
} from './witness.ts';
import { listWitnesses } from './peers.ts';
import { federationRequest } from './client.ts';
import { upstreamCategory, UpstreamError } from '#engine/net/upstream-error.ts';
import { keyDocument, oldKeysOf } from './key-document.ts';

export type KeyDoc = KeyDocShape;

// The existing admin key-change policy is a refusal, not an acquisition fault.
export class KeyChangeRefused extends MatrixError {
  constructor(name: string) {
    super(
      403,
      'M_FORBIDDEN',
      `signing key changed for ${name}; paused until the admin accepts`,
    );
  }
}

export type KeysDeps = {
  // unsigned GET of the origin's own key document (client.ts)
  directGet: (
    serverName: string,
    minimumValidUntilTs: number,
  ) => Promise<unknown>;
  // one witness's notary answer for serverName (client.ts)
  witnessQuery: (
    peer: string,
    serverName: string,
    minimumValidUntilTs: number,
  ) => Promise<unknown>;
  // roster witnesses by seniority (peers.ts), then the event's room's
  // servers when ctx carries a roomId
  listWitnesses: (ctx?: WitnessCtx) => Promise<string[]>;
};

// The witness set widens with the servers of the room the key is needed
// for. excludeName = the server being looked up (it never witnesses for
// itself).
export type WitnessCtx = { roomId?: string; excludeName?: string };

export type KeyRow = {
  key_id: string;
  pubkey_b64: string;
  valid_until_ts: number;
  expired_ts: number | null;
};

type DocRow = { key_json: string; fetched_ms: number; via: string };

export type KeyChangeRow = {
  server_name: string;
  seen_ms: number;
  old_keys: string;
  new_keys: string;
  status: string;
  acknowledged_old: boolean;
};

export type KeyStore = {
  acquireKeyDoc: (
    name: string,
    minimumValidUntilTs: number,
    ctx?: { roomId?: string },
  ) => Promise<KeyDoc>;
  getVerifyKey: (
    name: string,
    keyId: string,
    minimumValidUntilTs: number,
    purpose: 'request' | 'event',
    ctx?: { roomId?: string },
  ) => Promise<CryptoKey>;
  listServerKeys: (
    name: string | null,
  ) => Promise<{ rows: KeyRow[]; doc: DocRow | null }[]>;
  listKeyChanges: (name: string) => Promise<KeyChangeRow[]>;
  acceptKeyChange: (name: string) => Promise<boolean>;
  forgetServerKeys: (name: string) => Promise<void>;
};

// The production transport: signed GETs through the federation client,
// witnesses from the roster in the same server file.
function productionDeps(server: Db, signer: Signer): KeysDeps {
  return {
    directGet: async (name, _minimumValidUntilTs) => {
      const res = await federationRequest(server, signer, {
        destination: name,
        method: 'GET',
        path: '/_matrix/key/v2/server',
        body: null,
      });
      return res.json;
    },
    witnessQuery: async (peer, name, minimumValidUntilTs) => {
      const res = await federationRequest(server, signer, {
        destination: peer,
        method: 'GET',
        path: `/_matrix/key/v2/query/${
          encodeURIComponent(name)
        }?minimum_valid_until_ts=${minimumValidUntilTs}`,
        body: null,
      });
      return res.json;
    },
    listWitnesses: (ctx) => listWitnesses(server, ctx),
  };
}

type AcquisitionEpoch = { current: boolean; users: number };

type AcquisitionState = {
  inFlight: Map<string, Promise<KeyDoc>>;
  failureMemory: Map<string, { until: number; error: unknown }>;
  refusalMemory: Map<string, { until: number; error: KeyChangeRefused }>;
  warnedOnce: Set<string>;
  epochs: Map<string, AcquisitionEpoch>;
  mutations: Map<string, Promise<void>>;
};

const acquisitionStates = new WeakMap<Db, AcquisitionState>();

export function keyStore(
  server: Db,
  opts: { signer?: Signer; deps?: KeysDeps } = {},
): KeyStore {
  if (opts.deps === undefined && opts.signer === undefined) {
    throw new Error('keyStore: production transport needs the tenant signer');
  }
  const deps = opts.deps !== undefined
    ? opts.deps
    : productionDeps(server, opts.signer!);
  let state = acquisitionStates.get(server);
  if (state === undefined) {
    state = {
      inFlight: new Map(),
      failureMemory: new Map(),
      refusalMemory: new Map(),
      warnedOnce: new Set(),
      epochs: new Map(),
      mutations: new Map(),
    };
    acquisitionStates.set(server, state);
  }
  const {
    inFlight,
    failureMemory,
    refusalMemory,
    warnedOnce,
    epochs,
    mutations,
  } = state;

  // A generation is retained only while a lookup uses it. Admin decisions
  // invalidate that generation; old work can finish without publishing it.
  async function withEpoch<T>(
    name: string,
    fn: (epoch: AcquisitionEpoch) => Promise<T>,
  ): Promise<T> {
    let epoch = epochs.get(name);
    if (epoch === undefined) {
      epoch = { current: true, users: 0 };
      epochs.set(name, epoch);
    }
    epoch.users++;
    try {
      return await fn(epoch);
    } finally {
      if (--epoch.users === 0 && epochs.get(name) === epoch) {
        epochs.delete(name);
      }
    }
  }

  function requireCurrent(epoch: AcquisitionEpoch): void {
    if (!epoch.current) {
      throw new Error('key acquisition superseded by admin decision');
    }
  }

  function invalidate(name: string): void {
    const epoch = epochs.get(name);
    if (epoch !== undefined) epoch.current = false;
    epochs.delete(name);
    inFlight.delete(name);
    failureMemory.delete(name);
    refusalMemory.delete(name);
  }

  // Match the room mutation owner: network outside, lifecycle check and all
  // publication inside one non-reentrant name lock above file transactions.
  async function mutate<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = mutations.get(name);
    const before = previous === undefined ? Promise.resolve() : previous;
    let release!: () => void;
    const held = new Promise<void>((resolve) => release = resolve);
    const tail = before.then(() => held);
    mutations.set(name, tail);
    await before;
    try {
      return await fn();
    } finally {
      release();
      if (mutations.get(name) === tail) mutations.delete(name);
    }
  }

  // ---------------------------------------------------------------- DB ----

  async function readDocRow(name: string): Promise<DocRow | null> {
    const rows = await server.query(
      'SELECT key_json, fetched_ms, via FROM server_key_docs WHERE server_name = ?',
      [name],
    );
    if (rows.length === 0) return null;
    return {
      key_json: String(rows[0].key_json),
      fetched_ms: Number(rows[0].fetched_ms),
      via: String(rows[0].via),
    };
  }

  async function readKeyRows(name: string): Promise<KeyRow[]> {
    const rows = await server.query(
      'SELECT key_id, pubkey_b64, valid_until_ts, expired_ts FROM server_keys WHERE server_name = ?',
      [name],
    );
    return rows.map((row) => ({
      key_id: String(row.key_id),
      pubkey_b64: String(row.pubkey_b64),
      valid_until_ts: Number(row.valid_until_ts),
      expired_ts: row.expired_ts === null ? null : Number(row.expired_ts),
    }));
  }

  async function persistDoc(
    name: string,
    doc: KeyDoc,
    via: string,
  ): Promise<void> {
    const fetchedMs = Date.now();
    const effectiveUntil = Math.min(
      doc.valid_until_ts,
      fetchedMs + 7 * 86400_000,
    );
    await server.tx(async (tx) => {
      await tx.execute(
        'INSERT INTO server_key_docs(server_name, key_json, fetched_ms, via) VALUES(?,?,?,?) ON CONFLICT(server_name) DO UPDATE SET key_json = excluded.key_json, fetched_ms = excluded.fetched_ms, via = excluded.via',
        [name, JSON.stringify(doc), fetchedMs, via],
      );
      // the document fully re-states the server's keys — replace the cache
      await tx.execute('DELETE FROM server_keys WHERE server_name = ?', [name]);
      for (const [keyId, entry] of Object.entries(doc.verify_keys)) {
        await tx.execute(
          'INSERT INTO server_keys(server_name, key_id, pubkey_b64, valid_until_ts, fetched_ms, expired_ts) VALUES(?,?,?,?,?,NULL)',
          [name, keyId, entry.key, effectiveUntil, fetchedMs],
        );
      }
      for (const [keyId, entry] of Object.entries(oldKeysOf(doc))) {
        await tx.execute(
          'INSERT INTO server_keys(server_name, key_id, pubkey_b64, valid_until_ts, fetched_ms, expired_ts) VALUES(?,?,?,?,?,?)',
          [
            name,
            keyId,
            entry.key,
            effectiveUntil,
            fetchedMs,
            entry.expired_ts,
          ],
        );
      }
    });
  }

  // ------------------------------------------------------- validation ----

  // Decode before signature admission. The signed document stays intact;
  // effective capped validity is persisted separately in server_keys.
  async function validateCandidate(
    name: string,
    raw: unknown,
  ): Promise<KeyDoc> {
    const doc = keyDocument(raw);
    if (doc.server_name !== name) {
      throw new UpstreamError('validation', {
        phase: 'key-doc',
        reason: 'server identity mismatch',
      });
    }
    let selfSigned = false;
    for (const [keyId, entry] of Object.entries(doc.verify_keys)) {
      if (!keyId.startsWith('ed25519:')) continue;
      const pub = await importPublicKeyFromRaw(b64decode(entry.key));
      if (await verifyJson(doc, name, keyId, pub)) {
        selfSigned = true;
        break;
      }
    }
    if (!selfSigned) {
      throw new UpstreamError('validation', {
        phase: 'key-doc',
        reason: 'invalid self signature',
      });
    }
    return doc;
  }

  // --------------------------------------------------- key change --------

  function materialMapOf(rows: KeyRow[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of rows) out[row.key_id] = row.pubkey_b64;
    return out;
  }

  async function recordChange(opts: {
    name: string;
    oldKeys: Record<string, string>;
    newKeys: Record<string, string>;
    status: 'noted' | 'blocking';
    acknowledgedOld: boolean;
    candidate: { via: string; doc: KeyDoc } | null;
  }): Promise<void> {
    await server.execute(
      'INSERT INTO server_key_changes(server_name, seen_ms, old_keys, new_keys, status, acknowledged_old, candidate_json) VALUES(?,?,?,?,?,?,?)',
      [
        opts.name,
        Date.now(),
        JSON.stringify(opts.oldKeys),
        JSON.stringify(opts.newKeys),
        opts.status,
        opts.acknowledgedOld ? 1 : 0,
        opts.candidate === null ? null : JSON.stringify(opts.candidate),
      ],
    );
  }

  async function recordDisagreement(
    name: string,
    d: WitnessDisagreement,
  ): Promise<void> {
    const now = Date.now();
    const detail = JSON.stringify({
      senior: d.senior,
      junior: d.junior,
      keys: { senior: d.seniorKeys, junior: d.juniorKeys },
    });
    await server.execute(
      `INSERT INTO federation_pending(name, kind, verified, first_ms, last_ms, count, detail)
       VALUES(?, 'disagreement', 1, ?, ?, 1, ?)
       ON CONFLICT(name, kind) DO UPDATE SET last_ms = excluded.last_ms, count = federation_pending.count + 1, detail = excluded.detail`,
      [name, now, now, detail],
    );
  }

  // --------------------------------------------------- acquisition -------

  async function acquireKeyDoc(
    name: string,
    minimumValidUntilTs: number,
    ctx?: { roomId?: string },
    wantKeyId?: string,
  ): Promise<KeyDoc> {
    return await withEpoch(name, async (epoch) => {
      // rung 4: a key-is-name server IS its ed25519 key — nothing to fetch
      if (isKeyName(name)) {
        const raw = b32decode(name);
        return {
          server_name: name,
          verify_keys: { 'ed25519:0': { key: b64encodeStd(raw!) } },
          old_verify_keys: {},
          valid_until_ts: Number.MAX_SAFE_INTEGER,
          signatures: {},
        };
      }
      for (const memory of [refusalMemory, failureMemory]) {
        const failed = memory.get(name);
        if (failed !== undefined && Date.now() < failed.until) {
          throw failed.error;
        }
        memory.delete(name);
      }
      // Check each caller's demand before coalescing. Only actual refreshes
      // enter inFlight: a generic cached answer cannot satisfy a rotated-key
      // caller merely because both requests concern the same server.
      const row = await readDocRow(name);
      requireCurrent(epoch);
      if (row !== null) {
        const cached = JSON.parse(row.key_json) as KeyDoc;
        const hasKey = wantKeyId === undefined ||
          Object.hasOwn(cached.verify_keys, wantKeyId) ||
          Object.hasOwn(oldKeysOf(cached), wantKeyId);
        const effectiveUntil = Math.min(
          cached.valid_until_ts,
          row.fetched_ms + 7 * 86400_000,
        );
        if (hasKey && effectiveUntil >= minimumValidUntilTs) return cached;
      }
      const existing = inFlight.get(name);
      if (existing !== undefined) return await existing;
      const p = doAcquire(name, minimumValidUntilTs, epoch, ctx);
      inFlight.set(name, p);
      try {
        return await p;
      } finally {
        if (inFlight.get(name) === p) inFlight.delete(name);
      }
    });
  }

  async function doAcquire(
    name: string,
    minimumValidUntilTs: number,
    epoch: AcquisitionEpoch,
    ctx?: { roomId?: string },
  ): Promise<KeyDoc> {
    try {
      let candidate: { doc: KeyDoc; via: string } | null = null;
      const disagreements: WitnessDisagreement[] = [];

      // witnesses first — a single usable answer is single-source trust
      const peers = (await deps.listWitnesses({
        roomId: ctx?.roomId,
        excludeName: name,
      })).slice(
        0,
        config().federation.witnesses,
      );
      if (peers.length > 0) {
        const result = await askWitnesses({
          serverName: name,
          minimumValidUntilTs,
          peers,
          query: deps.witnessQuery,
          selfCheck: (doc) => validateCandidate(name, doc),
          witnessCheck: async (peer, doc) => {
            const witnessRows = await readKeyRows(peer);
            for (const w of witnessRows) {
              if (
                w.expired_ts !== null || w.valid_until_ts < Date.now() ||
                !w.key_id.startsWith('ed25519:')
              ) continue;
              const pub = await importPublicKeyFromRaw(b64decode(w.pubkey_b64));
              if (await verifyJson(doc, peer, w.key_id, pub)) return true;
            }
            return false;
          },
        });
        if (result !== null) {
          candidate = {
            doc: result.winner.doc,
            via: 'witness:' + result.winner.peer,
          };
          disagreements.push(...result.disagreements);
        }
      }

      // no usable witness answer at all → direct (open-mode fallback; in
      // closed mode only roster peers reach here — a consented address)
      if (candidate === null) {
        const raw = await deps.directGet(name, minimumValidUntilTs);
        const doc = await validateCandidate(name, raw);
        candidate = { doc, via: 'direct' };
      }

      const selected = candidate;
      return await mutate(name, async () => {
        requireCurrent(epoch);
        for (const disagreement of disagreements) {
          await recordDisagreement(name, disagreement);
        }
        // key-change decision, BEFORE persisting (rung 2, by material)
        const seenRows = await readKeyRows(name);
        const seen = materialFingerprint({
          server_name: name,
          verify_keys: Object.fromEntries(
            seenRows.filter((r) => r.expired_ts === null).map(
              (r) => [r.key_id, { key: r.pubkey_b64 }],
            ),
          ),
          old_verify_keys: Object.fromEntries(
            seenRows.filter((r) => r.expired_ts !== null).map(
              (r) => [r.key_id, {
                key: r.pubkey_b64,
                expired_ts: r.expired_ts as number,
              }],
            ),
          ),
          valid_until_ts: 0,
          signatures: {},
        });
        const docMaterial = materialFingerprint(selected.doc);
        const seenPairs = new Set(seen.split('\n'));
        const docPairs = docMaterial.split('\n');
        // any pair we have not seen is a change — whether or not the
        // document also repeats a remembered pair (repeating it is
        // information for the admin, not a pass; it is public and
        // copyable). A pure drop (the doc is a strict subset) is not a
        // change.
        const hasUnseen = docPairs.some((p) => !seenPairs.has(p));
        if (seenRows.length > 0 && hasUnseen) {
          const acknowledgedOld = docPairs.some((p) => seenPairs.has(p));
          const oldKeys = materialMapOf(seenRows);
          const newKeys = keyMapOf(selected.doc);
          const policy = config().federation.keychange;
          if (policy === 'block') {
            await recordChange({
              name,
              oldKeys,
              newKeys,
              status: 'blocking',
              acknowledgedOld,
              candidate: { via: selected.via, doc: selected.doc },
            });
            throw new KeyChangeRefused(name);
          }
          await recordChange({
            name,
            oldKeys,
            newKeys,
            status: 'noted',
            acknowledgedOld,
            candidate: null,
          });
          if (policy === 'warn') {
            const tag = name + '|' + docMaterial;
            if (!warnedOnce.has(tag)) {
              warnedOnce.add(tag);
              console.warn(
                `federation: signing key material changed for ${name} (recorded in server_key_changes; policy warn)`,
              );
            }
          }
          // honest note: this rung buys detection and a record, not proof;
          // rung 6 (signed cert fingerprint) is the proof
        }

        await persistDoc(name, selected.doc, selected.via);
        return selected.doc;
      });
    } catch (e) {
      if (epoch.current && e instanceof KeyChangeRefused) {
        refusalMemory.set(name, {
          until: Date.now() + config().federation.keyfailminutes * 60_000,
          error: e,
        });
      }
      if (
        epoch.current &&
        ['transport', 'protocol', 'validation', 'http'].includes(
          upstreamCategory(e),
        )
      ) {
        failureMemory.set(name, {
          until: Date.now() + config().federation.keyfailminutes * 60_000,
          error: e,
        });
      }
      throw e;
    }
  }

  // ------------------------------------------------------ verify keys ----

  // a cached key serves iff valid_until_ts covers the caller's horizon
  // and — retired keys sign EVENTS only (SS:254-258) — for 'request' the
  // key is not retired; for 'event' its expired_ts covers the horizon
  async function cachedVerifyKey(
    name: string,
    keyId: string,
    minimumValidUntilTs: number,
    purpose: 'request' | 'event',
  ): Promise<CryptoKey | null> {
    const rows = await readKeyRows(name);
    for (const row of rows) {
      if (row.key_id !== keyId) continue;
      if (row.valid_until_ts < minimumValidUntilTs) continue;
      if (purpose === 'request' && row.expired_ts !== null) continue;
      if (
        purpose === 'event' && row.expired_ts !== null &&
        row.expired_ts < minimumValidUntilTs
      ) {
        continue;
      }
      return await importPublicKeyFromRaw(b64decode(row.pubkey_b64));
    }
    return null;
  }

  async function getVerifyKey(
    name: string,
    keyId: string,
    minimumValidUntilTs: number,
    purpose: 'request' | 'event',
    ctx?: { roomId?: string },
  ): Promise<CryptoKey> {
    if (!/^ed25519:[a-zA-Z0-9_]+$/.test(keyId)) {
      throw new UpstreamError('validation', {
        phase: 'key-lookup',
        reason: 'unsupported key algorithm or identifier',
      });
    }
    if (isKeyName(name)) {
      if (keyId !== 'ed25519:0') {
        throw new UpstreamError('validation', {
          phase: 'key-lookup',
          reason: 'unknown key identifier',
        });
      }
      return await importPublicKeyFromRaw(b32decode(name)!);
    }
    return await withEpoch(name, async (epoch) => {
      const hit = await cachedVerifyKey(
        name,
        keyId,
        minimumValidUntilTs,
        purpose,
      );
      requireCurrent(epoch);
      if (hit !== null) return hit;
      await acquireKeyDoc(name, minimumValidUntilTs, ctx, keyId);
      const again = await cachedVerifyKey(
        name,
        keyId,
        minimumValidUntilTs,
        purpose,
      );
      requireCurrent(epoch);
      if (again !== null) return again;
      // A valid answer without the demanded key is still a failed lookup.
      // Remember it per server so varying random key ids cannot force dials.
      // Known cached keys above remain usable during this negative window.
      const error = new UpstreamError('validation', {
        phase: 'key-lookup',
        reason: 'key unavailable for required purpose and validity',
      });
      failureMemory.set(name, {
        until: Date.now() + config().federation.keyfailminutes * 60_000,
        error,
      });
      throw error;
    });
  }

  // ------------------------------------------------------- review tools --

  async function listServerKeys(
    name: string | null,
  ): Promise<{ rows: KeyRow[]; doc: DocRow | null }[]> {
    const names = name !== null ? [name] : (await server.query(
      'SELECT server_name FROM server_key_docs ORDER BY server_name',
    )).map((r) => String(r.server_name));
    const out: { rows: KeyRow[]; doc: DocRow | null }[] = [];
    for (const n of names) {
      out.push({ rows: await readKeyRows(n), doc: await readDocRow(n) });
    }
    return out;
  }

  async function listKeyChanges(name: string): Promise<KeyChangeRow[]> {
    const rows = await server.query(
      'SELECT server_name, seen_ms, old_keys, new_keys, status, acknowledged_old FROM server_key_changes WHERE server_name = ? ORDER BY seen_ms DESC',
      [name],
    );
    return rows.map((row) => ({
      server_name: String(row.server_name),
      seen_ms: Number(row.seen_ms),
      old_keys: String(row.old_keys),
      new_keys: String(row.new_keys),
      status: String(row.status),
      acknowledged_old: Number(row.acknowledged_old) !== 0,
    }));
  }

  /** federation-key accept: install the reviewed candidate document
   *  atomically (server_key_docs + server_keys), mark the change accepted. */
  async function acceptKeyChange(name: string): Promise<boolean> {
    return await mutate(name, async () => {
      const found = await server.tx(async (tx) => {
        const rows = await tx.query(
          "SELECT seen_ms, candidate_json FROM server_key_changes WHERE server_name = ? AND status = 'blocking' ORDER BY seen_ms DESC LIMIT 1",
          [name],
        );
        if (rows.length === 0) return null;
        await tx.execute(
          "UPDATE server_key_changes SET status = 'accepted' WHERE server_name = ? AND seen_ms = ?",
          [name, Number(rows[0].seen_ms)],
        );
        return JSON.parse(String(rows[0].candidate_json)) as {
          via: string;
          doc: KeyDoc;
        };
      });
      if (found === null) return false;
      await persistDoc(name, found.doc, 'accepted');
      invalidate(name);
      return true;
    });
  }

  /** federation-key forget: delete the server's remembered keys and
   *  documents — the next contact is first contact again. */
  async function forgetServerKeys(name: string): Promise<void> {
    await mutate(name, async () => {
      await server.tx(async (tx) => {
        await tx.execute('DELETE FROM server_keys WHERE server_name = ?', [
          name,
        ]);
        await tx.execute('DELETE FROM server_key_docs WHERE server_name = ?', [
          name,
        ]);
        await tx.execute(
          "UPDATE server_key_changes SET status = 'forgotten' WHERE server_name = ? AND status IN ('noted', 'blocking')",
          [name],
        );
      });
      invalidate(name);
    });
  }

  return {
    acquireKeyDoc,
    getVerifyKey,
    listServerKeys,
    listKeyChanges,
    acceptKeyChange,
    forgetServerKeys,
  };
}

// --------------------------------------------------------- our doc -----

// Sign a JSON document with the tenant Signer (the signJson shape:
// signatures/unsigned stripped, canonical bytes signed, attached under
// signatures[serverName][keyId]). Mutates doc.
export async function signWithSigner(
  doc: Record<string, unknown>,
  signer: Signer,
): Promise<void> {
  const signatures =
    (doc.signatures !== undefined ? doc.signatures : {}) as Record<
      string,
      Record<string, string>
    >;
  const stripped = { ...doc };
  delete stripped.signatures;
  delete stripped.unsigned;
  const sig = await signer.sign(canonicalJson(stripped));
  if (signatures[signer.serverName] === undefined) {
    signatures[signer.serverName] = {};
  }
  signatures[signer.serverName][signer.keyId] = sig;
  doc.signatures = signatures;
}

// Our own key document (the served data; the endpoint is stage 5). The
// tenant's public key arrives alongside its Signer (the Signer carries
// no public half); key documents use the unpadded STANDARD alphabet.
export async function ourKeyDocument(
  signer: Signer,
  publicB64: string,
): Promise<KeyDoc> {
  const doc: KeyDoc = {
    server_name: signer.serverName,
    verify_keys: {
      [signer.keyId]: { key: b64encodeStd(b64decode(publicB64)) },
    },
    old_verify_keys: {},
    valid_until_ts: Date.now() +
      config().federation.keyvalidityhours * 3_600_000,
    signatures: {},
  };
  await signWithSigner(doc as unknown as Record<string, unknown>, signer);
  return doc;
}
