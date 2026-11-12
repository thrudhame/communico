// Required state is a view of the resolved end publication, not timeline state.
import type { StateRow } from '#engine/client/read.ts';
import type { RequiredState } from './types.ts';

const keyOf = (row: StateRow) => row.type + '\0' + row.stateKey;
function explicit(required: RequiredState, userId: string, row: StateRow) {
  // Deployed Synapse intentionally returns all state for wildcard event types.
  return required.some(([type, key]) =>
    type === '*' || (type === row.type &&
      (key === '*' || (key === '$ME' ? userId : key) === row.stateKey))
  );
}

export function requiredState(input: {
  rows: StateRow[];
  before: StateRow[];
  required: RequiredState;
  previousRequired: RequiredState;
  userId: string;
  timeline: Record<string, unknown>[];
  initial: boolean;
  limited: boolean;
  members: Record<string, string>;
}) {
  const before = new Map(input.before.map((row) => [keyOf(row), row.eventId]));
  const lazy = input.required.some(([t, k]) =>
    t === 'm.room.member' && k === '$LAZY'
  );
  const relevant = new Set<string>();
  for (const event of input.timeline) {
    relevant.add(String(event.sender));
    if (event.type === 'm.room.member') relevant.add(String(event.state_key));
  }
  const members = input.initial ? {} : { ...input.members };
  const rows = input.rows.filter((row) => {
    const changed = before.get(keyOf(row)) !== row.eventId;
    const selected = explicit(input.required, input.userId, row);
    const added = !explicit(input.previousRequired, input.userId, row);
    const lazySelected = lazy && row.type === 'm.room.member' &&
      (relevant.has(row.stateKey) ||
        (!input.initial && !input.limited && changed));
    const wanted = (selected && (input.initial || changed || added)) ||
      lazySelected;
    // Explicit and lazy membership share one sent-ID cache. Invalidate changed
    // members even when not selected, so a later lazy appearance cannot miss it.
    if (row.type === 'm.room.member') {
      const sent = members[row.stateKey] === row.eventId;
      if (changed && !wanted) delete members[row.stateKey];
      if (!wanted || (sent && !input.initial)) return false;
      members[row.stateKey] = row.eventId;
    }
    return wanted;
  });
  return { rows, members };
}
