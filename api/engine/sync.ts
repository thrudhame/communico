// Phase 3 — pull-based sync ("federation is a repo pull").
// Discovered Doltgres behavior this module relies on (recorded in
// RESULTS.md):
// - `dolt.remote_branches` lists remote-tracking refs as
//   `remotes/origin/<branch>` (clone populates them; DOLT_FETCH refreshes).
// - `DOLT_BRANCH('<b>', 'origin/<b>')` creates a local branch from a
//   remote-tracking ref; `DOLT_CHECKOUT('<b>')` also resolves it.
// - `dolt.branches` only ever lists LOCAL branches; DOLT_BRANCH('-r'/'-a')
//   are invalid, and DOLT_BRANCH('--remotes') creates a stray branch
//   named 's' (flag-parse quirk — avoided).
import { ident, SERVER_DB, withDb } from './db.ts';
import { dbNameFor, lookupRoom } from './room.ts';

const REMOTE_DIR = '/tmp/communico-remotes';

export async function pushRoom(roomId: string): Promise<void> {
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  // NOTE (recorded in RESULTS.md): the phase text says to Deno.mkdir the
  // remote parent dir; DOLT_PUSH creates the file-remote directory tree
  // itself (verified), and the sanctioned server permissions
  // (--allow-net --allow-env --allow-read) do not include write — so no
  // mkdir call is made here.
  const url = `file://${REMOTE_DIR}/${room.dbName}`;
  await withDb(room.dbName, async (c) => {
    try {
      await c.query(`SELECT DOLT_REMOTE('add', 'origin', '${url}');`);
    } catch (e) {
      // ignore "already exists" errors (recorded: message contains
      // 'origin' + 'exists' — anything else is rethrown)
      if (!/exists/i.test(String(e))) throw e;
    }
    await c.query(`SELECT DOLT_PUSH('origin', 'main');`);
    const xb = await c.query(
      `SELECT name FROM dolt.branches WHERE name LIKE 'x%';`,
    );
    // deno-lint-ignore no-explicit-any
    for (const row of xb.rows as any[]) {
      await c.query(
        `SELECT DOLT_PUSH('origin', '${ident(String(row.name))}');`,
      );
    }
  });
}

export async function pullRoom(
  roomId: string,
  remoteUrl: string,
  createIfMissing: boolean,
): Promise<number> {
  const existing = await lookupRoom(roomId);
  let dbName: string;
  if (!existing) {
    if (!createIfMissing) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
    dbName = await dbNameFor(roomId);
    await withDb(SERVER_DB, async (c) => {
      await c.query(`SELECT DOLT_CLONE($1, $2);`, [remoteUrl, dbName]);
      await c.query(
        'INSERT INTO room_directory (room_id, db_name, room_version) VALUES ($1, $2, $3);',
        [roomId, dbName, 'test.communico.dolt.v1'],
      );
    });
  } else {
    dbName = existing.dbName;
  }

  // fetch/update local x* branches from origin's remote-tracking refs
  await withDb(dbName, async (c) => {
    // D6: DOLT_PULL may merge — hold conflict state in-session if so
    await c.query('SET dolt_allow_commit_conflicts = 1;');
    if (existing) {
      await c.query(`SELECT DOLT_CHECKOUT('main');`);
      await c.query(`SELECT DOLT_PULL('origin');`);
    }
    await c.query(`SELECT DOLT_FETCH();`);
    const rb = await c.query(
      `SELECT name FROM dolt.remote_branches WHERE name LIKE 'remotes/origin/x%';`,
    );
    // deno-lint-ignore no-explicit-any
    for (const row of rb.rows as any[]) {
      const short = String(row.name).slice('remotes/origin/'.length);
      try {
        await c.query(`SELECT DOLT_BRANCH('-D', '${ident(short)}');`);
      } catch {
        // branch did not exist locally — fine
      }
      await c.query(
        `SELECT DOLT_BRANCH('${ident(short)}', 'origin/${ident(short)}');`,
      );
    }
  });

  // rebuild event_index for the room: walk main + every x* branch's log
  // (event commits live on the x* extremity branches — D8; main only ever
  // holds genesis commits), upsert '$'+commit_hash rows, then mark tips
  let newCommits = 0;
  await withDb(dbName, async (c) => {
    const branches = (await c.query(`SELECT name FROM dolt.branches;`))
      // deno-lint-ignore no-explicit-any
      .rows.map((r: any) => String(r.name));
    const seen = new Map<string, string>();
    for (const b of branches) {
      const log = await c.query(
        `SELECT commit_hash, message FROM dolt_log('${ident(b)}');`,
      );
      // deno-lint-ignore no-explicit-any
      for (const row of log.rows as any[]) {
        const h = String(row.commit_hash);
        if (!seen.has(h)) seen.set(h, String(row.message));
      }
    }
    const eventCommits = [...seen.keys()].filter((h) =>
      seen.get(h)!.startsWith('event ')
    );
    await withDb(SERVER_DB, async (s) => {
      for (const hash of eventCommits) {
        // NOTE: Doltgres runs INSERT ... RETURNING but returns an empty
        // rows array (RETURNING not honored) — count via rowCount, which
        // is correct for ON CONFLICT DO NOTHING (1 inserted / 0 skipped).
        const r = await s.query(
          `INSERT INTO event_index (event_id, room_id, commit_hash, branch_name)
           VALUES ($1, $2, $3, NULL) ON CONFLICT (event_id) DO NOTHING;`,
          ['$' + hash, roomId, hash],
        );
        newCommits += r.rowCount ?? 0;
      }
      // interior commits get NULL; tips are set below
      await s.query(
        'UPDATE event_index SET branch_name = NULL WHERE room_id = $1;',
        [roomId],
      );
    });
    const tips: { b: string; h: string }[] = [];
    for (const b of branches.filter((n: string) => n.startsWith('x'))) {
      const h = await c.query(`SELECT (SELECT HASHOF('${ident(b)}')) AS h;`);
      tips.push({ b, h: String(h.rows[0].h) });
    }
    await withDb(SERVER_DB, async (s) => {
      for (const t of tips) {
        await s.query(
          'UPDATE event_index SET branch_name = $1 WHERE room_id = $2 AND commit_hash = $3;',
          [t.b, roomId, t.h],
        );
      }
    });
  });
  return newCommits;
}
