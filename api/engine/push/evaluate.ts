// Pure push evaluation over an immutable publication snapshot. No store,
// network or client decryption capability belongs at this boundary.
import {
  PUSH_KINDS,
  type PushKind,
  type PushRule,
  type Ruleset,
} from '#engine/push/defaults.ts';

export type PushContext = {
  event: Record<string, unknown>;
  userId: string;
  displayName: string | null;
  joinedCount: number;
  senderPower: number | null;
  notificationPower: Readonly<Record<string, number>>;
};
export type Decision = {
  ruleId: string;
  kind: PushKind;
  notify: boolean;
  highlight: boolean;
  actions: unknown[];
  tweaks: Record<string, unknown>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Escapes only dot and backslash; unknown escapes remain literal. Own
 * properties only, and no array indexing or prototype traversal. */
export function propertyAt(event: unknown, path: string): unknown {
  const parts: string[] = [];
  let part = '';
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === '\\' && (path[i + 1] === '.' || path[i + 1] === '\\')) {
      part += path[++i];
    } else if (c === '.') {
      parts.push(part);
      part = '';
    } else part += c;
  }
  parts.push(part);
  let value = event;
  for (const key of parts) {
    if (!record(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

type GlobToken = { literal: string } | '*' | '?';
function tokens(pattern: string): GlobToken[] {
  const out: GlobToken[] = [];
  const chars = [...pattern.toLowerCase()];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '*' || c === '?') {
      if (c !== '*' || out.at(-1) !== '*') out.push(c);
    } else out.push({ literal: c });
  }
  return out;
}
const wordChar = (c: string | undefined) =>
  c !== undefined && /^[a-z0-9_]$/.test(c);

/** NFA simulation: bounded O(text x pattern), O(pattern) memory, without
 * backtracking regexes. Word matching restarts at ASCII word boundaries. */
function matchTokens(
  value: string,
  pattern: GlobToken[],
  word: boolean,
): boolean {
  const chars = [...value.toLowerCase()];
  let states = new Uint8Array(pattern.length + 1);
  const closure = () => {
    for (let j = 0; j < pattern.length; j++) {
      if (states[j] && pattern[j] === '*') states[j + 1] = 1;
    }
  };
  states[0] = 1;
  for (let i = 0; i <= chars.length; i++) {
    if (word && !wordChar(chars[i - 1])) states[0] = 1;
    closure();
    if (
      states[pattern.length] &&
      (word ? !wordChar(chars[i]) : i === chars.length)
    ) return true;
    if (i === chars.length) break;
    const next = new Uint8Array(pattern.length + 1);
    for (let j = 0; j < pattern.length; j++) {
      if (!states[j]) continue;
      const token = pattern[j];
      if (token === '*') next[j] = 1;
      else if (token === '?' || token.literal === chars[i]) next[j + 1] = 1;
    }
    states = next;
  }
  return false;
}

export function globMatch(
  value: string,
  pattern: string,
  word = false,
): boolean {
  return matchTokens(value, tokens(pattern), word);
}

function scalar(value: unknown): boolean {
  return value === null || typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isSafeInteger(value));
}

export function matchesCondition(
  condition: unknown,
  ctx: PushContext,
): boolean {
  if (!record(condition)) return false;
  const { kind, key, value } = condition;
  switch (kind) {
    case 'event_match': {
      if (typeof key !== 'string' || typeof condition.pattern !== 'string') {
        return false;
      }
      const found = propertyAt(ctx.event, key);
      return typeof found === 'string' &&
        globMatch(found, condition.pattern, key === 'content.body');
    }
    case 'event_property_is': {
      if (typeof key !== 'string' || !scalar(value)) return false;
      const found = propertyAt(ctx.event, key);
      return scalar(found) && found === value;
    }
    case 'event_property_contains': {
      if (typeof key !== 'string' || !scalar(value)) return false;
      const found = propertyAt(ctx.event, key);
      return Array.isArray(found) &&
        found.some((entry) => scalar(entry) && entry === value);
    }
    case 'contains_display_name': {
      const body = propertyAt(ctx.event, 'content.body');
      return !!ctx.displayName && typeof body === 'string' &&
        matchTokens(
          body,
          [...ctx.displayName.toLowerCase()].map((literal) => ({ literal })),
          true,
        );
    }
    case 'room_member_count': {
      if (typeof condition.is !== 'string') return false;
      const parsed = /^(==|<=|>=|<|>)?([0-9]+)$/.exec(condition.is);
      if (!parsed) return false;
      const count = Number(parsed[2]);
      if (!Number.isSafeInteger(count)) return false;
      switch (parsed[1]) {
        case '<':
          return ctx.joinedCount < count;
        case '>':
          return ctx.joinedCount > count;
        case '<=':
          return ctx.joinedCount <= count;
        case '>=':
          return ctx.joinedCount >= count;
        default:
          return ctx.joinedCount === count;
      }
    }
    case 'sender_notification_permission':
      return typeof key === 'string' && ctx.senderPower !== null &&
        ctx.senderPower >=
          (Object.hasOwn(ctx.notificationPower, key)
            ? ctx.notificationPower[key]
            : 50);
    default:
      return false;
  }
}

const legacyMentions = new Set([
  '.m.rule.contains_display_name',
  '.m.rule.contains_user_name',
  '.m.rule.roomnotif',
]);
function matchesRule(
  rule: PushRule,
  kind: PushKind,
  ctx: PushContext,
): boolean {
  if (!rule.enabled) return false;
  if (rule.default && legacyMentions.has(rule.rule_id)) {
    const content = ctx.event.content;
    if (record(content) && Object.hasOwn(content, 'm.mentions')) return false;
  }
  switch (kind) {
    case 'override':
    case 'underride':
      return rule.conditions === undefined || (Array.isArray(rule.conditions) &&
        rule.conditions.every((c) => matchesCondition(c, ctx)));
    case 'content': {
      const body = propertyAt(ctx.event, 'content.body');
      return typeof rule.pattern === 'string' && typeof body === 'string' &&
        globMatch(body, rule.pattern, true);
    }
    case 'room':
      return ctx.event.room_id === rule.rule_id;
    case 'sender':
      return ctx.event.sender === rule.rule_id;
  }
}

export function evaluate(rules: Ruleset, ctx: PushContext): Decision | null {
  if (ctx.event.sender === ctx.userId) return null;
  for (const kind of PUSH_KINDS) {
    for (const rule of rules[kind]) {
      if (!matchesRule(rule, kind, ctx)) continue;
      const actions = rule.actions.filter((a) =>
        a !== 'dont_notify' && a !== 'coalesce'
      );
      const tweaks: Record<string, unknown> = Object.create(null);
      for (const action of actions) {
        if (!record(action) || typeof action.set_tweak !== 'string') continue;
        const name = action.set_tweak;
        if (name === 'highlight') {
          tweaks[name] = action.value === undefined
            ? true
            : action.value === true;
        } else if (
          name !== 'sound' || typeof action.value === 'string'
        ) tweaks[name] = action.value;
      }
      const notify = actions.includes('notify');
      return {
        ruleId: rule.rule_id,
        kind,
        actions,
        notify,
        highlight: notify && tweaks.highlight === true,
        tweaks,
      };
    }
  }
  return null;
}
