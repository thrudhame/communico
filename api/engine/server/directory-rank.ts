// The server file owns directory order and cardinality, not room metadata.
// Maintenance runs with the source writes; replaying unchanged facts is inert.
import type { Conn, Database } from '#engine/store/db.ts';

const roomOrder = new Intl.Collator();
const orderVersion =
  `${Deno.version.deno}:${roomOrder.resolvedOptions().locale}`;
const maxKey = (1n << 128n) - 1n;
const encodeOrder = (key: bigint) => key.toString(16).padStart(32, '0');
const decodeOrder = (key: string) => BigInt('0x' + key);

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
  // Allocate a durable label under the writer transaction. Never sort room IDs
  // or rebuild ranks on the read path. Membership changes leave labels alone.
  const ranks = await tx.query(
    'SELECT room_id,order_key FROM directory_rank ORDER BY order_key',
  );
  let lo = 0, hi = ranks.length;
  while (lo < hi) {
    const middle = (lo + hi) >>> 1;
    if (compareRoomIds(String(ranks[middle].room_id), roomId) < 0) {
      lo = middle + 1;
    } else hi = middle;
  }
  let left = lo === 0 ? 0n : decodeOrder(String(ranks[lo - 1].order_key));
  let right = lo === ranks.length
    ? maxKey
    : decodeOrder(String(ranks[lo].order_key));
  if (right - left <= 1n) {
    const step = maxKey / BigInt(ranks.length + 2);
    for (const [i, row] of ranks.entries()) {
      await tx.execute(
        'UPDATE directory_rank SET order_key=? WHERE room_id=?',
        [
          encodeOrder(BigInt(i + 1) * step),
          String(row.room_id),
        ],
      );
    }
    left = BigInt(lo) * step;
    right = left + step;
  }
  await tx.execute(
    `INSERT INTO directory_rank(room_id,order_key,joined_members,listed)
     SELECT ?,?,(SELECT COUNT(*) FROM memberships WHERE room=? AND membership='join'),
       CASE WHEN EXISTS(SELECT 1 FROM directory WHERE room_id=? AND purgeable_ms IS NOT NULL) THEN 0 ELSE 1 END`,
    [roomId, encodeOrder((left + right) / 2n), roomId, roomId],
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
  if (visibility === 'public') await insertRank(tx, roomId);
}

/** One committed upgrade batch; room and cursor move together. */
export function backfillDirectoryRanks(db: Database): Promise<boolean> {
  return db.tx(async (tx) => {
    const [state] = await tx.query(
      'SELECT version,after_room,complete FROM directory_rank_state WHERE id=1',
    );
    let after = state.after_room;
    if (state.version !== orderVersion) {
      // Restored data may have come from a runtime with a different collation.
      await tx.execute('DELETE FROM directory_rank');
      await tx.execute(
        'UPDATE directory_rank_state SET version=?,after_room=NULL,complete=0 WHERE id=1',
        [orderVersion],
      );
      after = null;
    } else if (state.complete === 1) return true;
    const rows = await tx.query(
      "SELECT room_id FROM visibility WHERE visibility='public' AND room_id>? ORDER BY room_id LIMIT 64",
      [after ?? ''],
    );
    for (const row of rows) await insertRank(tx, String(row.room_id));
    await tx.execute(
      'UPDATE directory_rank_state SET after_room=?,complete=? WHERE id=1',
      [
        rows.at(-1)?.room_id ?? after,
        rows.length < 64 ? 1 : 0,
      ],
    );
    return rows.length < 64;
  });
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
