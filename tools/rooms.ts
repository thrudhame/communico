// tools/rooms.ts — the room admin plane (ruling §9-10 + 2026-09-27):
//   list [--purgeable] | purge [--older-than <ms>] | drop <roomId>
// Purgatory is a LIST, not a state machine: rooms with purgeable_ms set
// are the rooms OFFERED to the operator — `purge` acts on that list and
// nothing else (a room not on the list is never offered, which is the
// whole safety). The purge first settles the room's outbox rows
// (delivery obligations, not room contents: pruned with a `refused`
// pending entry per destination), then drops the room database and the
// server-DB rows. `drop` removes ANY room, occupied or not, no ceremony.
import { ident, serverDb, withDb } from '#engine/db.ts';
import { recordRefusal } from '#engine/federation/outbox.ts';

function usage(): never {
  console.error(
    'usage: deno task rooms -- list [--purgeable] | purge [--older-than <ms>] | drop <roomId>',
  );
  Deno.exit(2);
}

type RoomRow = {
  room_id: string;
  room_version: string;
  current_chapter: string | null;
  purgeable_ms: number | null;
};

async function listRooms(purgeableOnly: boolean): Promise<RoomRow[]> {
  return await withDb(serverDb(), async (c) => {
    const r = purgeableOnly
      ? await c.query(
        'SELECT room_id, room_version, current_chapter, purgeable_ms FROM room_directory WHERE purgeable_ms IS NOT NULL ORDER BY purgeable_ms;',
      )
      : await c.query(
        'SELECT room_id, room_version, current_chapter, purgeable_ms FROM room_directory ORDER BY room_id;',
      );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => ({
      room_id: String(row.room_id),
      room_version: String(row.room_version),
      current_chapter: row.current_chapter == null
        ? null
        : String(row.current_chapter),
      purgeable_ms: row.purgeable_ms == null ? null : Number(row.purgeable_ms),
    }));
  });
}

async function dbNameOf(roomId: string): Promise<string | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT db_name FROM room_directory WHERE room_id = $1;',
      [roomId],
    );
    return r.rows.length === 0 ? null : String(r.rows[0].db_name);
  });
}

// Settle the room's delivery obligations: its outbox rows leave with a
// `refused` record per destination (the admin was told).
async function settleOutbox(roomId: string, why: string): Promise<number> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT destination, count(*) AS n FROM federation_outbox WHERE room_id = $1 GROUP BY destination;',
      [roomId],
    );
    let total = 0;
    // deno-lint-ignore no-explicit-any
    for (const row of r.rows as any[]) {
      const destination = String(row.destination);
      const n = Number(row.n);
      total += n;
      await c.query(
        'DELETE FROM federation_outbox WHERE room_id = $1 AND destination = $2;',
        [roomId, destination],
      );
      await recordRefusal(destination, {
        code: null,
        errcode: null,
        error: why,
        txnId: null,
      }, n);
    }
    return total;
  });
}

async function deleteServerRows(roomId: string): Promise<void> {
  await withDb(serverDb(), async (c) => {
    for (
      const table of [
        'event_index',
        'event_index_waiting',
        'room_membership',
        'room_aliases',
        'room_visibility',
        'relations',
        'search_index',
        'room_directory',
      ]
    ) {
      await c.query(`DELETE FROM ${ident(table)} WHERE room_id = $1;`, [
        roomId,
      ]);
    }
  });
}

const [cmd, ...rest] = Deno.args;

if (cmd === 'list') {
  const purgeableOnly = rest.includes('--purgeable');
  const rooms = await listRooms(purgeableOnly);
  if (rooms.length === 0) {
    console.log(purgeableOnly ? 'no rooms offered for purge' : 'no rooms');
  }
  for (const r of rooms) {
    console.log(
      `${r.room_id} (v${r.room_version}) ` +
        (r.current_chapter === null ? 'archived' : r.current_chapter) +
        (r.purgeable_ms !== null
          ? ` — purgeable since ${new Date(r.purgeable_ms).toISOString()}`
          : ''),
    );
  }
} else if (cmd === 'purge') {
  const olderThanIdx = rest.indexOf('--older-than');
  const olderThanMs = olderThanIdx >= 0 ? Number(rest[olderThanIdx + 1]) : null;
  if (olderThanIdx >= 0 && !Number.isFinite(olderThanMs)) usage();
  // the offered list ONLY — purgatory is a list, not a state machine
  const offered = (await listRooms(true)).filter((r) =>
    olderThanMs === null || (r.purgeable_ms ?? 0) <= Date.now() - olderThanMs
  );
  if (offered.length === 0) {
    console.log('no rooms offered for purge');
  }
  for (const r of offered) {
    const settled = await settleOutbox(r.room_id, `room ${r.room_id} purged`);
    const dbName = await dbNameOf(r.room_id);
    if (dbName !== null) {
      await withDb(serverDb(), async (c) => {
        await c.query(`DROP DATABASE ${ident(dbName)};`);
      });
    }
    await deleteServerRows(r.room_id);
    console.log(
      `purged ${r.room_id} (database dropped, ${settled} outbox row(s) settled)`,
    );
  }
} else if (cmd === 'drop' && rest.length === 1) {
  const roomId = rest[0];
  const settled = await settleOutbox(
    roomId,
    `room ${roomId} dropped by the operator`,
  );
  const dbName = await dbNameOf(roomId);
  if (dbName !== null) {
    await withDb(serverDb(), async (c) => {
      await c.query(`DROP DATABASE ${ident(dbName)};`);
    });
  }
  await deleteServerRows(roomId);
  console.log(
    `dropped ${roomId} (database dropped, ${settled} outbox row(s) settled)`,
  );
} else {
  usage();
}
