// Server-owned learned state. Network recovery never holds a storage transaction.
import type { Conn, Database } from '#engine/store/db.ts';
import type { DeviceDelta, DeviceSnapshot } from '#engine/e2ee-remote.ts';
import {
  bounded,
  type Json,
  type KeyLimits,
  limitEntries,
} from '#engine/tenant/e2ee.ts';
import {
  nextDeviceSeq,
  publishDeviceChange,
} from '#engine/server/device-notices.ts';
import { eventStreamTx } from '#engine/server/stream.ts';
import { keyView } from '#engine/e2ee-key-view.ts';

type Pending = { revision: number; delta: DeviceDelta };
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
async function apply(tx: Conn, d: DeviceDelta): Promise<void> {
  if (d.deleted || d.key === null) {
    await tx.execute(
      'DELETE FROM remote_device_keys WHERE user_id=? AND device_id=?',
      [d.user, d.id],
    );
  } else {
    await tx.execute(
      'INSERT INTO remote_device_keys VALUES(?,?,?) ON CONFLICT(user_id,device_id) DO UPDATE SET key_json=excluded.key_json',
      [d.user, d.id, JSON.stringify(d.key)],
    );
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
      await apply(tx, d);
      const keys = await tx.query(
        'SELECT key_json FROM remote_device_keys WHERE user_id=?',
        [d.user],
      );
      // Cache overflow is invalidation, never a truncated authoritative list.
      try {
        limitEntries(keys.length, limits.maxkeys);
        bounded(
          keys.map((r) => JSON.parse(String(r.key_json))),
          limits.maxrequestbytes,
        );
        s.anchor = d.stream;
        s.seen = [...s.seen, d.stream].slice(-limits.maxkeys);
      } catch {
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
      } catch {
        // Losing cache hints is safe only with a durable invalidation. Revision
        // still rejects an older in-flight snapshot which cannot replay them.
        s.pending = [];
      }
    }
    await writeState(tx, d.user, s);
    await notify(tx, d.user);
  });
}

export type RecoveryCut = { user: string; revision: number };
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
    return s?.stale ? { user, revision: s.revision } : null;
  });
}

/** Commit an authoritative cut, replaying only causally linked concurrent deltas. */
export async function installDeviceSnapshot(
  db: Database,
  cut: RecoveryCut,
  snapshot: DeviceSnapshot,
  limits: KeyLimits,
): Promise<boolean> {
  return await eventStreamTx(db, async (tx) => {
    const s = await state(tx, cut.user);
    if (!s?.stale || snapshot.user !== cut.user) return false;
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
      snapshot.devices.filter((d) => d.key !== null).map((d) => [d.id, d.key!]),
    );
    for (const d of ordered) {
      if (d.deleted || d.key === null) keys.delete(d.id);
      else keys.set(d.id, d.key);
    }
    limitEntries(keys.size, limits.maxkeys);
    bounded(Object.fromEntries(keys), limits.maxrequestbytes);
    await tx.execute('DELETE FROM remote_device_keys WHERE user_id=?', [
      cut.user,
    ]);
    for (const [id, key] of keys) {
      await tx.execute('INSERT INTO remote_device_keys VALUES(?,?,?)', [
        cut.user,
        id,
        JSON.stringify(key),
      ]);
    }
    s.anchor = seen.at(-1)!;
    s.stale = false;
    s.pending = [];
    s.seen = seen.slice(-limits.maxkeys);
    await writeState(tx, cut.user, s);
    await tx.execute('DELETE FROM device_recovery_requests WHERE user_id=?', [
      cut.user,
    ]);
    await tx.execute(
      'UPDATE remote_device_users SET retry_at=0,failures=0 WHERE user_id=?',
      [cut.user],
    );
    await notify(tx, cut.user);
    return true;
  });
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
  });
}
