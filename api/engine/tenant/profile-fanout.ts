// The profile transaction owns durable desired membership and exact per-room
// submissions. Room ingestion remains the sole event writer. Revisions are
// local work identities, never replicated positions or register tie-breaks.
import type { Conn } from '#engine/store/db.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Profile } from '#engine/tenant/profiles.ts';
import { nextCounter } from '#engine/tenant/accountdata.ts';
import type { PreparedSubmission } from '#engine/room/ingest.ts';

export const PROFILE_FANOUT_SQL = `
CREATE TABLE profile_fanout(localpart TEXT PRIMARY KEY NOT NULL REFERENCES users(localpart),revision INTEGER NOT NULL,profile TEXT NOT NULL);
CREATE TABLE profile_fanout_rooms(localpart TEXT NOT NULL,revision INTEGER NOT NULL,room_id TEXT NOT NULL,event_id TEXT,pending_pdu TEXT,completed INTEGER NOT NULL DEFAULT 0,accepted INTEGER,PRIMARY KEY(localpart,revision,room_id));
`;

export type ProfileFanout = {
  localpart: string;
  revision: number;
  profile: { displayname?: string; avatar_url?: string };
};
export class SupersededProfile extends Error {}

function memberProfile(profile: Profile) {
  return {
    ...(profile.displayname === undefined
      ? {}
      : { displayname: profile.displayname }),
    ...(profile.avatar_url === undefined
      ? {}
      : { avatar_url: profile.avatar_url }),
  };
}

export async function recordProfileFanout(
  conn: Conn,
  localpart: string,
  previous: Profile,
  winner: Profile,
) {
  const profile = JSON.stringify(memberProfile(winner));
  if (profile === JSON.stringify(memberProfile(previous))) return;
  await conn.execute(
    'INSERT INTO profile_fanout(localpart,revision,profile) VALUES(?,?,?) ON CONFLICT(localpart) DO UPDATE SET revision=excluded.revision,profile=excluded.profile',
    [localpart, await nextCounter(conn, 'profile_fanout'), profile],
  );
}

export async function profileFanouts(
  conn: Conn,
  localpart?: string,
): Promise<ProfileFanout[]> {
  const rows = await conn.query(
    'SELECT f.* FROM profile_fanout f JOIN users u ON u.localpart=f.localpart WHERE u.deactivated=0' +
      (localpart === undefined ? '' : ' AND f.localpart=?') +
      ' ORDER BY f.localpart',
    localpart === undefined ? [] : [localpart],
  );
  return rows.map((row) => ({
    localpart: String(row.localpart),
    revision: Number(row.revision),
    profile: JSON.parse(String(row.profile)),
  }));
}

async function current(conn: Conn, work: ProfileFanout) {
  const [root] = await profileFanouts(conn, work.localpart);
  if (!root || root.revision !== work.revision) {
    throw new SupersededProfile('profile winner superseded');
  }
}

export async function discoverProfileRooms(
  conn: Conn,
  work: ProfileFanout,
  rooms: readonly string[],
) {
  await current(conn, work);
  for (const room of rooms) {
    await conn.execute(
      'INSERT INTO profile_fanout_rooms(localpart,revision,room_id) VALUES(?,?,?) ON CONFLICT DO NOTHING',
      [work.localpart, work.revision, room],
    );
  }
}

export async function profileRoomResults(conn: Conn, work: ProfileFanout) {
  await current(conn, work);
  const rows = await conn.query(
    'SELECT room_id,completed,accepted FROM profile_fanout_rooms WHERE localpart=? AND revision=? ORDER BY room_id',
    [work.localpart, work.revision],
  );
  return rows.map((row) => ({
    room: String(row.room_id),
    completed: row.completed === 1,
    accepted: row.accepted === null ? null : row.accepted === 1,
  }));
}

export async function profileSubmission(
  conn: Conn,
  work: ProfileFanout,
  room: string,
): Promise<PreparedSubmission | null> {
  await current(conn, work);
  const [row] = await conn.query(
    'SELECT event_id,pending_pdu FROM profile_fanout_rooms WHERE localpart=? AND revision=? AND room_id=?',
    [work.localpart, work.revision, room],
  );
  if (!row) throw new Error('profile room not discovered');
  return row.event_id === null ? null : {
    eventId: String(row.event_id),
    pdu: row.pending_pdu === null ? null : JSON.parse(String(row.pending_pdu)),
  };
}

export async function prepareProfileSubmission(
  conn: Conn,
  work: ProfileFanout,
  room: string,
  pdu: Pdu,
): Promise<PreparedSubmission> {
  if (!pdu.event_id) throw new Error('profile submission has no event id');
  const saved = await profileSubmission(conn, work, room);
  if (saved) return saved;
  await conn.execute(
    'UPDATE profile_fanout_rooms SET event_id=?,pending_pdu=? WHERE localpart=? AND revision=? AND room_id=?',
    [pdu.event_id, JSON.stringify(pdu), work.localpart, work.revision, room],
  );
  return { eventId: pdu.event_id!, pdu };
}

export async function finishProfileSubmission(
  conn: Conn,
  work: ProfileFanout,
  room: string,
  eventId: string | null,
  accepted: boolean | null,
) {
  // Retain an in-flight result even when a newer profile committed meanwhile.
  // It cannot complete the successor, whose revision has independent room work.
  await conn.execute(
    'UPDATE profile_fanout_rooms SET event_id=COALESCE(event_id,?),completed=1,accepted=? WHERE localpart=? AND revision=? AND room_id=?',
    [
      eventId,
      accepted === null ? null : accepted ? 1 : 0,
      work.localpart,
      work.revision,
      room,
    ],
  );
}
