import { enumParameter } from '#engine/operation.ts';

const MEMBERSHIPS = ['invite', 'join', 'knock', 'leave', 'ban'] as const;
export function stateFormat(value: string | null) {
  return enumParameter(value === null ? undefined : value, 'format', [
    'content',
    'event',
  ]) ?? 'content';
}
export function memberFilters(query: URLSearchParams) {
  return {
    membership: enumParameter(
      query.get('membership') ?? undefined,
      'membership',
      MEMBERSHIPS,
    ),
    notMembership: enumParameter(
      query.get('not_membership') ?? undefined,
      'not_membership',
      MEMBERSHIPS,
    ),
  };
}
