// api/engine/federation/keys.ts — remembered server signing keys.
// Acquisition is WITNESSES-FIRST (design rung 5): a stranger's document is
// asked of roster peers a person vouched for; a direct dial to the origin
// happens only when no witness answered (open mode) or for a roster peer
// (closed mode — the gate stops strangers first). Key changes are decided
// by (id, bytes) MATERIAL before anything is persisted; `block` keeps the
// candidate only inside the change row. The transport and the witness
// list are INJECTED — this module never imports client.ts or peers.ts
// (wired in later commits); tests drive it with stubs.
import { config, serverName } from '#engine/config.ts';
import { serverDb, withDb } from '#engine/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getTenantKey } from '#engine/tenant.ts';
import {
  b32decode,
  b64decode,
  b64encodeStd,
  importPublicKeyFromRaw,
  isKeyName,
  signJson,
  verifyJson,
} from '#engine/signing-primitives.js';
import {
  askWitnesses,
  type KeyDocShape,
  keyMapOf,
  materialFingerprint,
  type WitnessDisagreement,
} from './witness.ts';

export type KeyDoc = KeyDocShape;

export type KeysDeps = {
  // unsigned GET of the origin's own key document (commit 6: client.ts)
  directGet: (
    serverName: string,
    minimumValidUntilTs: number,
  ) => Promise<unknown>;
  // one witness's notary answer for serverName (commit 6: client.ts)
  witnessQuery: (
    peer: string,
    serverName: string,
    minimumValidUntilTs: number,
  ) => Promise<unknown>;
  // roster witnesses by seniority (commit 5: peers.ts), then — M5b — the
  // event's room's servers when ctx carries a roomId
  listWitnesses: (ctx?: WitnessCtx) => Promise<string[]>;
};

// M5b (§3.2): the witness set widens with the servers of the room the
// key is needed for. excludeName = the server being looked up (it never
// witnesses for itself).
export type WitnessCtx = { roomId?: string; excludeName?: string };

let _deps: KeysDeps | null = null;

/** Wired by the outbound-client commit; tests use the *With variants. */
export function setKeysDeps(deps: KeysDeps): void {
  _deps = deps;
}

function keysDeps(): KeysDeps {
  if (_deps === null) {
    throw new Error('federation key transport is not wired');
  }
  return _deps;
}

// ---------------------------------------------------------------- DB ----

type DocRow = { key_json: string; fetched_ms: number; via: string };

async function readDocRow(name: string): Promise<DocRow | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT key_json, fetched_ms, via FROM server_key_docs WHERE server_name = $1;',
      [name],
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0] as Record<string, unknown>;
    return {
      key_json: String(row.key_json),
      fetched_ms: Number(row.fetched_ms),
      via: String(row.via),
    };
  });
}

type KeyRow = {
  key_id: string;
  pubkey_b64: string;
  valid_until_ts: number;
  expired_ts: number | null;
};

async function readKeyRows(name: string): Promise<KeyRow[]> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT key_id, pubkey_b64, valid_until_ts, expired_ts FROM server_keys WHERE server_name = $1;',
      [name],
    );
    return r.rows.map((row: unknown) => {
      const o = row as Record<string, unknown>;
      return {
        key_id: String(o.key_id),
        pubkey_b64: String(o.pubkey_b64),
        valid_until_ts: Number(o.valid_until_ts),
        expired_ts: o.expired_ts === null ? null : Number(o.expired_ts),
      };
    });
  });
}

async function persistDoc(
  name: string,
  doc: KeyDoc,
  via: string,
): Promise<void> {
  const fetchedMs = Date.now();
  await withDb(serverDb(), async (c) => {
    await c.query(
      'INSERT INTO server_key_docs (server_name, key_json, fetched_ms, via) VALUES ($1, $2, $3, $4) ON CONFLICT (server_name) DO UPDATE SET key_json = $2, fetched_ms = $3, via = $4;',
      [name, JSON.stringify(doc), fetchedMs, via],
    );
    // the document fully re-states the server's keys — replace the cache
    await c.query('DELETE FROM server_keys WHERE server_name = $1;', [name]);
    for (const [keyId, entry] of Object.entries(doc.verify_keys)) {
      await c.query(
        'INSERT INTO server_keys (server_name, key_id, pubkey_b64, valid_until_ts, fetched_ms, expired_ts) VALUES ($1, $2, $3, $4, $5, NULL);',
        [name, keyId, entry.key, doc.valid_until_ts, fetchedMs],
      );
    }
    for (const [keyId, entry] of Object.entries(doc.old_verify_keys)) {
      await c.query(
        'INSERT INTO server_keys (server_name, key_id, pubkey_b64, valid_until_ts, fetched_ms, expired_ts) VALUES ($1, $2, $3, $4, $5, $6);',
        [
          name,
          keyId,
          entry.key,
          doc.valid_until_ts,
          fetchedMs,
          entry.expired_ts,
        ],
      );
    }
  });
}

// ------------------------------------------------------- validation ----

// Required fields (definitions/keys.yaml:101), server_name equality,
// self-signature with one of the document's own verify_keys; caps
// valid_until_ts at now + 7d (definitions/keys.yaml:96-99). Throws 502 on
// any failure — the caller maps as it sees fit.
async function validateCandidate(
  name: string,
  raw: unknown,
): Promise<KeyDoc> {
  if (raw === null || typeof raw !== 'object') {
    throw new MatrixError(502, 'M_UNKNOWN', `key fetch failed: ${name}`);
  }
  const doc = raw as KeyDoc;
  if (
    typeof doc.server_name !== 'string' || doc.server_name !== name ||
    doc.verify_keys === null || typeof doc.verify_keys !== 'object' ||
    doc.signatures === null || typeof doc.signatures !== 'object' ||
    typeof doc.valid_until_ts !== 'number'
  ) {
    throw new MatrixError(502, 'M_UNKNOWN', `key fetch failed: ${name}`);
  }
  if (doc.old_verify_keys === null || typeof doc.old_verify_keys !== 'object') {
    doc.old_verify_keys = {};
  }
  let selfSigned = false;
  for (const [keyId, entry] of Object.entries(doc.verify_keys)) {
    if (!keyId.startsWith('ed25519:')) continue;
    try {
      const pub = await importPublicKeyFromRaw(b64decode(entry.key));
      if (await verifyJson(doc, name, keyId, pub)) {
        selfSigned = true;
        break;
      }
    } catch { /* malformed key entry — try the next */ }
  }
  if (!selfSigned) {
    throw new MatrixError(502, 'M_UNKNOWN', `key fetch failed: ${name}`);
  }
  const cap = Date.now() + 7 * 24 * 3600 * 1000;
  if (doc.valid_until_ts > cap) doc.valid_until_ts = cap;
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
  await withDb(serverDb(), async (c) => {
    await c.query(
      'INSERT INTO server_key_changes (server_name, seen_ms, old_keys, new_keys, status, acknowledged_old, candidate_json) VALUES ($1, $2, $3, $4, $5, $6, $7);',
      [
        opts.name,
        Date.now(),
        JSON.stringify(opts.oldKeys),
        JSON.stringify(opts.newKeys),
        opts.status,
        opts.acknowledgedOld,
        opts.candidate === null ? null : JSON.stringify(opts.candidate),
      ],
    );
  });
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
  await withDb(serverDb(), async (c) => {
    await c.query(
      `INSERT INTO federation_pending (name, kind, verified, first_ms, last_ms, count, detail)
       VALUES ($1, 'disagreement', TRUE, $2, $2, 1, $3)
       ON CONFLICT (name, kind) DO UPDATE SET last_ms = $2, count = federation_pending.count + 1, detail = $3;`,
      [name, now, detail],
    );
  });
}

// --------------------------------------------------- acquisition -------

const inFlight = new Map<string, Promise<KeyDoc>>();
const failureMemory = new Map<string, number>(); // name → untilMs
const warnedOnce = new Set<string>(); // name|fingerprint, per process

export async function acquireKeyDoc(
  name: string,
  minimumValidUntilTs: number,
  ctx?: { roomId?: string },
): Promise<KeyDoc> {
  return await acquireKeyDocWith(name, minimumValidUntilTs, keysDeps(), ctx);
}

export async function acquireKeyDocWith(
  name: string,
  minimumValidUntilTs: number,
  deps: KeysDeps,
  ctx?: { roomId?: string },
): Promise<KeyDoc> {
  // rung 4: a key-is-name server IS its ed25519 key — nothing to fetch
  if (isKeyName(name)) {
    const raw = b32decode(name);
    return {
      server_name: name,
      verify_keys: { 'ed25519:0': { key: b64encodeStd(raw) } },
      old_verify_keys: {},
      valid_until_ts: Number.MAX_SAFE_INTEGER,
      signatures: {},
    };
  }
  const until = failureMemory.get(name);
  if (until !== undefined && Date.now() < until) {
    throw new MatrixError(502, 'M_UNKNOWN', `key fetch failed: ${name}`);
  }
  const existing = inFlight.get(name);
  if (existing !== undefined) return await existing;
  const p = doAcquire(name, minimumValidUntilTs, deps, ctx);
  inFlight.set(name, p);
  try {
    return await p;
  } finally {
    inFlight.delete(name);
  }
}

async function doAcquire(
  name: string,
  minimumValidUntilTs: number,
  deps: KeysDeps,
  ctx?: { roomId?: string },
): Promise<KeyDoc> {
  try {
    // cache: a stored document that still serves the caller's horizon
    const row = await readDocRow(name);
    if (row !== null) {
      const cached = JSON.parse(row.key_json) as KeyDoc;
      if (cached.valid_until_ts >= minimumValidUntilTs) return cached;
    }

    let candidate: { doc: KeyDoc; via: string } | null = null;

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
        selfCheck: async (doc) => {
          try {
            return await validateCandidate(name, doc);
          } catch {
            return null;
          }
        },
        witnessCheck: async (peer, doc) => {
          const witnessRows = await readKeyRows(peer);
          for (const w of witnessRows) {
            if (w.expired_ts !== null) continue;
            try {
              const pub = await importPublicKeyFromRaw(b64decode(w.pubkey_b64));
              if (await verifyJson(doc, peer, w.key_id, pub)) return true;
            } catch { /* try the next cached key */ }
          }
          return false;
        },
      });
      if (result !== null) {
        candidate = {
          doc: result.winner.doc,
          via: 'witness:' + result.winner.peer,
        };
        for (const d of result.disagreements) {
          await recordDisagreement(name, d);
        }
      }
    }

    // no usable witness answer at all → direct (open-mode fallback; in
    // closed mode only roster peers reach here — a consented address)
    if (candidate === null) {
      const raw = await deps.directGet(name, minimumValidUntilTs);
      const doc = await validateCandidate(name, raw);
      candidate = { doc, via: 'direct' };
    }

    // key-change decision, BEFORE persisting (rung 2, by material)
    const seenRows = await readKeyRows(name);
    const seen = materialFingerprint({
      server_name: name,
      verify_keys: Object.fromEntries(
        seenRows.filter((r) => r.expired_ts === null).map((
          r,
        ) => [r.key_id, { key: r.pubkey_b64 }]),
      ),
      old_verify_keys: Object.fromEntries(
        seenRows.filter((r) => r.expired_ts !== null).map((
          r,
        ) => [r.key_id, {
          key: r.pubkey_b64,
          expired_ts: r.expired_ts as number,
        }]),
      ),
      valid_until_ts: 0,
      signatures: {},
    });
    const docMaterial = materialFingerprint(candidate.doc);
    const seenPairs = new Set(seen.split('\n'));
    const docPairs = docMaterial.split('\n');
    // any pair we have not seen is a change — whether or not the document
    // also repeats a remembered pair (repeating it is information for the
    // admin, not a pass; it is public and copyable). A pure drop (the doc
    // is a strict subset) is not a change.
    const hasUnseen = docPairs.some((p) => !seenPairs.has(p));
    if (seenRows.length > 0 && hasUnseen) {
      const acknowledgedOld = docPairs.some((p) => seenPairs.has(p));
      const oldKeys = materialMapOf(seenRows);
      const newKeys = keyMapOf(candidate.doc);
      const policy = config().federation.keychange;
      if (policy === 'block') {
        await recordChange({
          name,
          oldKeys,
          newKeys,
          status: 'blocking',
          acknowledgedOld,
          candidate: { via: candidate.via, doc: candidate.doc },
        });
        throw new MatrixError(
          403,
          'M_FORBIDDEN',
          `signing key changed for ${name}; paused until the admin accepts`,
        );
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

    await persistDoc(name, candidate.doc, candidate.via);
    return candidate.doc;
  } catch (e) {
    if (e instanceof MatrixError && e.status === 403) throw e;
    failureMemory.set(
      name,
      Date.now() + config().federation.keyfailminutes * 60_000,
    );
    if (e instanceof MatrixError) throw e;
    throw new MatrixError(502, 'M_UNKNOWN', `key fetch failed: ${name}`);
  }
}

// ------------------------------------------------------ verify keys ----

export async function getVerifyKey(
  name: string,
  keyId: string,
  minimumValidUntilTs: number,
  purpose: 'request' | 'event',
  ctx?: { roomId?: string },
): Promise<CryptoKey> {
  return await getVerifyKeyWith(
    name,
    keyId,
    minimumValidUntilTs,
    purpose,
    keysDeps(),
    ctx,
  );
}

export async function getVerifyKeyWith(
  name: string,
  keyId: string,
  minimumValidUntilTs: number,
  purpose: 'request' | 'event',
  deps: KeysDeps,
  ctx?: { roomId?: string },
): Promise<CryptoKey> {
  if (isKeyName(name)) {
    if (keyId !== 'ed25519:0') {
      throw new MatrixError(502, 'M_UNKNOWN', `key fetch failed: ${name}`);
    }
    return await importPublicKeyFromRaw(b32decode(name));
  }
  const hit = await cachedVerifyKey(name, keyId, minimumValidUntilTs, purpose);
  if (hit !== null) return hit;
  await acquireKeyDocWith(name, minimumValidUntilTs, deps, ctx);
  const again = await cachedVerifyKey(
    name,
    keyId,
    minimumValidUntilTs,
    purpose,
  );
  if (again !== null) return again;
  throw new MatrixError(502, 'M_UNKNOWN', `key fetch failed: ${name}`);
}

// a cached key serves iff valid_until_ts covers the caller's horizon and
// — retired keys sign EVENTS only (SS:254-258) — for 'request' the key is
// not retired; for 'event' its expired_ts covers the horizon
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

// --------------------------------------------------------- our doc -----

export async function ourKeyDocument(): Promise<KeyDoc> {
  const key = await getTenantKey();
  const keyId = 'ed25519:' + key.keyId;
  const doc: KeyDoc = {
    server_name: serverName(),
    verify_keys: {
      // tenant publicB64 is the URL-safe standard rendering; key documents
      // use the unpadded STANDARD alphabet (appendices § Unpadded Base64)
      [keyId]: { key: b64encodeStd(b64decode(key.publicB64)) },
    },
    old_verify_keys: {},
    valid_until_ts: Date.now() +
      config().federation.keyvalidityhours * 3_600_000,
    signatures: {},
  };
  await signJson(doc, serverName(), keyId, key.privateKey);
  return doc;
}

// ------------------------------------------------------- review tools --

export type KeyChangeRow = {
  server_name: string;
  seen_ms: number;
  old_keys: string;
  new_keys: string;
  status: string;
  acknowledged_old: boolean;
};

export async function listServerKeys(
  name: string | null,
): Promise<{ rows: KeyRow[]; doc: DocRow | null }[]> {
  return await withDb(serverDb(), async (c) => {
    const names = name !== null ? [name] : (await c.query(
      'SELECT server_name FROM server_key_docs ORDER BY server_name;',
    ))
      .rows.map((r: unknown) =>
        String((r as Record<string, unknown>).server_name)
      );
    const out: { rows: KeyRow[]; doc: DocRow | null }[] = [];
    for (const n of names) {
      out.push({ rows: await readKeyRows(n), doc: await readDocRow(n) });
    }
    return out;
  });
}

export async function listKeyChanges(
  name: string,
): Promise<KeyChangeRow[]> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT server_name, seen_ms, old_keys, new_keys, status, acknowledged_old FROM server_key_changes WHERE server_name = $1 ORDER BY seen_ms DESC;',
      [name],
    );
    return r.rows.map((row: unknown) => {
      const o = row as Record<string, unknown>;
      return {
        server_name: String(o.server_name),
        seen_ms: Number(o.seen_ms),
        old_keys: String(o.old_keys),
        new_keys: String(o.new_keys),
        status: String(o.status),
        acknowledged_old: Boolean(o.acknowledged_old),
      };
    });
  });
}

/** federation-key accept: install the reviewed candidate document
 *  atomically (server_key_docs + server_keys), mark the change accepted. */
export async function acceptKeyChange(name: string): Promise<boolean> {
  const found = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      "SELECT seen_ms, candidate_json FROM server_key_changes WHERE server_name = $1 AND status = 'blocking' ORDER BY seen_ms DESC LIMIT 1;",
      [name],
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0] as Record<string, unknown>;
    await c.query(
      "UPDATE server_key_changes SET status = 'accepted' WHERE server_name = $1 AND seen_ms = $2;",
      [name, Number(row.seen_ms)],
    );
    return JSON.parse(String(row.candidate_json)) as {
      via: string;
      doc: KeyDoc;
    };
  });
  if (found === null) return false;
  await persistDoc(name, found.doc, 'accepted');
  return true;
}

/** federation-key forget: delete the server's remembered keys and
 *  documents — the next contact is first contact again. */
export async function forgetServerKeys(name: string): Promise<void> {
  await withDb(serverDb(), async (c) => {
    await c.query('DELETE FROM server_keys WHERE server_name = $1;', [name]);
    await c.query('DELETE FROM server_key_docs WHERE server_name = $1;', [
      name,
    ]);
    await c.query(
      "UPDATE server_key_changes SET status = 'forgotten' WHERE server_name = $1 AND status IN ('noted', 'blocking');",
      [name],
    );
  });
}
