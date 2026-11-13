import {
  booleanParameter,
  enumParameter,
  integerParameter,
  invalidParameter,
  objectParameter,
  requiredParameter,
  stringParameter,
} from '#engine/operation.ts';
import { SEARCH_KEYS } from '#engine/server/read.ts';
import { roomEventFilterOf } from '#engine/tenant/filters.ts';

export const SEARCH_GROUPS = ['room_id', 'sender'] as const;
export type SearchGroup = typeof SEARCH_GROUPS[number];
export function searchRequest(value: unknown) {
  const raw = objectParameter(value, 'room_events');
  let keys = [...SEARCH_KEYS];
  if (raw.keys !== undefined) {
    if (!Array.isArray(raw.keys)) invalidParameter('keys');
    keys = raw.keys.map((key) =>
      requiredParameter(enumParameter(key, 'keys', SEARCH_KEYS), 'keys')
    );
  }
  const groups: SearchGroup[] = [];
  if (raw.groupings !== undefined) {
    const grouping = objectParameter(raw.groupings, 'groupings');
    if (grouping.group_by !== undefined) {
      if (!Array.isArray(grouping.group_by)) {
        invalidParameter('groupings.group_by');
      }
      for (const item of grouping.group_by) {
        const group = objectParameter(item, 'groupings.group_by[]');
        const key = enumParameter(
          group.key,
          'groupings.group_by[].key',
          SEARCH_GROUPS,
        );
        if (key !== undefined && !groups.includes(key)) groups.push(key);
      }
    }
  }
  let context;
  if (raw.event_context !== undefined) {
    const ctx = objectParameter(raw.event_context, 'event_context');
    context = {
      before:
        integerParameter(ctx.before_limit, 'event_context.before_limit', 0) ??
          5,
      after:
        integerParameter(ctx.after_limit, 'event_context.after_limit', 0) ?? 5,
      profile: booleanParameter(
        ctx.include_profile,
        'event_context.include_profile',
      ) ?? false,
    };
  }
  const filter = roomEventFilterOf(raw.filter);
  if (filter.limit === 0) invalidParameter('filter.limit');
  return {
    term: requiredParameter(
      stringParameter(raw.search_term, 'search_term'),
      'search_term',
    ),
    keys,
    filter,
    order: enumParameter(raw.order_by, 'order_by', ['rank', 'recent']) ??
      'rank',
    context,
    state: booleanParameter(raw.include_state, 'include_state') ?? false,
    groups,
  };
}
export type SearchRequest = ReturnType<typeof searchRequest>;
