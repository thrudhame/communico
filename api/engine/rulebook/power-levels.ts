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
import type { Pdu } from './types.ts';

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
  // the failing sub-rule of v11 rule 9 (9.1 / 9.2 / 9.3 — v11.md:226-234;
  // 9.1/9.2 integer-only via v10.md:221-228)
  | { ok: false; rule: '9.1' | '9.2' | '9.3' };

// v1.16 appendix grammar (content/appendices.md:561-567):
//   user_id = "@" user_id_localpart ":" server_name
//   user_id_localpart = 1*user_id_char
//   user_id_char = DIGIT / %x61-7A / "-" / "." / "=" / "_" / "/" / "+"
const USER_ID_RE = /^@[0-9a-z.\=_/+-]+:.+$/;

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

// Parse an m.room.power_levels content. Integer-only per the room-version
// flag (v10+: v10.md:72-74 — invalid -> reject-signal, never coerced).
// The rule numbers mirror v11.md:226-234 (9.1 scalar ints, 9.2
// events/notifications object-of-ints, 9.3 users object of valid-user-id
// -> int).
export function parsePowerLevels(
  content: Record<string, unknown> | undefined | null,
  spec: { enforceIntPowerLevels: boolean },
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
  for (const k of scalarKeys) {
    if (k in c && c[k] !== undefined) {
      const v = c[k];
      if (
        spec.enforceIntPowerLevels
          ? !isInt(v)
          : !(isInt(v) || typeof v === 'string')
      ) {
        return { ok: false, rule: '9.1' };
      }
    }
  }
  for (const k of ['events', 'notifications'] as const) {
    if (k in c && c[k] !== undefined) {
      const v = c[k];
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        return { ok: false, rule: '9.2' };
      }
      for (const val of Object.values(v)) {
        if (
          spec.enforceIntPowerLevels
            ? !isInt(val)
            : !(isInt(val) || typeof val === 'string')
        ) {
          return { ok: false, rule: '9.2' };
        }
      }
    }
  }
  if ('users' in c && c.users !== undefined) {
    const u = c.users;
    if (typeof u !== 'object' || u === null || Array.isArray(u)) {
      return { ok: false, rule: '9.3' };
    }
    for (const [key, val] of Object.entries(u)) {
      if (!USER_ID_RE.test(key)) return { ok: false, rule: '9.3' };
      if (
        spec.enforceIntPowerLevels
          ? !isInt(val)
          : !(isInt(val) || typeof val === 'string')
      ) {
        return { ok: false, rule: '9.3' };
      }
    }
  }
  const pl: ParsedPowerLevels = {
    users: (c.users ?? {}) as Record<string, number>,
    events: (c.events ?? {}) as Record<string, number>,
    notifications: (c.notifications ?? {}) as Record<string, number>,
  };
  for (const k of scalarKeys) {
    if (k in c && c[k] !== undefined) {
      const v = c[k];
      const out = pl as unknown as Record<string, unknown>;
      if (isInt(v)) out[k] = v;
      else out[k] = Number(v);
    }
  }
  return { ok: true, pl };
}

// The sender's power level (S5): `users[u]` -> `users_default` -> 0; when
// there is NO PL event the room creator (create sender, v1-11) has 100 and
// everyone else 0 (m.room.power_levels.yaml:10-14, 99-101). v12 creators
// hold infinite power (yaml:103-105, v12.md:89-93) — flag-gated, declared.
export function userPowerLevel(
  userId: string,
  plEvent: Pdu | null,
  createEvent: Pdu | null,
  spec: {
    implicitRoomCreator: boolean;
    creatorsHaveInfinitePower: boolean;
  },
): number {
  if (spec.creatorsHaveInfinitePower && createEvent) {
    const extra = createEvent.content?.['additional_creators'];
    const creators = [
      createEvent.sender,
      ...(Array.isArray(extra)
        ? extra.filter((x): x is string => typeof x === 'string')
        : []),
    ];
    if (creators.includes(userId)) return Infinity;
  }
  if (plEvent) {
    const parsed = parsePowerLevels(plEvent.content, {
      enforceIntPowerLevels: false,
    });
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
  if (
    spec.implicitRoomCreator && createEvent && userId === createEvent.sender
  ) {
    return 100; // yaml:13-14, 99-101
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
