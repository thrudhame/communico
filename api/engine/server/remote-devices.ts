// Server-owned learned state. Network recovery never holds a storage transaction.
import type { Conn, Database } from '#engine/store/db.ts';
import type { DeviceDelta, DeviceSnapshot } from '#engine/e2ee-remote.ts';
import {
  bounded,
  type Json,
  type KeyLimits,
  limitEntries,
} from '#engine/e2ee-wire.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import {
  nextDeviceSeq,
  publishDeviceChange,
} from '#engine/server/device-notices.ts';
import { eventStreamTx } from '#engine/server/stream.ts';
import { keyView } from '#engine/e2ee-key-view.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { changedColumns } from '#engine/store/changed.ts';
import {
  type PublicSigning,
  signingViews,
  verifiedPublicSigning,
} from '#engine/e2ee-public-signing.ts';

async function signingState(
  tx: Conn,
  user: string,
): Promise<{ revision: number; keys: PublicSigning }> {
  const row = (await tx.query(
    'SELECT revision,payload FROM remote_signing_keys WHERE user_id=?',
    [user],
  ))[0];
  return row
    ? { revision: Number(row.revision), keys: JSON.parse(String(row.payload)) }
    : { revision: 0, keys: {} };
}
// Same above-store, non-reentrant mutex discipline as room/lock.ts. Only local
// commit/recheck work runs here, never origin discovery or network requests.
const signingLocks = new Map<string, Promise<void>>();
async function serializeSigning<T>(
  db: Database,
  user: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([db.path, user]);
  const previous = signingLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  signingLocks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (signingLocks.get(key) === tail) signingLocks.delete(key);
  }
}
/** Recheck a learned target revision without holding a server transaction over tenant work. */
export function withRemoteSigningState<T>(
  db: Database,
  user: string,
  fn: (state: { revision: number; keys: PublicSigning }) => Promise<T>,
): Promise<T> {
  return serializeSigning(
    db,
    user,
    async () => fn(await db.tx((tx) => signingState(tx, user))),
  );
}
/** Pin several learned signing cuts in deterministic mutex order. The callback
 * runs above storage: no server transaction is held over another file's work. */
export function withRemoteSigningStates<T>(
  db: Database,
  users: string[],
  fn: (
    states: ReadonlyMap<string, { revision: number; keys: PublicSigning }>,
  ) => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(users)].sort();
  const states = new Map<string, { revision: number; keys: PublicSigning }>();
  const next = (index: number): Promise<T> =>
    index === ordered.length
      ? fn(states)
      : withRemoteSigningState(db, ordered[index], (state) => {
        states.set(ordered[index], state);
        return next(index + 1);
      });
  return next(0);
}
async function writeSigning(
  tx: Conn,
  user: string,
  keys: PublicSigning,
): Promise<boolean> {
  const prior = await signingState(tx, user);
  if (canonicalJson(prior.keys) === canonicalJson(keys)) return false;
  await tx.execute(
    'INSERT INTO remote_signing_keys VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload',
    [user, prior.revision + 1, canonicalJson(keys)],
  );
  return true;
}

/** EDU and authoritative snapshot writes share this transaction-owned revision. */
export async function acceptSigningUpdate(
  db: Database,
  user: string,
  supplied: PublicSigning,
  limits: KeyLimits,
  localServer: string,
): Promise<void> {
  await serializeSigning(db, user, () =>
    eventStreamTx(db, async (tx) => {
      if (
        !(await tx.query(
          "SELECT 1 FROM device_tracking WHERE subject=? AND scope='keys' AND end_seq IS NULL AND substr(observer,instr(observer,':')+1)=? LIMIT 1",
          [user, localServer],
        )).length
      ) return;
      const prior = await signingState(tx, user);
      const keys = await verifiedPublicSigning(
        supplied,
        user,
        limits,
        prior.keys,
      );
      if (await writeSigning(tx, user, keys)) await notify(tx, user);
    }));
}

type Pending = { revision: number; delta: DeviceDelta };

/** Invalidate learned device completeness in a private restore candidate. */
export async function invalidateRestoredDeviceCaches(
  tx: Conn,
): Promise<number> {
  const [{ count }] = await tx.query(
    'SELECT COUNT(*) AS count FROM remote_device_users',
  );
  // Learned keys remain for comparison/trust continuity but cannot answer a
  // query until a fresh authoritative snapshot establishes completeness.
  await tx.execute(
    "UPDATE remote_device_users SET anchor=NULL,stale=1,revision=revision+1,pending='[]',seen='[]',retry_at=0,failures=0",
  );
  await tx.execute(
    'INSERT INTO device_recovery_requests SELECT user_id FROM remote_device_users WHERE 1 ON CONFLICT DO NOTHING',
  );
  return Number(count);
}

type State = {
  anchor: string | null;
  stale: boolean;
  revision: number;
  pending: Pending[];
  seen: string[];
};
/** A relationship boundary also invalidates any in-flight snapshot generation. */
export async function invalidateDeviceCache(
  tx: Conn,
  user: string,
): Promise<void> {
  await tx.execute('DELETE FROM device_recovery_requests WHERE user_id=?', [
    user,
  ]);
  await tx.execute(
    "UPDATE remote_device_users SET stale=1,revision=revision+1,pending='[]',seen='[]',retry_at=0 WHERE user_id=?",
    [user],
  );
}
async function state(tx: Conn, user: string): Promise<State | null> {
  const r =
    (await tx.query('SELECT * FROM remote_device_users WHERE user_id=?', [
      user,
    ]))[0];
  return r
    ? {
      anchor: r.anchor === null ? null : String(r.anchor),
      stale: Number(r.stale) === 1,
      revision: Number(r.revision),
      pending: JSON.parse(String(r.pending)),
      seen: JSON.parse(String(r.seen)),
    }
    : null;
}
async function writeState(tx: Conn, user: string, s: State): Promise<void> {
  await tx.execute(
    'UPDATE remote_device_users SET anchor=?,stale=?,revision=?,pending=?,seen=? WHERE user_id=?',
    [
      s.anchor,
      s.stale ? 1 : 0,
      s.revision,
      JSON.stringify(s.pending),
      JSON.stringify(s.seen),
      user,
    ],
  );
}
async function notify(tx: Conn, user: string): Promise<void> {
  await publishDeviceChange(tx, await nextDeviceSeq(tx), user);
}

// Delta and authoritative-list publication share semantic key comparison. Old
// JSON may use another property order; completeness/causal progress is separate.
async function writeDeviceKey(
  tx: Conn,
  user: string,
  id: string,
  key: Json,
  previous: Json | undefined,
): Promise<void> {
  const encoded = canonicalJson(key);
  if (previous !== undefined && canonicalJson(previous) === encoded) return;
  await tx.execute(
    `INSERT INTO remote_device_keys VALUES(?,?,?)
     ON CONFLICT(user_id,device_id) DO UPDATE SET key_json=excluded.key_json
     WHERE ${changedColumns('remote_device_keys', 'key_json')}`,
    [user, id, encoded],
  );
}

async function applyDeviceDelta(
  tx: Conn,
  d: DeviceDelta,
  limits: KeyLimits,
): Promise<void> {
  const keys = new Map<string, Json>((await tx.query(
    'SELECT device_id,key_json FROM remote_device_keys WHERE user_id=?',
    [d.user],
  )).map((r) => [String(r.device_id), JSON.parse(String(r.key_json))]));
  const previous = keys.get(d.id);
  if (d.deleted || d.key === null) keys.delete(d.id);
  else keys.set(d.id, d.key);
  const signing = (await signingState(tx, d.user)).keys;
  limitEntries(keys.size + Object.keys(signing).length, limits.maxkeys);
  bounded({ devices: [...keys.values()], signing }, limits.maxrequestbytes);

  // Persist only a publishable view. On overflow, recovery still compares
  // against the material clients could query before the cache became stale.
  if (d.deleted || d.key === null) {
    await tx.execute(
      'DELETE FROM remote_device_keys WHERE user_id=? AND device_id=?',
      [d.user, d.id],
    );
  } else {
    await writeDeviceKey(tx, d.user, d.id, d.key, previous);
  }
}
function compatible(d: DeviceDelta, seen: string[]): boolean {
  return d.prev.length > 0 && d.prev.every((p) => seen.includes(p));
}

/** The caller has already checked origin and the current all-room subscription. */
export async function acceptDeviceDelta(
  db: Database,
  d: DeviceDelta,
  limits: KeyLimits,
  localServer?: string,
): Promise<void> {
  await eventStreamTx(db, async (tx) => {
    if (
      localServer !== undefined && !(await tx.query(
        "SELECT 1 FROM device_tracking WHERE subject=? AND scope='keys' AND end_seq IS NULL AND substr(observer,instr(observer,':')+1)=? LIMIT 1",
        [d.user, localServer],
      )).length
    ) return;
    await tx.execute(
      "INSERT INTO remote_device_users VALUES(?,NULL,1,0,0,0,'[]','[]') ON CONFLICT DO NOTHING",
      [d.user],
    );
    const s = (await state(tx, d.user))!;
    if (
      s.seen.includes(d.stream) ||
      s.pending.some((p) => p.delta.stream === d.stream)
    ) return;
    s.revision++;
    if (!s.stale && compatible(d, s.seen)) {
      // Cache overflow is invalidation, never a truncated authoritative list.
      try {
        await applyDeviceDelta(tx, d, limits);
        s.anchor = d.stream;
        s.seen = [...s.seen, d.stream].slice(-limits.maxkeys);
      } catch (error) {
        if (!(error instanceof UpstreamError && error.context.resourceLimit)) {
          throw error;
        }
        s.stale = true;
      }
    } else s.stale = true;
    if (s.stale) {
      await tx.execute(
        'INSERT INTO device_recovery_requests VALUES(?) ON CONFLICT DO NOTHING',
        [d.user],
      );
      s.pending.push({ revision: s.revision, delta: d });
      try {
        limitEntries(s.pending.length, limits.maxkeys);
        bounded(s.pending, limits.maxrequestbytes);
      } catch (error) {
        if (!(error instanceof UpstreamError && error.context.resourceLimit)) {
          throw error;
        }
        // Losing cache hints is safe only with a durable invalidation. Revision
        // still rejects an older in-flight snapshot which cannot replay them.
        s.pending = [];
      }
    }
    await writeState(tx, d.user, s);
    // A gapped update only invalidates the cache. Recovery publishes changed
    // material and its notice together; announcing the hint here would let
    // sync report this update twice, including before the keys are queryable.
    if (!s.stale) await notify(tx, d.user);
  });
}

export type RecoveryCut = {
  user: string;
  revision: number;
  signingRevision: number;
};
/** Membership creates dormant stale state; only explicit demand or a hint activates retry. */
export async function requestDeviceRecovery(
  db: Database,
  user: string,
): Promise<void> {
  await db.tx(async (tx) => {
    await tx.execute(
      'INSERT INTO device_recovery_requests SELECT user_id FROM remote_device_users WHERE user_id=? AND stale=1 ON CONFLICT DO NOTHING',
      [user],
    );
  });
}
export async function recoveryCut(
  db: Database,
  user: string,
): Promise<RecoveryCut | null> {
  return await db.tx(async (tx) => {
    const s = await state(tx, user);
    return s?.stale
      ? {
        user,
        revision: s.revision,
        signingRevision: (await signingState(tx, user)).revision,
      }
      : null;
  });
}

/** Commit an authoritative cut, replaying only causally linked concurrent deltas. */
export async function installDeviceSnapshot(
  db: Database,
  cut: RecoveryCut,
  snapshot: DeviceSnapshot,
  limits: KeyLimits,
): Promise<boolean> {
  const signing = await verifiedPublicSigning(
    snapshot.signing,
    snapshot.user,
    limits,
  );
  return await serializeSigning(
    db,
    cut.user,
    () =>
      eventStreamTx(db, async (tx) => {
        const s = await state(tx, cut.user);
        if (!s?.stale || snapshot.user !== cut.user) return false;
        // Signing EDUs have no causal stream IDs. Reject the old whole snapshot
        // rather than let it overwrite an independently committed key rotation.
        if (
          (await signingState(tx, cut.user)).revision !== cut.signingRevision
        ) {
          return false;
        }
        const newer = s.pending.filter((p) => p.revision > cut.revision);
        if (
          s.revision - cut.revision !== newer.length ||
          newer.some((p, i) => p.revision !== cut.revision + i + 1)
        ) return false;
        const seen = [snapshot.stream];
        // The fetch can include mutations accepted after its local recovery cut.
        // Walk the snapshot's known causal ancestry, not numeric stream ordering:
        // all of those hints are already represented by the authoritative cut.
        const covered = new Set([snapshot.stream]);
        const byStream = new Map(newer.map((p) => [p.delta.stream, p.delta]));
        const visit = [snapshot.stream];
        while (visit.length) {
          const d = byStream.get(visit.pop()!);
          if (!d) continue;
          for (const predecessor of d.prev) {
            if (covered.has(predecessor)) continue;
            covered.add(predecessor);
            visit.push(predecessor);
          }
        }
        const remaining = newer.filter((p) => !covered.has(p.delta.stream));
        const ordered: DeviceDelta[] = [];
        while (remaining.length) {
          const i = remaining.findIndex((p) => compatible(p.delta, seen));
          if (i < 0) return false;
          const d = remaining.splice(i, 1)[0].delta;
          ordered.push(d);
          seen.push(d.stream);
        }
        const keys = new Map(
          snapshot.devices.filter((d) => d.key !== null).map((
            d,
          ) => [d.id, d.key!]),
        );
        for (const d of ordered) {
          if (d.deleted || d.key === null) keys.delete(d.id);
          else keys.set(d.id, d.key);
        }
        limitEntries(keys.size + Object.keys(signing).length, limits.maxkeys);
        bounded(
          { devices: Object.fromEntries(keys), signing },
          limits.maxrequestbytes,
        );
        const previous = new Map<string, Json>((await tx.query(
          'SELECT device_id,key_json FROM remote_device_keys WHERE user_id=?',
          [cut.user],
        )).map((r) => [String(r.device_id), JSON.parse(String(r.key_json))]));
        const signingChanged = await writeSigning(tx, cut.user, signing);
        const changed = signingChanged ||
          canonicalJson(Object.fromEntries(previous)) !==
            canonicalJson(Object.fromEntries(keys));
        for (const id of previous.keys()) {
          if (keys.has(id)) continue;
          await tx.execute(
            'DELETE FROM remote_device_keys WHERE user_id=? AND device_id=?',
            [cut.user, id],
          );
        }
        for (const [id, key] of keys) {
          await writeDeviceKey(tx, cut.user, id, key, previous.get(id));
        }
        s.anchor = seen.at(-1)!;
        s.stale = false;
        s.pending = [];
        s.seen = seen.slice(-limits.maxkeys);
        await writeState(tx, cut.user, s);
        await tx.execute(
          'DELETE FROM device_recovery_requests WHERE user_id=?',
          [
            cut.user,
          ],
        );
        await tx.execute(
          'UPDATE remote_device_users SET retry_at=0,failures=0 WHERE user_id=? AND (retry_at!=0 OR failures!=0)',
          [cut.user],
        );
        if (changed) await notify(tx, cut.user);
        return true;
      }),
  );
}

/** Device completeness is required before any snapshot signing view is served. */
export async function cachedKeyQuery(
  db: Database,
  user: string,
  ids: string[],
  requester: string,
): Promise<Json | null> {
  return await db.tx(async (tx) => {
    const s = await state(tx, user);
    if (s === null || s.stale) return null;
    const keys = await deviceKeys(tx, user, ids, requester);
    const signing = await signingState(tx, user);
    return {
      device_keys: { [user]: keys },
      ...signingViews(signing.keys, user, requester),
    };
  });
}

async function deviceKeys(
  tx: Conn,
  user: string,
  ids: string[],
  requester: string,
): Promise<Json> {
  const keys: Json = Object.create(null);
  for (
    const row of await tx.query(
      'SELECT device_id,key_json FROM remote_device_keys WHERE user_id=? ORDER BY device_id',
      [user],
    )
  ) {
    const id = String(row.device_id);
    if (!ids.length || ids.includes(id)) {
      keys[id] = keyView(JSON.parse(String(row.key_json)), user, requester);
    }
  }
  return keys;
}

/** Only complete stream-anchored state can answer a client query. */
export async function cachedDeviceKeys(
  db: Database,
  user: string,
  ids: string[],
  requester: string,
): Promise<Json | null> {
  return await db.tx(async (tx) => {
    const s = await state(tx, user);
    if (s === null || s.stale) return null;
    return await deviceKeys(tx, user, ids, requester);
  });
}
