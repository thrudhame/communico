import type { Conn, Database } from '#engine/store/db.ts';
import { nextDeviceSeq } from '#engine/server/device-notices.ts';
import { invalidateDeviceCache } from '#engine/server/remote-devices.ts';
export {
  nextDeviceSeq,
  publishDeviceChange,
} from '#engine/server/device-notices.ts';

export type TrackingScope = 'sync' | 'keys';
export type DeviceLists = { changed: string[]; left: string[] };

/** Reconcile one immutable publication, keeping both predicates and last-room loss together. */
export async function reconcileDeviceRoom(
  tx: Conn,
  room: string,
  members: string[],
  encrypted: boolean,
  encryptionEvent: string | null,
  position: number,
): Promise<void> {
  const priorRoom = (await tx.query(
    'SELECT encrypted,publication_pos FROM e2ee_rooms WHERE room=?',
    [room],
  ))[0];
  if (priorRoom && Number(priorRoom.publication_pos) >= position) return;
  const old =
    (await tx.query('SELECT user FROM e2ee_room_members WHERE room=?', [room]))
      .map((r) => String(r.user));
  const affected = [...new Set([...old, ...members])].sort();
  const oldSet = new Set(old);
  const newSet = new Set(members);
  const moved = affected.filter((user) =>
    oldSet.has(user) !== newSet.has(user)
  );
  const encryptionChanged =
    (Number(priorRoom?.encrypted ?? 0) === 1) !== encrypted;
  await tx.execute(
    'INSERT INTO e2ee_rooms VALUES(?,?,?,?) ON CONFLICT(room) DO UPDATE SET encrypted=excluded.encrypted,encryption_event=excluded.encryption_event,publication_pos=excluded.publication_pos',
    [room, encrypted ? 1 : 0, encryptionEvent, position],
  );
  for (const user of moved) {
    if (newSet.has(user)) {
      await tx.execute('INSERT INTO e2ee_room_members VALUES(?,?)', [
        room,
        user,
      ]);
    } else {
      await tx.execute(
        'DELETE FROM e2ee_room_members WHERE room=? AND user=?',
        [room, user],
      );
    }
  }
  for (const scope of ['sync', 'keys']) {
    // Only changed memberships affect all-room sharing; encryption changes
    // affect every pair in the encrypted scope. Avoid even enumerating the
    // unchanged cross product on ordinary room publications.
    const pivots = scope === 'sync' && encryptionChanged ? affected : moved;
    const pairs = new Map<string, Set<string>>();
    const add = (observer: string, subject: string) => {
      if (!pairs.has(observer)) pairs.set(observer, new Set());
      pairs.get(observer)!.add(subject);
    };
    for (const user of pivots) {
      for (const peer of affected) {
        if (user === peer) continue;
        add(user, peer);
        add(peer, user);
      }
    }
    for (const [observer, subjects] of pairs) {
      for (const subject of subjects) {
        const prior = await tx.query(
          'SELECT start_seq FROM device_tracking WHERE observer=? AND subject=? AND scope=? AND end_seq IS NULL',
          [observer, subject, scope],
        );
        const shared = await tx.query(
          `SELECT 1 FROM e2ee_room_members a JOIN e2ee_room_members b ON a.room=b.room JOIN e2ee_rooms r ON r.room=a.room WHERE a.user=? AND b.user=? ${
            scope === 'sync' ? 'AND r.encrypted=1' : ''
          } LIMIT 1`,
          [observer, subject],
        );
        if (Boolean(prior.length) === Boolean(shared.length)) continue;
        if (scope === 'keys') await invalidateDeviceCache(tx, subject);
        const seq = await nextDeviceSeq(tx);
        if (shared.length) {
          await tx.execute('INSERT INTO device_tracking VALUES(?,?,?,?,NULL)', [
            observer,
            subject,
            scope,
            seq,
          ]);
        } else {
          await tx.execute(
            'UPDATE device_tracking SET end_seq=? WHERE observer=? AND subject=? AND scope=? AND end_seq IS NULL',
            [seq, observer, subject, scope],
          );
        }
        await tx.execute('INSERT INTO device_notices VALUES(?,?,?,?,?)', [
          seq,
          observer,
          subject,
          scope,
          shared.length ? 'join' : 'leave',
        ]);
      }
    }
  }
}

/** Both consumers read the captured audience and relationship at their bounded end cut. */
export async function deviceListsBetween(
  server: Database,
  observer: string,
  from: number,
  to: number,
  scope: TrackingScope,
): Promise<DeviceLists> {
  return await server.tx(async (tx) => {
    const notices = await tx.query(
      'SELECT DISTINCT subject,kind FROM device_notices WHERE observer=? AND scope=? AND seq>? AND seq<=? ORDER BY subject',
      [observer, scope, from, to],
    );
    const result: DeviceLists = { changed: [], left: [] };
    const kinds = new Map<string, Set<string>>();
    for (const row of notices) {
      const subject = String(row.subject);
      if (!kinds.has(subject)) kinds.set(subject, new Set());
      kinds.get(subject)!.add(String(row.kind));
    }
    for (const [subject, reasons] of kinds) {
      const activeAt = async (predicate: TrackingScope) =>
        subject === observer ||
        (await tx.query(
            'SELECT 1 FROM device_tracking WHERE observer=? AND subject=? AND scope=? AND start_seq<=? AND (end_seq IS NULL OR end_seq>?) LIMIT 1',
            [observer, subject, predicate, to, to],
          )).length > 0;
      const active = await activeAt(scope);
      // Actual mutations have an all-room audience; tracking transitions use
      // the selected predicate. A plaintext peer must never invent a sync left.
      if (
        (reasons.has('join') && active) ||
        (reasons.has('change') && await activeAt('keys'))
      ) result.changed.push(subject);
      if (reasons.has('leave') && !active) result.left.push(subject);
    }
    return result;
  });
}

export async function deviceStreamMax(server: Database): Promise<number> {
  const rows = await server.query(
    "SELECT value FROM counters WHERE name='devices'",
  );
  return rows.length ? Number(rows[0].value) : 0;
}
