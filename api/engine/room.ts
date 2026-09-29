import { ident, serverDb, withDb } from './db.ts';
import { author, ingestEvent } from './ingest.ts';
import { getRulebook, stateKeyOf, type StateMap } from './policy.ts';
import { validAdditionalCreators } from './rulebook/auth-rules.ts';
import type { Pdu } from './pdu.ts';
import { serverName } from './config.ts';
import { MatrixError } from './matrix-error.ts';
import { type EventIndexRow, eventIndexRowOf } from './event-format.ts';

async function sha256hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function dbNameFor(roomId: string): Promise<string> {
  return 'room_' + (await sha256hex(roomId)).slice(0, 20);
}

// Runs a .sql file statement-by-statement (split on ';' at line ends —
// the schema files contain no function bodies, so naive splitting is safe).
export async function runSqlFile(c: unknown, path: string): Promise<void> {
  const text = await Deno.readTextFile(path);
  const statements = text
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // deno-lint-ignore no-explicit-any
  const client = c as any;
  for (const stmt of statements) {
    await client.query(stmt);
  }
}

export interface CreateRoomResult {
  roomId: string;
  createEventId: string;
  memberEventId: string;
  roomAlias?: string;
}

// M4 createRoom options (spec data/api/client-server/create_room.yaml at
// v1.16 — the event order below follows the plan's §3c list literally).
export interface CreateRoomOptions {
  roomVersion?: string; // default '11'
  preset?: string; // private_chat | trusted_private_chat | public_chat
  visibility?: string; // public | private (default private)
  name?: string;
  topic?: string;
  invite?: string[];
  isDirect?: boolean; // is_direct on the invite member events
  roomAliasName?: string;
  creationContent?: Record<string, unknown>;
  initialState?: { type: string; state_key?: string; content: unknown }[];
  powerLevelContentOverride?: Record<string, unknown>;
  // D7: genesis for a replacement room (upgrade.ts) — the create carries
  // the predecessor via creationContent; the preset default events and
  // the invite fan-out are skipped (the transferred state and the
  // existing membership define the room instead).
  fromUpgrade?: boolean;
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const b = out[k];
    if (
      b !== null && typeof b === 'object' && !Array.isArray(b) &&
      v !== null && typeof v === 'object' && !Array.isArray(v)
    ) {
      out[k] = deepMerge(
        b as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

const ALIAS_LOCALPART_RE = /^[a-z0-9._=\-/+]+$/;

// v11 genesis, M4 options path (spec create_room.yaml at v1.16): create,
// creator join, spec-default power levels (every key explicit — tests
// read them) deep-merged with power_level_content_override, preset
// events, initial_state, name/topic, invites, canonical alias.
// Everything validates BEFORE the first write — a bad option is a 400,
// never a half-created room. A rulebook reject inside createRoom would be
// a planner error, not a user error: it surfaces as a 500 with the
// reject marker in the message.
export async function createRoom(
  roomId: string,
  creator: string,
  opts: CreateRoomOptions = {},
): Promise<CreateRoomResult> {
  // --- validate everything up front ---
  const roomVersion = opts.roomVersion ?? '11';
  getRulebook(roomVersion); // unknown -> M_UNSUPPORTED_ROOM_VERSION (never a default)
  const visibility = opts.visibility ?? 'private';
  if (visibility !== 'public' && visibility !== 'private') {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'unknown visibility: ' + visibility,
    );
  }
  const preset = opts.preset ??
    (visibility === 'public' ? 'public_chat' : 'private_chat');
  if (
    preset !== 'private_chat' && preset !== 'trusted_private_chat' &&
    preset !== 'public_chat'
  ) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'unknown preset: ' + preset);
  }
  const invite = opts.invite ?? [];
  for (const u of invite) {
    if (!/^@[^:\s]+:[^\s]+$/.test(u)) {
      throw new MatrixError(400, 'M_INVALID_PARAM', 'not a user id: ' + u);
    }
  }
  const initialState = opts.initialState ?? [];
  for (const e of initialState) {
    if (
      typeof e?.type !== 'string' ||
      (e.state_key !== undefined && typeof e.state_key !== 'string') ||
      e.content === null || typeof e.content !== 'object' ||
      Array.isArray(e.content)
    ) {
      throw new MatrixError(
        400,
        'M_BAD_JSON',
        'initial_state entries need type + content',
      );
    }
  }
  let alias: string | undefined;
  if (opts.roomAliasName !== undefined) {
    if (!ALIAS_LOCALPART_RE.test(opts.roomAliasName)) {
      throw new MatrixError(
        400,
        'M_INVALID_PARAM',
        'bad room_alias_name: ' + opts.roomAliasName,
      );
    }
    alias = '#' + opts.roomAliasName + ':' + serverName();
    if ((await lookupAlias(alias)) !== null) {
      throw new MatrixError(409, 'M_ROOM_IN_USE', 'alias taken: ' + alias);
    }
  }

  const spec = getRulebook(roomVersion).spec;

  // additional_creators (v12, create_room.yaml:163-174): for
  // trusted_private_chat the server SHOULD combine the creation_content
  // list and the invite array, deduplicated; validated per D4 (400).
  let additionalCreators: string[] | undefined;
  if (spec.additionalCreators) {
    const raw = opts.creationContent?.['additional_creators'];
    if (raw !== undefined && !validAdditionalCreators(raw)) {
      throw new MatrixError(
        400,
        'M_INVALID_PARAM',
        'additional_creators is not an array of valid user IDs',
      );
    }
    const base = (raw as string[] | undefined) ?? [];
    const combined = preset === 'trusted_private_chat'
      ? [...new Set([...base, ...invite])]
      : base;
    if (!validAdditionalCreators(combined)) {
      throw new MatrixError(
        400,
        'M_INVALID_PARAM',
        'additional_creators is not an array of valid user IDs',
      );
    }
    additionalCreators = combined.length > 0 ? combined : undefined;
    // D3: power_level_content_override.users must not name a creator
    // (rule 10.4 at ingest; surfaced here as the 400 Complement expects)
    const creators = [creator, ...(additionalCreators ?? [])];
    const overrideUsers = opts.powerLevelContentOverride?.users as
      | Record<string, unknown>
      | undefined;
    if (overrideUsers !== undefined) {
      for (const u of Object.keys(overrideUsers)) {
        if (creators.includes(u)) {
          throw new MatrixError(
            400,
            'M_INVALID_PARAM',
            'power_level_content_override.users must not name a room creator',
          );
        }
      }
    }
  }

  // --- v12: author the create BEFORE the room exists; the room id is
  //     derived from it (D2). 3b: on the (astronomical) collision with an
  //     existing room id, re-author with the next millisecond.
  let createPdu: Pdu | null = null;
  const createContent: Record<string, unknown> = {
    ...(opts.creationContent ?? {}),
  };
  delete createContent.room_version; // overwritten (create_room.yaml:167)
  delete createContent.creator; // overwritten (same; v10 re-adds it)
  createContent.room_version = roomVersion;
  // v10 (D6): the create carries content.creator (v10.md:114 requires it;
  // create_room.yaml:167 — the server overwrites the key)
  if (spec.explicitCreator) createContent.creator = creator;
  if (spec.additionalCreators) {
    if (additionalCreators !== undefined) {
      createContent.additional_creators = additionalCreators;
    } else {
      delete createContent.additional_creators; // key absent when empty
    }
  }
  let finalRoomId = roomId;
  if (spec.roomIdFromCreateEvent) {
    let ts = Date.now();
    for (;;) {
      const pdu = await author(roomId, {
        type: 'm.room.create',
        state_key: '', // the create is a state event — without it the
        // ingest never applies it to state (the M_NO_CREATE bug)
        sender: creator,
        content: createContent,
        prev_events: [],
        origin_server_ts: ts,
        roomVersion,
      });
      const derived = '!' + String(pdu.event_id).slice(1);
      if ((await lookupRoom(derived)) === null) {
        createPdu = pdu;
        finalRoomId = derived;
        break;
      }
      ts += 1;
    }
  }

  // --- provision the room DB + directory row (the book: main is the
  //     room's SYSTEM branch — schema genesis only, never content;
  //     chapter0 + chapter1 start at the genesis commit) ---
  await provisionRoom(finalRoomId, roomVersion);

  const send = async (
    type: string,
    stateKey: string,
    content: Record<string, unknown>,
  ): Promise<string> => {
    const pdu = await author(finalRoomId, {
      type,
      state_key: stateKey,
      sender: creator,
      content,
      origin_server_ts: Date.now(),
    });
    try {
      return (await ingestEvent(finalRoomId, pdu)).event_id;
    } catch (e) {
      const msg = String(e);
      if (
        msg.includes('M_STATE_REJECT') || msg.includes('M_AUTHCHAIN_REJECT')
      ) {
        throw new Error('E_CREATE_ROOM_REJECT: ' + msg);
      }
      throw e;
    }
  };

  // 1. m.room.create — pre-authored for v12 (D2: the room id derives from
  //    it, so it was authored before the row existed and is ingested now);
  //    authored inline for the other versions.
  let createEventId: string;
  if (createPdu !== null) {
    createEventId = (await ingestEvent(finalRoomId, createPdu)).event_id;
  } else {
    createEventId = await send('m.room.create', '', createContent);
  }

  // 2. creator's join
  const memberEventId = await send('m.room.member', creator, {
    membership: 'join',
  });

  // 3. m.room.power_levels — spec defaults (m.room.power_levels.yaml at
  //    v1.16), every key explicit, then the override deep-merged on top.
  //    trusted_private_chat: every invite user gets users[u]=100.
  //    v12 (create_room.yaml:39-52): the creator is NOT listed (infinite
  //    power), and m.room.tombstone is explicitly above state_default.
  let pl: Record<string, unknown> = {
    ban: 50,
    events: spec.creatorsHaveInfinitePower ? { 'm.room.tombstone': 150 } : {},
    events_default: 0,
    invite: 0,
    kick: 50,
    redact: 50,
    state_default: 50,
    users: spec.creatorsHaveInfinitePower ? {} : { [creator]: 100 },
    users_default: 0,
    notifications: { room: 50 },
  };
  if (opts.powerLevelContentOverride !== undefined) {
    pl = deepMerge(pl, opts.powerLevelContentOverride);
  }
  // trusted_private_chat PL-100s the invitees (v11 semantics); for v12
  // they are additional_creators instead (create_room.yaml:45-47) and
  // must NOT appear in users (rule 10.4).
  if (
    preset === 'trusted_private_chat' && !spec.creatorsHaveInfinitePower
  ) {
    const users = { ...(pl.users as Record<string, unknown>) };
    for (const u of invite) users[u] = 100;
    pl.users = users;
  }
  await send('m.room.power_levels', '', pl);

  // 4. preset events (create_room.yaml's preset table at v1.16) — skipped
  // for a replacement room (fromUpgrade): the transferred state defines
  // the room (D7)
  if (opts.fromUpgrade !== true) {
    const presetEvents: [string, Record<string, unknown>][] =
      preset === 'public_chat'
        ? [
          ['m.room.join_rules', { join_rule: 'public' }],
          ['m.room.history_visibility', { history_visibility: 'shared' }],
          ['m.room.guest_access', { guest_access: 'forbidden' }],
        ]
        : [
          ['m.room.join_rules', { join_rule: 'invite' }],
          ['m.room.history_visibility', { history_visibility: 'shared' }],
          ['m.room.guest_access', { guest_access: 'can_join' }],
        ];
    for (const [type, content] of presetEvents) await send(type, '', content);
  }

  // 5. initial_state, in order (content verbatim; state_key default '')
  for (const e of initialState) {
    await send(e.type, e.state_key ?? '', e.content as Record<string, unknown>);
  }

  // 6. name / topic — AFTER initial_state, so they override it (the
  //    "initial_state overwritten by topic" test). The topic is the rich
  //    v1.15+ form (m.room.topic.yaml at v1.16: m.topic.m.text[0].body).
  if (opts.name !== undefined) {
    await send('m.room.name', '', { name: opts.name });
  }
  if (opts.topic !== undefined) {
    await send('m.room.topic', '', {
      topic: opts.topic,
      'm.topic': { 'm.text': [{ body: opts.topic }] },
    });
  }

  // 7. invites (sender: the creator); is_direct rides along when set
  for (const u of invite) {
    await send('m.room.member', u, {
      membership: 'invite',
      ...(opts.isDirect === true ? { is_direct: true } : {}),
    });
  }

  // 8. room_alias_name → the alias row + m.room.canonical_alias
  if (alias !== undefined) {
    await withDb(serverDb(), async (c) => {
      await c.query(
        'INSERT INTO room_aliases (alias, room_id, creator) VALUES ($1, $2, $3);',
        [alias, finalRoomId, creator],
      );
    });
    await send('m.room.canonical_alias', '', { alias });
  }

  // 9. visibility: public → the room_visibility row (the /publicRooms
  //    listing itself is band C; the row is stored now)
  if (visibility === 'public') {
    await withDb(serverDb(), async (c) => {
      await c.query(
        'INSERT INTO room_visibility (room_id, visibility) VALUES ($1, $2);',
        [finalRoomId, 'public'],
      );
    });
  }

  return {
    roomId: finalRoomId,
    createEventId,
    memberEventId,
    roomAlias: alias,
  };
}

export interface RoomInfo {
  dbName: string;
  roomVersion: string;
  // TRUE only for pre-M3 rooms (dev DBs are reset; no migration — plan §3f).
  stubEra: boolean;
  // M5b (the book): the live stay's branch ('chapter<2k+1>'); NULL =
  // archived (the server's last local member left; the room stays
  // readable through chapterHead).
  currentChapter: string | null;
  // the 'room genesis: schema' commit hash on main (the room's system
  // branch) — every chapter branch starts here.
  genesisCommit: string;
}

// M5b: provisioning shared by createRoom, the remote join and the
// out-of-band invite paths (§3.2). Creates the room database, commits
// the schema on `main` (the room's system branch — P5 ruling: main
// carries the genesis commit and never holds content), records the
// genesis commit, and opens the book: chapter0 (history, empty) and
// chapter1 (the first stay) at the genesis commit, current_chapter =
// 'chapter1'.
export async function provisionRoom(
  roomId: string,
  roomVersion: string,
  stubEra = false,
): Promise<{ dbName: string; genesisCommit: string }> {
  const dbName = await dbNameFor(roomId);
  await withDb(serverDb(), async (c) => {
    await c.query(`CREATE DATABASE ${ident(dbName)};`);
  });
  const genesisCommit = await withDb(dbName, async (c) => {
    await runSqlFile(c, 'db/room/schema.sql');
    await c.query(`SELECT DOLT_COMMIT('-Am', 'room genesis: schema');`);
    const g = await c.query(`SELECT HASHOF('main') AS h;`);
    const genesis = String(g.rows[0].h);
    await c.query(`SELECT DOLT_BRANCH('chapter0', '${genesis}');`);
    await c.query(`SELECT DOLT_BRANCH('chapter1', '${genesis}');`);
    return genesis;
  });
  await withDb(serverDb(), async (c) => {
    await c.query(
      'INSERT INTO room_directory (room_id, db_name, room_version, stub_era, current_chapter, genesis_commit) VALUES ($1, $2, $3, $4, $5, $6);',
      [roomId, dbName, roomVersion, stubEra, 'chapter1', genesisCommit],
    );
  });
  return { dbName, genesisCommit };
}

export async function lookupRoom(roomId: string): Promise<RoomInfo | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT db_name, room_version, stub_era, current_chapter, genesis_commit FROM room_directory WHERE room_id = $1;',
      [roomId],
    );
    if (r.rows.length === 0) return null;
    return {
      dbName: r.rows[0].db_name,
      roomVersion: r.rows[0].room_version,
      stubEra: Boolean(r.rows[0].stub_era),
      currentChapter: r.rows[0].current_chapter == null
        ? null
        : String(r.rows[0].current_chapter),
      genesisCommit: String(r.rows[0].genesis_commit),
    };
  });
}

// M5b: the genesis commit recorded at provision (every chapter branch
// starts there; there is no content branch to derive it from).
export async function genesisCommit(roomId: string): Promise<string | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT genesis_commit FROM room_directory WHERE room_id = $1;',
      [roomId],
    );
    return r.rows.length && r.rows[0].genesis_commit != null
      ? String(r.rows[0].genesis_commit)
      : null;
  });
}

// The highest-numbered chapter branch in a room database, odd (a stay)
// or even (a history chapter); null when the room has none.
async function highestChapter(
  dbName: string,
  parity: 'odd' | 'even',
): Promise<string | null> {
  return await withDb(dbName, async (c) => {
    const r = await c.query('SELECT name FROM dolt.branches;');
    let best = -1;
    // deno-lint-ignore no-explicit-any
    for (const row of r.rows as any[]) {
      const m = /^chapter(\d+)$/.exec(String(row.name));
      if (!m) continue;
      const n = Number(m[1]);
      if (parity === 'odd' && n % 2 !== 1) continue;
      if (parity === 'even' && n % 2 !== 0) continue;
      if (n > best) best = n;
    }
    return best < 0 ? null : `chapter${best}`;
  });
}

// M5b (§3.6a): every "state now" read goes through the chapter head —
// the live stay (current_chapter) when set, else the highest-numbered
// odd chapter (an archived room reads as of its close).
export async function chapterHead(roomId: string): Promise<string | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT db_name, current_chapter FROM room_directory WHERE room_id = $1;',
      [roomId],
    );
    if (r.rows.length === 0) return null;
    if (r.rows[0].current_chapter != null) {
      return String(r.rows[0].current_chapter);
    }
    return await highestChapter(String(r.rows[0].db_name), 'odd');
  });
}

// stateNow's variant (it is keyed by the room database, not the room id).
export async function chapterHeadForDb(dbName: string): Promise<string | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT current_chapter FROM room_directory WHERE db_name = $1;',
      [dbName],
    );
    if (r.rows.length === 0) return null;
    if (r.rows[0].current_chapter != null) {
      return String(r.rows[0].current_chapter);
    }
    return await highestChapter(dbName, 'odd');
  });
}

// M5b (§3.10, grounded ≠ held): a prev is grounded only if it has a
// commit of its own whose state is the state AT that event — a live
// event's x* commit or a history commit. Snapshot evidence rows point at
// the join's root commit (join-time state, not their own) and ungrounded
// placeholders at a placeholder state — neither grounds anything.
export async function groundingOf(
  roomId: string,
  eventId: string,
): Promise<'own' | 'evidence' | 'placeholder' | 'unknown'> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT rejected_reason, seq, branch_name FROM event_index WHERE room_id = $1 AND event_id = $2;',
      [roomId, eventId],
    );
    if (r.rows.length === 0) return 'unknown';
    // 'ungrounded' placeholders and 'unverifiable' stores ground nothing
    if (
      r.rows[0].rejected_reason === 'ungrounded' ||
      r.rows[0].rejected_reason === 'unverifiable'
    ) {
      return 'placeholder';
    }
    if (r.rows[0].seq == null && r.rows[0].branch_name == null) {
      return 'evidence';
    }
    return 'own';
  });
}

// M5b (§3.6c): allocate the next chapter pair at the genesis commit —
// n = the highest existing chapter number + 1 (always even): chapter<n>
// history (empty tables), chapter<n+1> the new stay. Used by the local
// reopen (§3.6b) and the remote re-join (§3.6 step 8).
export async function allocateChapterPair(
  roomId: string,
): Promise<{ hist: string; stay: string }> {
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  return await withDb(room.dbName, async (c) => {
    const r = await c.query('SELECT name FROM dolt.branches;');
    let best = -1;
    // deno-lint-ignore no-explicit-any
    for (const row of r.rows as any[]) {
      const m = /^chapter(\d+)$/.exec(String(row.name));
      if (m && Number(m[1]) > best) best = Number(m[1]);
    }
    const n = best + 1;
    const hist = `chapter${n}`;
    const stay = `chapter${n + 1}`;
    await c.query(
      `SELECT DOLT_BRANCH('${ident(hist)}', '${room.genesisCommit}');`,
    );
    await c.query(
      `SELECT DOLT_BRANCH('${ident(stay)}', '${room.genesisCommit}');`,
    );
    return { hist, stay };
  });
}

// M5b: the distinct server domains of the room's JOINED members (a
// membership fact from the room's state index — never a chapter fact).
export async function serversInRoom(roomId: string): Promise<string[]> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      `SELECT user_id FROM room_membership WHERE room_id = $1 AND membership = 'join';`,
      [roomId],
    );
    const domains = new Set<string>();
    // deno-lint-ignore no-explicit-any
    for (const row of r.rows as any[]) {
      const uid = String(row.user_id);
      const at = uid.indexOf(':');
      if (at >= 0) domains.add(uid.slice(at + 1));
    }
    return [...domains];
  });
}

export async function serverInRoom(
  roomId: string,
  name: string,
): Promise<boolean> {
  return (await serversInRoom(roomId)).includes(name);
}

// M5b (§3.2): the state BEFORE an event — resolved across its prevs'
// commit states exactly as ingest steps 8–9 do (used by /state,
// /state_ids and the server-visibility filter). For the join event of a
// remote room the "before" state is the root commit's.
export async function stateBefore(
  roomId: string,
  eventId: string,
): Promise<StateMap> {
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  const rulebook = getRulebook(room.roomVersion);
  const commit = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT commit_hash FROM event_index WHERE room_id = $1 AND event_id = $2;',
      [roomId, eventId],
    );
    return r.rows.length === 0 ? null : String(r.rows[0].commit_hash);
  });
  if (commit === null) throw new Error('M_NOT_FOUND: ' + eventId);
  return await withDb(room.dbName, async (c) => {
    // the event's row lives on its own x* commit — read AS OF it
    const er = await c.query(
      `SELECT prev_events FROM events AS OF '${commit}' WHERE event_id = $1;`,
      [eventId],
    );
    if (er.rows.length === 0) throw new Error('M_NOT_FOUND: ' + eventId);
    const raw = er.rows[0].prev_events;
    const prevIds: string[] = Array.isArray(raw)
      ? raw
      : JSON.parse(String(raw));
    const parentSets: StateMap[] = [];
    const hashes: string[] = [];
    for (const pid of prevIds) {
      const ch = await withDb(serverDb(), async (s) => {
        const r = await s.query(
          'SELECT commit_hash FROM event_index WHERE room_id = $1 AND event_id = $2;',
          [roomId, pid],
        );
        return r.rows.length ? String(r.rows[0].commit_hash) : null;
      });
      if (ch === null) continue;
      hashes.push(ch);
      const m: StateMap = new Map();
      const sr = await c.query(
        `SELECT type, state_key, event_id FROM state AS OF '${ch}';`,
      );
      // deno-lint-ignore no-explicit-any
      for (const row of sr.rows as any[]) {
        m.set(
          stateKeyOf(String(row.type), String(row.state_key ?? '')),
          String(row.event_id),
        );
      }
      parentSets.push(m);
    }
    const pduById = new Map<string, Pdu>();
    const rejectedIds = new Set<string>();
    for (const h of hashes) {
      const rr = await c.query(
        `SELECT event_id, canonical_json, rejected FROM events AS OF '${h}';`,
      );
      // deno-lint-ignore no-explicit-any
      for (const row of rr.rows as any[]) {
        const id = String(row.event_id);
        if (!pduById.has(id)) {
          pduById.set(
            id,
            typeof row.canonical_json === 'string'
              ? JSON.parse(row.canonical_json)
              : row.canonical_json,
          );
        }
        if (row.rejected === true) rejectedIds.add(id);
      }
    }
    const store = {
      get: (id: string) => pduById.get(id),
      isRejected: (id: string) => rejectedIds.has(id),
    };
    return rulebook.resolveState(parentSets, store);
  });
}

// Extremities are only x* branches (chapters are never extremities).
// Returns the tip EVENT id + branch per live extremity (event_index.
// branch_name join; stale rows are excluded by joining against live
// dolt.branches). Soft-failed events (M3, S8 check 6) are excluded —
// they are not added to the server's list of forward extremities
// (server-server-api.md 611-614); they still participate in resolution
// when referenced. M5b (era isolation, §3.6a): only the given era's
// branches count — the default is the room's CURRENT chapter, so an
// archived room (current_chapter NULL) has no live extremities and an
// old stay's x* branches never leak into the new stay.
export interface Extremity {
  eventId: string;
  branch: string;
}

export async function extremities(
  dbName: string,
  roomId: string,
  era?: string,
): Promise<Extremity[]> {
  return await withDb(dbName, async (c) => {
    const r = await c.query('SELECT name FROM dolt.branches;');
    // deno-lint-ignore no-explicit-any
    const xbranches = r.rows.map((row: any) => String(row.name)).filter(
      (n: string) => n.startsWith('x'),
    );
    if (xbranches.length === 0) return [];
    return await withDb(serverDb(), async (s) => {
      const idx = era !== undefined
        ? await s.query(
          'SELECT event_id, branch_name FROM event_index WHERE room_id = $1 AND branch_name = ANY($2) AND rejected = FALSE AND soft_failed = FALSE AND era = $3;',
          [roomId, xbranches, era],
        )
        : await s.query(
          'SELECT event_id, branch_name FROM event_index WHERE room_id = $1 AND branch_name = ANY($2) AND rejected = FALSE AND soft_failed = FALSE AND era = (SELECT current_chapter FROM room_directory WHERE room_id = $1);',
          [roomId, xbranches],
        );
      // deno-lint-ignore no-explicit-any
      return idx.rows.map((row: any) => ({
        eventId: String(row.event_id),
        branch: String(row.branch_name),
      }));
    });
  });
}

// The extremity whose history a reader follows mid-fork (the documented
// "one side's history" simplification). Deterministic and content-based:
// greatest tip depth, tie → smallest event_id. Never a soft-failed or
// rejected tip (extremities() excludes them). Current STATE is never read
// this way — it lives on the current chapter (materialize.publishCurrentState).
export async function headExtremity(
  dbName: string,
  roomId: string,
): Promise<Extremity | null> {
  const xbs = await extremities(dbName, roomId);
  if (xbs.length === 0) return null;
  const withDepth = await withDb(dbName, async (c) => {
    const out: (Extremity & { depth: number })[] = [];
    for (const xb of xbs) {
      const r = await c.query(
        `SELECT depth FROM events AS OF '${
          ident(xb.branch)
        }' WHERE event_id = $1;`,
        [xb.eventId],
      );
      out.push({ ...xb, depth: Number(r.rows[0]?.depth ?? 0) });
    }
    return out;
  });
  withDepth.sort((a, b) =>
    b.depth - a.depth || (a.eventId < b.eventId ? -1 : 1)
  );
  return withDepth[0];
}

// --- M4: state-at-position primitives (E1/E2, plan §3b) -------------------

export interface StateRow {
  type: string;
  stateKey: string;
  eventId: string;
  content: unknown;
}

// The state_commit_hash of the last non-rejected, non-soft-failed R-event
// with seq <= the given one; seq === null -> HASHOF(chapterHead) (now —
// the live stay's tip, or the archived stay's tip for a room we left).
// null when no such event exists (before the room's first event).
export async function stateCommitAtSeq(
  roomId: string,
  seq: number | null,
): Promise<string | null> {
  if (seq === null) {
    const room = await lookupRoom(roomId);
    if (!room) return null;
    const head = await chapterHead(roomId);
    if (head === null) return null;
    return await withDb(room.dbName, async (c) => {
      const r = await c.query(`SELECT HASHOF('${ident(head)}') AS h;`);
      return String(r.rows[0].h);
    });
  }
  // M5b (§3.10, r5 astra): chapter-aware — the last event with seq ≤ N
  // IN THE SAME CHAPTER as N's event, else that chapter's root commit
  // (the snapshot). This is what makes /sync's "state at
  // firstReturned.seq − 1" right at a chapter boundary: never the
  // previous era's state.
  return await withDb(serverDb(), async (c) => {
    const eraRow = await c.query(
      'SELECT era FROM event_index WHERE room_id = $1 AND seq = $2;',
      [roomId, seq],
    );
    const era = eraRow.rows.length && eraRow.rows[0].era != null
      ? String(eraRow.rows[0].era)
      : null;
    if (era !== null) {
      const r = await c.query(
        `SELECT state_commit_hash FROM event_index
         WHERE room_id = $1 AND seq <= $2 AND era = $3 AND rejected = FALSE AND soft_failed = FALSE
           AND state_commit_hash IS NOT NULL
         ORDER BY seq DESC LIMIT 1;`,
        [roomId, seq, era],
      );
      if (r.rows.length) return String(r.rows[0].state_commit_hash);
      // before the chapter's first positioned event → its root commit
      // (the snapshot: the first commit on the stay branch after genesis)
      const room = await lookupRoom(roomId);
      if (room === null) return null;
      return await withDb(room.dbName, async (rc) => {
        await rc.query(`SELECT DOLT_CHECKOUT('${ident(era)}');`);
        const rl = await rc.query(
          `SELECT commit_hash FROM dolt.log WHERE commit_order >
             (SELECT commit_order FROM dolt.log WHERE commit_hash = '${room.genesisCommit}')
           ORDER BY commit_order ASC LIMIT 1;`,
        );
        return rl.rows.length ? String(rl.rows[0].commit_hash) : null;
      });
    }
    const r = await c.query(
      `SELECT state_commit_hash FROM event_index
       WHERE room_id = $1 AND seq <= $2 AND rejected = FALSE AND soft_failed = FALSE
         AND state_commit_hash IS NOT NULL
       ORDER BY seq DESC LIMIT 1;`,
      [roomId, seq],
    );
    return r.rows.length ? String(r.rows[0].state_commit_hash) : null;
  });
}

// The room's state AS OF a chapter commit hash (E1, M5b: the live
// chapter's commit history IS the state history).
export async function stateAt(
  dbName: string,
  stateHash: string,
): Promise<StateRow[]> {
  if (!/^[a-z0-9]+$/i.test(stateHash)) {
    throw new Error('E_BAD_HASH: ' + stateHash);
  }
  return await withDb(dbName, async (c) => {
    const r = await c.query(
      `SELECT type, state_key, event_id, content FROM state AS OF '${stateHash}';`,
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => ({
      type: String(row.type),
      stateKey: String(row.state_key),
      eventId: String(row.event_id),
      content: typeof row.content === 'string'
        ? JSON.parse(row.content)
        : row.content,
    }));
  });
}

// stateAt at a seq position (null = now); null when the position precedes
// the room's first event.
export async function stateAtSeq(
  roomId: string,
  seq: number | null,
): Promise<StateRow[] | null> {
  const hash = await stateCommitAtSeq(roomId, seq);
  if (hash === null) return null;
  const room = await lookupRoom(roomId);
  if (!room) return null;
  return await stateAt(room.dbName, hash);
}

// The user's CURRENT membership row in the room (from the room_membership
// index — the row exists for any membership value, incl. leave/ban).
export async function membershipOf(
  roomId: string,
  userId: string,
): Promise<
  | { membership: string; eventId: string; seq: number; forgotten: boolean }
  | null
> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT membership, event_id, seq, forgotten FROM room_membership WHERE room_id = $1 AND user_id = $2;',
      [roomId, userId],
    );
    return r.rows.length
      ? {
        membership: String(r.rows[0].membership),
        eventId: String(r.rows[0].event_id),
        seq: Number(r.rows[0].seq),
        forgotten: r.rows[0].forgotten === true,
      }
      : null;
  });
}

// Every room the user has a membership row in, any value.
export async function roomsFor(
  userId: string,
): Promise<
  {
    roomId: string;
    membership: string;
    eventId: string;
    seq: number;
    forgotten: boolean;
  }[]
> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT room_id, membership, event_id, seq, forgotten FROM room_membership WHERE user_id = $1;',
      [userId],
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => ({
      roomId: String(row.room_id),
      membership: String(row.membership),
      eventId: String(row.event_id),
      seq: Number(row.seq),
      forgotten: row.forgotten === true,
    }));
  });
}

// Just the room ids the user is currently joined to.
export async function joinedRooms(userId: string): Promise<string[]> {
  return (await roomsFor(userId))
    .filter((r) => r.membership === 'join')
    .map((r) => r.roomId);
}

// --- M4: aliases + stream tokens -----------------------------------------

// alias -> room id (createRoom room_alias_name; /join by alias).
export async function lookupAlias(alias: string): Promise<string | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT room_id FROM room_aliases WHERE alias = $1;',
      [alias],
    );
    return r.rows.length ? String(r.rows[0].room_id) : null;
  });
}

// The full event_index row for one event (the formatter's input shape).
export async function eventIndexRow(
  roomId: string,
  eventId: string,
): Promise<EventIndexRow | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT * FROM event_index WHERE room_id = $1 AND event_id = $2;',
      [roomId, eventId],
    );
    if (r.rows.length === 0) return null;
    return eventIndexRowOf(r.rows[0]);
  });
}

// E3: sync token grammar — s<eventSeq>_p<presenceSeq>; legacy s<n> parses
// as _p0. Tokens are global stream positions: valid across users, and as
// /messages?from=/to= and /members?at=.
// Band C (D1): sync tokens are s<e>_p<p>_t<t>_r<r> — four monotone
// streams: events, presence, typing (in-memory), receipts. v12 (D10):
// a fifth, _a<a> for the account-data stream. Missing parts parse as 0,
// so every older shape keeps working.
export function parseStreamToken(
  raw: string | null,
):
  | { eSeq: number; pSeq: number; tSeq: number; rSeq: number; aSeq: number }
  | null {
  if (raw === null) return null;
  const m = /^s(\d+)(?:_p(\d+))?(?:_t(\d+))?(?:_r(\d+))?(?:_a(\d+))?$/.exec(
    raw,
  );
  if (!m) return null;
  return {
    eSeq: Number(m[1]),
    pSeq: m[2] ? Number(m[2]) : 0,
    tSeq: m[3] ? Number(m[3]) : 0,
    rSeq: m[4] ? Number(m[4]) : 0,
    aSeq: m[5] ? Number(m[5]) : 0,
  };
}

export function formatStreamToken(
  eSeq: number,
  pSeq: number,
  tSeq = 0,
  rSeq = 0,
  aSeq = 0,
): string {
  return `s${eSeq}_p${pSeq}_t${tSeq}_r${rSeq}_a${aSeq}`;
}
