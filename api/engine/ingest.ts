import { branchNameFor, ident, SERVER_DB, withDb } from './db.ts';
import { lookupRoom } from './room.ts';
import { mergeDriver } from './mergedriver.ts';
import { eventIdFor } from './eventid.ts';

export interface IncomingEvent {
  type: string;
  state_key?: string;
  sender: string;
  content: unknown;
  prev_events: string[]; // event IDs; length 0 (genesis) 1 or 2 (D1)
  origin_ts: number;
}

export interface IngestResult {
  event_id: string;
  commit_hash: string;
}

export interface IngestOptions {
  // TEST HOOK ONLY (phase-2 fork test): skip deleting consumed prev
  // branches in step 8 so a second event can reference the same prev.
  keepPrevBranches?: boolean;
}

export async function ingestEvent(
  roomId: string,
  ev: IncomingEvent,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  // 1. D1: at most 2 prev_events
  if (ev.prev_events.length > 2) {
    throw new Error(
      'M_TOO_MANY_PREV_EVENTS: prototype supports at most 2 (D1)',
    );
  }

  // 2. resolve room
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);

  // 3. event ID + stored PDU
  //    Mode A (any other room_version): real Matrix reference hash over the
  //    redacted PDU (Phase 2). Mode B: provisional placeholder (Phase 3
  //    replaces the wire ID with the commit hash; branches are named from
  //    the provisional ID — D8, since the wire ID doesn't exist pre-commit).
  let eventId: string;
  let pdu: Record<string, unknown>;
  if (room.roomVersion === 'test.communico.dolt.v1') {
    eventId = '$' + crypto.randomUUID();
    pdu = {
      event_id: eventId,
      room_id: roomId,
      type: ev.type,
      sender: ev.sender,
      content: ev.content,
      prev_events: ev.prev_events,
      origin_ts: ev.origin_ts,
    };
    if (ev.state_key != null) pdu.state_key = ev.state_key;
  } else {
    const unsigned: Record<string, unknown> = {
      type: ev.type,
      room_id: roomId,
      sender: ev.sender,
      content: ev.content,
      prev_events: ev.prev_events,
      origin_server_ts: ev.origin_ts,
      depth: 0,
    };
    if (ev.state_key != null) unsigned.state_key = ev.state_key;
    eventId = await eventIdFor(unsigned);
    pdu = { event_id: eventId, ...unsigned };
  }

  // 4. resolve prevs via the server DB's event_index (D8: the extremity
  //    branch comes from event_index.branch_name, not recomputation)
  const prevs: { id: string; commitHash: string; branch: string | null }[] =
    [];
  await withDb(SERVER_DB, async (c) => {
    if (ev.prev_events.length === 0) return;
    const r = await c.query(
      'SELECT event_id, commit_hash, branch_name FROM event_index WHERE event_id = ANY($1);',
      [ev.prev_events],
    );
    // deno-lint-ignore no-explicit-any
    const byId = new Map<string, any>(
      // deno-lint-ignore no-explicit-any
      r.rows.map((row: any) => [String(row.event_id), row] as [string, any]),
    );
    for (const pid of ev.prev_events) {
      const row = byId.get(pid);
      if (!row) throw new Error('M_UNKNOWN_PREV: ' + pid);
      prevs.push({
        id: pid,
        commitHash: String(row.commit_hash),
        branch: row.branch_name == null ? null : String(row.branch_name),
      });
    }
  });

  const { commitHash, newBranch } = await withDb(room.dbName, async (c) => {
    // D6: every operation that may merge sets this right after connecting;
    // the whole merge->resolve->commit sequence stays on this one client.
    await c.query('SET dolt_allow_commit_conflicts = 1;');

    // 4 (room-side checks): prev branch must be a live extremity, and the
    //    D8 invariant must hold (branch tip == the event's commit)
    const branchRows = await c.query('SELECT name FROM dolt.branches;');
    // deno-lint-ignore no-explicit-any
    const branchNames = new Set(branchRows.rows.map((r: any) => String(r.name)));
    for (const p of prevs) {
      if (p.branch === null || !branchNames.has(p.branch)) {
        throw new Error('M_PREV_NOT_EXTREMITY: ' + p.id);
      }
      const h = await c.query(
        `SELECT (SELECT HASHOF('${ident(p.branch)}')) AS h;`,
      );
      if (String(h.rows[0].h) !== p.commitHash) {
        throw new Error('E_BRANCH_POINTER_DRIFT: ' + p.id);
      }
    }

    // 5. base checkout, then D8 branch-first: create + check out the NEW
    //    extremity branch BEFORE any merge or write — ingest NEVER commits
    //    while a prev branch is checked out, so prev pointers never move
    if (prevs.length === 0) {
      await c.query(`SELECT DOLT_CHECKOUT('main');`);
    } else {
      await c.query(`SELECT DOLT_CHECKOUT('${ident(prevs[0].branch!)}');`);
    }
    const newBranch = await branchNameFor(eventId);
    await c.query(`SELECT DOLT_CHECKOUT('-b', '${ident(newBranch)}');`);
    if (prevs.length === 2) {
      await mergeDriver(c, ident(prevs[1].branch!));
    }

    // 6. event row (+ state upsert for state events)
    await c.query(
      'INSERT INTO events (event_id, type, state_key, sender, origin_ts, canonical_json) VALUES ($1, $2, $3, $4, $5, $6);',
      [
        eventId,
        ev.type,
        ev.state_key ?? null,
        ev.sender,
        ev.origin_ts,
        JSON.stringify(pdu),
      ],
    );
    if (ev.state_key != null) {
      await c.query(
        `INSERT INTO state (type, state_key, event_id, content)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (type, state_key)
         DO UPDATE SET event_id = $3, content = $4;`,
        [ev.type, ev.state_key, eventId, JSON.stringify(ev.content)],
      );
    }

    // 7. commit on the NEW branch (parameterized message)
    const msg = `event ${eventId} type ${ev.type}`;
    const res = await c.query(`SELECT DOLT_COMMIT('-Am', $1);`, [msg]);
    let commitHash = res.rows[0]
      ? String(Object.values(res.rows[0])[0] ?? '')
      : '';
    if (commitHash === '') {
      const h = await c.query(`SELECT HASHOF('HEAD');`);
      commitHash = String(Object.values(h.rows[0])[0]);
    }

    // 8. delete consumed prev branches unless the test hook keeps them;
    //    main is never an extremity and stays at the schema-genesis commit
    if (!opts.keepPrevBranches) {
      for (const p of prevs) {
        await c.query(`SELECT DOLT_BRANCH('-D', '${ident(p.branch!)}');`);
      }
    }
    return { commitHash, newBranch };
  });

  // 9. event_id <-> commit_hash bijection + current branch (D8).
  //    Mode B (Phase 3): the WIRE event id is '$'+commit_hash; the events
  //    row keeps its provisional id (rows are immutable once committed);
  //    the branch was named from the provisional id at creation time (D8).
  const wireId = room.roomVersion === 'test.communico.dolt.v1'
    ? '$' + commitHash
    : eventId;
  await withDb(SERVER_DB, async (c) => {
    await c.query(
      'INSERT INTO event_index (event_id, room_id, commit_hash, branch_name) VALUES ($1, $2, $3, $4);',
      [wireId, roomId, commitHash, newBranch],
    );
  });

  // 10.
  return { event_id: wireId, commit_hash: commitHash };
}
