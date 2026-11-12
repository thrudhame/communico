// One keyset boundary owns global and group continuations for both orderings.
// A cursor grants no visibility: the caller reselects visible candidates on use.
import { invalidParameter } from '#engine/operation.ts';
import {
  SEARCH_GROUPS,
  type SearchGroup,
  type SearchRequest,
} from './search-request.ts';
import { parseStreamToken } from './timeline.ts';

export type SearchPosition = { rank: number; seq: number; eventId: string };
type Scope = { key: SearchGroup; value: string };
type Cursor = { position: SearchPosition; scope?: Scope };
function compare(
  a: SearchPosition,
  b: SearchPosition,
  order: SearchRequest['order'],
) {
  return (order === 'rank' ? b.rank - a.rank : 0) || b.seq - a.seq ||
    (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);
}
function token(
  position: SearchPosition,
  order: SearchRequest['order'],
  scope?: Scope,
) {
  return 'search_' +
    btoa(
      String.fromCharCode(
        ...new TextEncoder().encode(
          JSON.stringify([
            order,
            position.rank,
            position.seq,
            position.eventId,
            scope?.key ?? null,
            scope?.value ?? null,
          ]),
        ),
      ),
    ).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function cursor(
  raw: string | null,
  order: SearchRequest['order'],
): Cursor | null {
  if (raw === null) return null;
  // Preserve already-issued recent stream cursors across an upgrade.
  if (!raw.startsWith('search_')) {
    const old = parseStreamToken(raw);
    if (order !== 'recent' || old === null) invalidParameter('next_batch');
    return { position: { rank: 0, seq: old.eSeq, eventId: '\uffff' } };
  }
  let value;
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(
          atob(raw.slice(7).replaceAll('-', '+').replaceAll('_', '/')),
          (c) => c.charCodeAt(0),
        ),
      ),
    );
  } catch {
    invalidParameter('next_batch');
  }
  if (
    !Array.isArray(value) || value.length !== 6 || value[0] !== order ||
    typeof value[1] !== 'number' || !Number.isFinite(value[1]) ||
    value[1] < 0 ||
    !Number.isSafeInteger(value[2]) || value[2] < 0 ||
    typeof value[3] !== 'string' ||
    !((value[4] === null && value[5] === null) ||
      (SEARCH_GROUPS.includes(value[4]) && typeof value[5] === 'string'))
  ) invalidParameter('next_batch');
  return {
    position: { rank: value[1], seq: value[2], eventId: value[3] },
    ...(value[4] === null ? {} : { scope: { key: value[4], value: value[5] } }),
  };
}
export function searchPage<
  T extends SearchPosition & { roomId: string; sender: string },
>(
  hits: T[],
  request: SearchRequest,
  next: string | null,
) {
  const boundary = cursor(next, request.order);
  const valueOf = (hit: T, key: SearchGroup) =>
    key === 'room_id' ? hit.roomId : hit.sender;
  const scoped = hits.filter((h) =>
    !boundary?.scope || valueOf(h, boundary.scope.key) === boundary.scope.value
  )
    .sort((a, b) => compare(a, b, request.order));
  const remaining = scoped.filter((h) =>
    boundary === null || compare(h, boundary.position, request.order) > 0
  );
  const limit = request.filter.limit ?? 10;
  const page = remaining.slice(0, limit);
  const last = page.at(-1);
  const nextBatch = last !== undefined && remaining.length > page.length
    ? token(last, request.order, boundary?.scope)
    : undefined;
  const groups: Record<
    string,
    Record<string, { results: string[]; order: number; next_batch?: string }>
  > = {};
  for (const key of request.groups) {
    const grouped: typeof groups[string] = {};
    for (const hit of page) {
      const value = valueOf(hit, key);
      const group = grouped[value] ??= {
        results: [],
        order: Object.keys(grouped).length,
      };
      group.results.push(hit.eventId);
      if (
        remaining.some((h) =>
          valueOf(h, key) === value && compare(h, hit, request.order) > 0
        )
      ) {
        group.next_batch = token(hit, request.order, { key, value });
      } else delete group.next_batch;
    }
    groups[key] = grouped;
  }
  return { count: scoped.length, page, nextBatch, groups };
}
