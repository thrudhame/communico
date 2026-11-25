// The server file owns directory order and cardinality, not room metadata.
// Maintenance runs with the source writes; replaying unchanged facts is inert.
import type { Conn, Database } from '#engine/store/db.ts';

const roomOrder = new Intl.Collator();
const orderVersion =
  `${Deno.version.deno}:${roomOrder.resolvedOptions().locale}`;
const maxKey = (1n << 128n) - 1n;
const encodeOrder = (key: bigint) => key.toString(16).padStart(32, '0');
const decodeOrder = (key: string) => BigInt('0x' + key);
const firstKey = encodeOrder(0n), lastKey = encodeOrder(maxKey);

export const DIRECTORY_RANK_SQL = `
CREATE TABLE directory_rank_state(
  id INTEGER PRIMARY KEY CHECK(id=1),
  version TEXT NOT NULL,
  after_room TEXT,
  complete INTEGER NOT NULL,
  total INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE directory_rank(
  room_id TEXT PRIMARY KEY NOT NULL,
  order_key TEXT NOT NULL,
  joined_members INTEGER NOT NULL,
  listed INTEGER NOT NULL
);
CREATE INDEX directory_rank_order ON directory_rank(order_key);
CREATE INDEX directory_rank_page ON directory_rank(listed,joined_members DESC,order_key,room_id);
CREATE TABLE directory_rank_replica(
  pairing TEXT PRIMARY KEY NOT NULL,
  source_cut INTEGER NOT NULL,
  public_rooms INTEGER NOT NULL
);

CREATE TRIGGER directory_rank_insert AFTER INSERT ON directory_rank BEGIN
  UPDATE directory_rank_state SET total=total+1 WHERE id=1 AND NEW.listed=1;
END;
CREATE TRIGGER directory_rank_delete AFTER DELETE ON directory_rank BEGIN
  UPDATE directory_rank_state SET total=total-1 WHERE id=1 AND OLD.listed=1;
END;
CREATE TRIGGER directory_rank_listing AFTER UPDATE OF listed ON directory_rank BEGIN
  UPDATE directory_rank_state SET total=total+NEW.listed-OLD.listed WHERE id=1 AND NEW.listed!=OLD.listed;
END;

CREATE TRIGGER directory_rank_join AFTER INSERT ON memberships WHEN NEW.membership='join' BEGIN
  UPDATE directory_rank SET joined_members=joined_members+1 WHERE room_id=NEW.room;
END;
CREATE TRIGGER directory_rank_depart AFTER DELETE ON memberships WHEN OLD.membership='join' BEGIN
  UPDATE directory_rank SET joined_members=joined_members-1 WHERE room_id=OLD.room;
END;
CREATE TRIGGER directory_rank_membership AFTER UPDATE OF membership ON memberships
WHEN (OLD.membership='join') != (NEW.membership='join') BEGIN
  UPDATE directory_rank SET joined_members=joined_members+CASE WHEN NEW.membership='join' THEN 1 ELSE -1 END WHERE room_id=NEW.room;
END;

CREATE TRIGGER directory_rank_purge_insert AFTER INSERT ON directory WHEN NEW.purgeable_ms IS NOT NULL BEGIN
  UPDATE directory_rank SET listed=0 WHERE room_id=NEW.room_id AND listed=1;
END;
CREATE TRIGGER directory_rank_purge_update AFTER UPDATE OF purgeable_ms ON directory
WHEN (OLD.purgeable_ms IS NULL) != (NEW.purgeable_ms IS NULL) BEGIN
  UPDATE directory_rank SET listed=CASE WHEN NEW.purgeable_ms IS NULL THEN 1 ELSE 0 END WHERE room_id=NEW.room_id;
END;
CREATE TRIGGER directory_rank_purge_delete AFTER DELETE ON directory WHEN OLD.purgeable_ms IS NOT NULL BEGIN
  UPDATE directory_rank SET listed=1 WHERE room_id=OLD.room_id AND listed=0;
END;
CREATE TRIGGER directory_rank_unpublish AFTER UPDATE OF visibility ON visibility WHEN NEW.visibility!='public' BEGIN
  DELETE FROM directory_rank WHERE room_id=NEW.room_id;
END;
CREATE TRIGGER directory_rank_remove AFTER DELETE ON visibility BEGIN
  DELETE FROM directory_rank WHERE room_id=OLD.room_id;
END;
`;

export async function initDirectoryRankState(
  db: Pick<Conn, 'execute'>,
  fresh: boolean,
) {
  await db.execute(
    'INSERT INTO directory_rank_state(id,version,complete) VALUES(1,?,?)',
    [orderVersion, fresh ? 1 : 0],
  );
}

function compareRoomIds(a: string, b: string): number {
  const result = roomOrder.compare(a, b);
  if (result || a === b) return result;
  // The old stable sort kept the initial SQL BINARY ordering among ICU ties.
  const utf8 = new TextEncoder();
  const aa = utf8.encode(a), bb = utf8.encode(b);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  }
  return aa.length - bb.length;
}

async function insertRank(tx: Conn, roomId: string) {
  if (
    (await tx.query('SELECT 1 FROM directory_rank WHERE room_id=?', [roomId]))
      .length
  ) return;
  // Probe the label space, not row offsets: each seek reads at most one index
  // entry. Two entries straddling the probe are actual adjacent labels, so
  // comparing their IDs either finds the insertion gap or narrows the search.
  let lo = firstKey, hi = lastKey;
  while (true) {
    const pivot = between(lo, hi);
    const [right] = await tx.query(
      'SELECT room_id,order_key FROM directory_rank WHERE order_key>=? ORDER BY order_key LIMIT 1',
      [pivot],
    );
    if (right && compareRoomIds(String(right.room_id), roomId) < 0) {
      lo = String(right.order_key);
      continue;
    }
    const [left] = await tx.query(
      'SELECT room_id,order_key FROM directory_rank WHERE order_key<? ORDER BY order_key DESC LIMIT 1',
      [right?.order_key ?? pivot],
    );
    if (left && compareRoomIds(String(left.room_id), roomId) > 0) {
      hi = String(left.order_key);
      continue;
    }
    await insertRankAt(
      tx,
      roomId,
      between(
        String(left?.order_key ?? firstKey),
        String(right?.order_key ?? lastKey),
      ),
    );
    return;
  }
}

/** Hex fractions sort lexically. Keep the 32-digit backfill labels intact;
 * live inserts extend precision in a crowded gap instead of relabeling rooms.
 * Trim only extra trailing zeroes so a value has exactly one encoding. */
function between(left: string, right: string): string {
  let width = Math.max(left.length, right.length);
  let lo = decodeOrder(left.padEnd(width, '0'));
  let hi = decodeOrder(right.padEnd(width, '0'));
  if (hi - lo === 1n) {
    width++;
    lo <<= 4n;
    hi <<= 4n;
  }
  const key = ((lo + hi) / 2n).toString(16).padStart(width, '0');
  return key.slice(0, 32) + key.slice(32).replace(/0+$/, '');
}

function insertRankAt(tx: Conn, id: string, key: string) {
  return tx.execute(
    `INSERT INTO directory_rank(room_id,order_key,joined_members,listed)
     SELECT ?,?,(SELECT COUNT(*) FROM memberships WHERE room=? AND membership='join'),
       CASE WHEN EXISTS(SELECT 1 FROM directory WHERE room_id=? AND purgeable_ms IS NOT NULL) THEN 0 ELSE 1 END
     WHERE EXISTS(SELECT 1 FROM visibility WHERE room_id=? AND visibility='public')
     ON CONFLICT(room_id) DO NOTHING`,
    [id, key, id, id, id],
  );
}

// Visibility is authored here (including by the semantic replica installer).
// The rank must be present by the time a public visibility write commits.
export async function setRankedVisibility(
  tx: Conn,
  roomId: string,
  visibility: string,
) {
  await tx.execute(
    `INSERT INTO visibility(room_id,visibility) VALUES(?,?)
     ON CONFLICT(room_id) DO UPDATE SET visibility=excluded.visibility WHERE visibility.visibility!=excluded.visibility`,
    [roomId, visibility],
  );
  if (visibility === 'public') {
    const [state] = await tx.query(
      'SELECT complete FROM directory_rank_state WHERE id=1',
    );
    if (state.complete === 1) await insertRank(tx, roomId);
  }
}

type RankPlan = { id: string; key: string }[];

/** Only one inventory read per uninterrupted backfill. Each durable commit
 * advances the existing BINARY room cursor with at most 64 indexed writes. */
export async function* backfillDirectoryRanks(db: Database) {
  while (true) {
    const planned = await db.tx(async (tx) => {
      const [state] = await tx.query(
        'SELECT version,after_room,complete FROM directory_rank_state WHERE id=1',
      );
      let after = state.after_room as string | null;
      if (state.version !== orderVersion) {
        // Restored data may have come from a runtime with a different collation.
        await tx.execute('DELETE FROM directory_rank');
        await tx.execute(
          'UPDATE directory_rank_state SET version=?,after_room=NULL,complete=0 WHERE id=1',
          [orderVersion],
        );
        after = null;
      } else if (state.complete === 1) return null;
      const rows = (await tx.query(
        "SELECT v.room_id,r.order_key,v.room_id>? AS remaining FROM visibility v LEFT JOIN directory_rank r ON r.room_id=v.room_id WHERE v.visibility='public' ORDER BY v.room_id",
        [after ?? ''],
      )).map((row) => ({
        id: String(row.room_id),
        key: row.order_key as string | null,
        remaining: row.remaining === 1,
      }));
      const restart = after !== null &&
        rows.some((row) => !row.remaining && row.key === null);
      const ordered = rows.slice().sort((a, b) => compareRoomIds(a.id, b.id));
      let first = 0, left = 0n;
      for (let i = 0; i <= ordered.length; i++) {
        const anchor = ordered[i]?.key;
        if (anchor === null) continue;
        const right = anchor === undefined ? maxKey : decodeOrder(anchor);
        const step = (right - left) / BigInt(i - first + 1);
        if (step === 0n) {
          // A previous runtime or insertion history may leave a tight gap.
          // Re-space existing labels once, not once per inserted room.
          const spacing = maxKey / BigInt(ordered.length + 1);
          for (const [j, row] of ordered.entries()) {
            const key = encodeOrder(BigInt(j + 1) * spacing);
            if (row.key !== null) {
              await tx.execute(
                'UPDATE directory_rank SET order_key=? WHERE room_id=?',
                [key, row.id],
              );
            }
            row.key = key;
          }
          break;
        }
        for (let j = first; j < i; j++) {
          ordered[j].key = encodeOrder(left + BigInt(j - first + 1) * step);
        }
        left = right;
        first = i + 1;
      }
      // A visibility write during startup may add a room behind the cursor.
      // Revisit it with a fresh plan, keeping the same durable cursor format.
      if (restart) {
        await tx.execute(
          'UPDATE directory_rank_state SET after_room=NULL WHERE id=1',
        );
        after = null;
      }
      const plan: RankPlan = rows.filter((row) =>
        after === null || row.remaining
      ).map((row) => ({ id: row.id, key: row.key! }));
      return { after, plan };
    });
    if (planned === null) return;
    let after = planned.after;
    for (let i = 0;; i += 64) {
      const batch = planned.plan.slice(i, i + 64);
      const next = await db.tx(async (tx) => {
        const [state] = await tx.query(
          'SELECT after_room,complete,version FROM directory_rank_state WHERE id=1',
        );
        if (state.complete === 1) return 'done';
        if (state.after_room !== after || state.version !== orderVersion) {
          return 'replan';
        }
        for (const row of batch) await insertRankAt(tx, row.id, row.key);
        if (i + 64 >= planned.plan.length) {
          const missing = (await tx.query(
            "SELECT 1 FROM visibility v LEFT JOIN directory_rank r ON r.room_id=v.room_id WHERE v.visibility='public' AND r.room_id IS NULL LIMIT 1",
          )).length !== 0;
          await tx.execute(
            'UPDATE directory_rank_state SET after_room=?,complete=? WHERE id=1',
            [
              missing ? null : batch.at(-1)?.id ?? after,
              missing ? 0 : 1,
            ],
          );
          return missing ? 'replan' : 'done';
        }
        await tx.execute(
          'UPDATE directory_rank_state SET after_room=? WHERE id=1',
          [batch.at(-1)!.id],
        );
        return 'more';
      });
      if (next === 'done') return;
      if (next === 'replan') break;
      after = batch.at(-1)!.id;
      yield;
    }
  }
}

export function rankedDirectoryPage(
  db: Database,
  offset: number,
  limit: number,
) {
  return db.tx((tx) => rankedDirectoryPageAt(tx, offset, limit), {
    mode: 'deferred',
  });
}

export async function rankedDirectoryPageAt(
  tx: Conn,
  offset: number,
  limit: number,
) {
  const [state] = await tx.query(
    'SELECT complete,total FROM directory_rank_state WHERE id=1',
  );
  if (state.complete !== 1) {
    throw new Error('directory rank backfill incomplete');
  }
  const total = Number(state.total);
  const rows = offset >= total ? [] : await tx.query(
    'SELECT room_id,joined_members FROM directory_rank WHERE listed=1 ORDER BY joined_members DESC,order_key,room_id LIMIT ? OFFSET ?',
    [limit, offset],
  );
  return {
    total,
    rooms: rows.map((row) => ({
      id: String(row.room_id),
      joined: Number(row.joined_members),
    })),
  };
}

export type RankedDirectoryPage = Awaited<
  ReturnType<typeof rankedDirectoryPageAt>
>;
