// api/engine/rulebook/power-levels.ts — power-level parsing, defaults and
// lookups (plan §3a). Spec citations inline per rule; spec tag v1.16.
//
// Sources:
// - S5 defaults / creator-100: data/event-schemas/schema/
//   m.room.power_levels.yaml:10-14 (users -> users_default -> 0; no PL
//   event -> creator 100, all others 0), 23-26 (state_default 50,
//   events_default 0), 28-33 (kick/ban/redact default 50, invite 0),
//   92-111 (users_default note)
// - S6 integers-only: content/rooms/v10.md:67-74 ("power levels MUST NOT
//   be represented as strings"; "Power levels which are not correctly
//   structured are rejected under the authorization rules"), 220-228
//   (rules 9.1/9.2 added-in v10)
// - required level: content/server-server-api.md:489-495 (Definitions:
//   "Required Power Level"), named levels 497-502
// - user-id grammar: content/appendices.md:561-567
import type { Pdu, RoomVersionSpec } from './types.ts';
import { ruleId } from './rule-ids.ts';

// A parsed, structurally-valid m.room.power_levels content. Optional
// numeric fields stay optional so readers apply the spec defaults.
export interface ParsedPowerLevels {
  users: Record<string, number>;
  events: Record<string, number>;
  notifications: Record<string, number>;
  users_default?: number;
  events_default?: number;
  state_default?: number;
  ban?: number;
  redact?: number;
  kick?: number;
  invite?: number;
}

export type PlParse =
  | { ok: true; pl: ParsedPowerLevels }
  // the failing sub-rule of the version's PL rule (v11 9.1/9.2/9.3 —
  // v11.md:226-234; v12 10.1/10.2/10.3 — v12.md:211-218; ruleId()
  // translates, plan D1)
  | { ok: false; rule: string };

// v1.16 appendix grammar (content/appendices.md:561-567):
//   user_id = "@" user_id_localpart ":" server_name
//   user_id_localpart = 1*user_id_char
//   user_id_char = DIGIT / %x61-7A / "-" / "." / "=" / "_" / "/" / "+"
const USER_ID_RE = /^@[0-9a-z.\=_/+-]+:.+$/;

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

// The ≤9 stringy grammar (v1-stringy-power-levels.md:33-40): a single
// base-10 integer (no floats/decimal points), any number of leading
// zeroes, an optional single leading + or -, and optional leading or
// trailing whitespace. The trimmed text must parse to a safe integer —
// the canonical range applies to the parsed value (appendices.md
// :103-110; for ≤5 rooms the strictness gate is about acceptance of
// events, not about PL semantics).
const STRINGY_LEVEL_RE = /^\s*[+-]?[0-9]+\s*$/;

// A power-level value per the version's grammar: an integer, or (≤9 —
// !enforceIntPowerLevels) a string matching the grammar. Returns the
// parsed integer, or null when the value is invalid.
function parseLevel(v: unknown, spec: RoomVersionSpec): number | null {
  if (isInt(v)) return v;
  if (spec.enforceIntPowerLevels || typeof v !== 'string') return null;
  if (!STRINGY_LEVEL_RE.test(v)) return null;
  const n = Number(v.trim());
  return Number.isSafeInteger(n) ? n : null;
}

// Parse an m.room.power_levels content. Integer-only per the room-version
// flag (v10+: v10.md:72-74 — invalid -> reject-signal, never coerced);
// ≤9 accepts the stringy grammar (v1-stringy-power-levels.md:2-40).
// The printed rule numbers come from ruleId() (plan D1).
export function parsePowerLevels(
  content: Record<string, unknown> | undefined | null,
  spec: RoomVersionSpec,
): PlParse {
  const c = content ?? {};
  const scalarKeys = [
    'users_default',
    'events_default',
    'state_default',
    'ban',
    'redact',
    'kick',
    'invite',
  ] as const;
  const scalars: Partial<Record<(typeof scalarKeys)[number], number>> = {};
  for (const k of scalarKeys) {
    if (k in c && c[k] !== undefined) {
      const n = parseLevel(c[k], spec);
      if (n === null) return { ok: false, rule: ruleId(spec, 'pl.types') };
      scalars[k] = n;
    }
  }
  const pl: ParsedPowerLevels = { users: {}, events: {}, notifications: {} };
  for (const k of ['events', 'notifications'] as const) {
    if (k in c && c[k] !== undefined) {
      const v = c[k];
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        return { ok: false, rule: ruleId(spec, 'pl.events_object') };
      }
      for (const [name, val] of Object.entries(v)) {
        const n = parseLevel(val, spec);
        if (n === null) {
          return { ok: false, rule: ruleId(spec, 'pl.events_object') };
        }
        pl[k][name] = n;
      }
    }
  }
  if ('users' in c && c.users !== undefined) {
    const u = c.users;
    if (typeof u !== 'object' || u === null || Array.isArray(u)) {
      return { ok: false, rule: ruleId(spec, 'pl.users_object') };
    }
    for (const [key, val] of Object.entries(u)) {
      if (!USER_ID_RE.test(key)) {
        return { ok: false, rule: ruleId(spec, 'pl.users_object') };
      }
      const n = parseLevel(val, spec);
      if (n === null) {
        return { ok: false, rule: ruleId(spec, 'pl.users_object') };
      }
      pl.users[key] = n;
    }
  }
  Object.assign(pl, scalars);
  return { ok: true, pl };
}

// The room's creators (plan D3): v12 = the create event's sender ∪
// content.additional_creators (v12.md:65-73); v1-10 = content.creator
// (explicitCreator — v10.md:114 requires the field); v11+ = the sender.
export function creatorsOf(
  createEvent: Pdu | null,
  spec: RoomVersionSpec,
): string[] {
  if (!createEvent) return [];
  if (spec.creatorsHaveInfinitePower) {
    const extra = createEvent.content?.['additional_creators'];
    return [
      createEvent.sender,
      ...(Array.isArray(extra)
        ? extra.filter((x): x is string => typeof x === 'string')
        : []),
    ];
  }
  if (spec.explicitCreator) {
    const c = createEvent.content?.creator;
    return typeof c === 'string' ? [c] : [];
  }
  return [createEvent.sender];
}

// The sender's power level (S5): `users[u]` -> `users_default` -> 0; when
// there is NO PL event the room creator (v1-11) has 100 and everyone else
// 0 (m.room.power_levels.yaml:10-14, 99-101). v12 creators hold infinite
// power (yaml:103-105, v12.md:89-93) — flag-gated, declared.
export function userPowerLevel(
  userId: string,
  plEvent: Pdu | null,
  createEvent: Pdu | null,
  spec: RoomVersionSpec,
): number {
  if (spec.creatorsHaveInfinitePower && createEvent) {
    if (creatorsOf(createEvent, spec).includes(userId)) return Infinity;
  }
  if (plEvent) {
    const parsed = parsePowerLevels(plEvent.content, spec);
    if (parsed.ok) {
      const u = parsed.pl.users[userId];
      if (isInt(u)) return u;
      if (isInt(parsed.pl.users_default)) return parsed.pl.users_default;
      return 0;
    }
    // A PL event in state always passed rule 9 at ingest, so this is
    // defensive only: fall through to the no-PL-event defaults rather
    // than coerce garbage into a level.
  }
  if (createEvent && creatorsOf(createEvent, spec).includes(userId)) {
    return 100; // yaml:13-14, 99-101 — the v1-11 creator-100 default
  }
  return 0;
}

// Required power level for an event (server-server-api.md:489-495):
// listed in `events`, else state_default (state events) / events_default
// (message events); the underlying defaults are 50/0 (yaml:23-26).
export function requiredLevel(
  type: string,
  stateKey: string | undefined,
  pl: ParsedPowerLevels | null,
): number {
  if (pl && type in pl.events && isInt(pl.events[type])) return pl.events[type];
  if (stateKey !== undefined) return pl?.state_default ?? 50;
  return pl?.events_default ?? 0;
}

export type NamedLevel = 'invite' | 'kick' | 'ban' | 'redact';

// Invite/kick/ban/redact levels (server-server-api.md:497-502; yaml:28-33):
// invite defaults to 0, the rest to 50.
export function namedLevel(
  name: NamedLevel,
  pl: ParsedPowerLevels | null,
): number {
  const defaults: Record<NamedLevel, number> = {
    invite: 0,
    kick: 50,
    ban: 50,
    redact: 50,
  };
  const v = pl?.[name];
  return isInt(v) ? v : defaults[name];
}
