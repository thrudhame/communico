// Display selection is separate from authenticated admission and room state.
// TL 2026-11-16: distinct concurrent unheld OOB events tie by event ID only
// after causal dominance and same-event terminal suppression. No facts erased.
import type { Conn } from '#engine/store/db.ts';
import { membershipHistory } from './membership-history.ts';
import type { MembershipState } from './membership-operations.ts';

export async function membershipDisplay(
  conn: Conn,
  semanticKey: string,
  held: boolean,
) {
  const history = await membershipHistory(conn, semanticKey);
  // Held rooms already have their normal DAG/state-resolution authority. Never
  // use this display selector to authorize a PDU or replace that room state.
  if (held) return { ...history, display: [] };
  const facts = history.frontier.map((operation) => ({
    operation,
    state: JSON.parse(operation.payload) as MembershipState,
  }));
  const terminal = new Set([
    'rejecting',
    'failed-retract',
    'rejected',
    'joined',
  ]);
  // A later distinct invitation can dominate the old terminal dot without
  // having observed a concurrent copy of that old invitation. The retained
  // terminal evidence must still prevent that copy from resurrecting.
  const suppressed = new Set(
    history.ready.map((operation) =>
      JSON.parse(operation.payload) as MembershipState
    )
      .filter((state) => terminal.has(state.status))
      .map((state) => state.eventId),
  );
  const candidates = facts.filter(({ state }) =>
    state.status === 'pending' && !suppressed.has(state.eventId)
  );
  let eventId: string | null = null;
  for (const { state } of candidates) {
    if (eventId === null || state.eventId > eventId) eventId = state.eventId;
  }
  // Same-event evidence stays together for normal PDU/signature validation;
  // there is no source-dot, payload-hash or imported-sequence tie breaker.
  return {
    ...history,
    display: candidates.filter(({ state }) => state.eventId === eventId)
      .map(({ operation }) => operation),
  };
}
