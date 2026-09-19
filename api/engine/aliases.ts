// api/engine/aliases.ts — band C item 1: room aliases + the directory
// surface (plan §2/D3, spec v1.16 data/api/client-server/directory.yaml;
// alias syntax at appendices.md:703-717). The m.room.aliases state event
// is NOT consulted anywhere (D3 — Complement's "when m.room.aliases is
// restricted" case).
import { serverDb, withDb } from './db.ts';
import { serverName } from './config.ts';
import { MatrixError } from './matrix-error.ts';
import { authorAndIngest } from './ingest.ts';
import { eventIndexRow, lookupRoom, stateAtSeq } from './room.ts';
import { pduById } from './timeline.ts';
import { getRulebook } from './policy.ts';
import {
  parsePowerLevels,
  requiredLevel,
  userPowerLevel,
} from './rulebook/power-levels.ts';
import type { Pdu } from './pdu.ts';

// '#' + localpart + ':' + domain; the localpart is any non-surrogate
// Unicode except ':' and NUL (appendices.md:713-714), so [^:] is the
// honest character class. Non-empty localpart and domain (plan §3a).
const ALIAS_RE = /^#[^:]+:[^:]+$/;

function assertAliasSyntax(alias: string): void {
  if (!ALIAS_RE.test(alias)) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'Room alias invalid');
  }
}

// The domain of a room alias is the server name of the homeserver which
// created it (appendices.md:709-711) — this server speaks only for its
// own; §8 scopes remote alias servers out.
function assertLocalDomain(alias: string): void {
  if (alias.slice(alias.indexOf(':') + 1) !== serverName()) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'Room alias invalid');
  }
}

async function aliasOwner(alias: string): Promise<string | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT room_id FROM room_aliases WHERE alias = $1;',
      [alias],
    );
    return r.rows.length ? String(r.rows[0].room_id) : null;
  });
}

// PUT /directory/room/{alias}: create the mapping. 409 M_ROOM_IN_USE
// when taken (Complement's TestRoomAlias contract). Check-then-insert;
// a lost race re-checks rather than guessing at driver error strings.
export async function createAlias(
  alias: string,
  roomId: string,
  creator: string,
): Promise<void> {
  assertAliasSyntax(alias);
  assertLocalDomain(alias);
  if (!(await lookupRoom(roomId))) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }
  if ((await aliasOwner(alias)) !== null) {
    throw new MatrixError(409, 'M_ROOM_IN_USE', 'alias taken: ' + alias);
  }
  try {
    await withDb(serverDb(), async (c) => {
      await c.query(
        'INSERT INTO room_aliases (alias, room_id, creator) VALUES ($1, $2, $3);',
        [alias, roomId, creator],
      );
    });
  } catch (e) {
    if ((await aliasOwner(alias)) !== null) {
      throw new MatrixError(409, 'M_ROOM_IN_USE', 'alias taken: ' + alias);
    }
    throw e;
  }
}

// GET /directory/room/{alias} — PUBLIC (directory.yaml:88-159 carries no
// security block). 404 M_NOT_FOUND when unmapped (plan §2).
export async function resolveAlias(
  alias: string,
): Promise<{ room_id: string; servers: string[] }> {
  const row = await aliasOwner(alias);
  if (row === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'Room alias not found');
  }
  return { room_id: row, servers: [serverName()] };
}

export async function roomAliases(roomId: string): Promise<string[]> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT alias FROM room_aliases WHERE room_id = $1 ORDER BY alias;',
      [roomId],
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => String(row.alias));
  });
}

// DELETE /directory/room/{alias} (D3): allowed when the requester created
// the alias OR their PL >= the level m.room.canonical_alias requires at
// the CURRENT state (directory.yaml:165-166 — "for instance that room
// aliases can only be deleted by their creator or a server
// administrator"). On success, if the room's m.room.canonical_alias names
// the deleted alias, a corrected event is authored AS THE REQUESTER
// (§3b); the spec recommends deleting + succeeding even when they may not
// update that event (directory.yaml:168-173) — a rulebook reject is
// logged, never fatal to the DELETE.
export async function deleteAlias(
  alias: string,
  requester: string,
): Promise<void> {
  const row = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT room_id, creator FROM room_aliases WHERE alias = $1;',
      [alias],
    );
    return r.rows.length
      ? { roomId: String(r.rows[0].room_id), creator: r.rows[0].creator }
      : null;
  });
  if (row === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'Room alias not found');
  }
  const room = (await lookupRoom(row.roomId))!;
  const rulebook = getRulebook(room.roomVersion);

  const state = (await stateAtSeq(row.roomId, null)) ?? [];
  const plRow = state.find((r) => r.type === 'm.room.power_levels');
  const createRow = state.find((r) => r.type === 'm.room.create');
  const plPdu = plRow
    ? await pduById(
      room.dbName,
      (await eventIndexRow(row.roomId, plRow.eventId))!.commit_hash,
      plRow.eventId,
    )
    : null;
  const createPdu = createRow
    ? await pduById(
      room.dbName,
      (await eventIndexRow(row.roomId, createRow.eventId))!.commit_hash,
      createRow.eventId,
    )
    : null;
  const parsed = plPdu
    ? parsePowerLevels(plPdu.content, { enforceIntPowerLevels: false })
    : null;
  const pl = parsed?.ok ? parsed.pl : null;
  const level = userPowerLevel(
    requester,
    plPdu as Pdu | null,
    createPdu as Pdu | null,
    rulebook.spec,
  );
  const need = requiredLevel('m.room.canonical_alias', '', pl);
  if (row.creator !== requester && level < need) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'not the alias creator and insufficient power level',
    );
  }

  await withDb(serverDb(), async (c) => {
    await c.query('DELETE FROM room_aliases WHERE alias = $1;', [alias]);
  });

  // §3b: drop the deleted alias from the room's canonical_alias event.
  const canonRow = state.find(
    (r) => r.type === 'm.room.canonical_alias' && r.stateKey === '',
  );
  if (canonRow) {
    const content = { ...(canonRow.content as Record<string, unknown>) };
    let changed = false;
    if (content.alias === alias) {
      delete content.alias;
      changed = true;
    }
    if (Array.isArray(content.alt_aliases)) {
      const kept = (content.alt_aliases as unknown[]).filter((a) =>
        a !== alias
      );
      if (kept.length !== (content.alt_aliases as unknown[]).length) {
        content.alt_aliases = kept;
        changed = true;
      }
    }
    if (changed) {
      try {
        await authorAndIngest(row.roomId, {
          type: 'm.room.canonical_alias',
          state_key: '',
          sender: requester,
          content,
          origin_server_ts: Date.now(),
        });
      } catch (e) {
        // directory.yaml:168-173 — the alias stays deleted; the DELETE
        // still succeeds (e.g. requester may not set canonical_alias).
        console.error(
          'alias delete: canonical_alias update rejected (kept):',
          String(e),
        );
      }
    }
  }
}

// PUT /state/m.room.canonical_alias validation (§3a, endpoint-side — the
// rulebook does not know aliases): for `alias` and every `alt_aliases[]`
// entry — syntax first (M_INVALID_PARAM), then existence + points-at-this
// -room (M_BAD_ALIAS).
export async function validateCanonicalAliasContent(
  roomId: string,
  content: Record<string, unknown>,
): Promise<void> {
  const entries: unknown[] = [];
  if ('alias' in content) entries.push(content.alias);
  if ('alt_aliases' in content) {
    if (!Array.isArray(content.alt_aliases)) {
      throw new MatrixError(
        400,
        'M_INVALID_PARAM',
        'alt_aliases must be an array',
      );
    }
    entries.push(...(content.alt_aliases as unknown[]));
  }
  for (const e of entries) {
    if (typeof e !== 'string' || !ALIAS_RE.test(e)) {
      throw new MatrixError(400, 'M_INVALID_PARAM', 'Room alias invalid');
    }
    const resolved = await aliasOwner(e);
    if (resolved === null || resolved !== roomId) {
      throw new MatrixError(
        400,
        'M_BAD_ALIAS',
        'Room alias does not point to this room: ' + e,
      );
    }
  }
}
