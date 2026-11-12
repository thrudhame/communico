import { MatrixError } from '#engine/matrix-error.ts';
import {
  enumParameter,
  queryBoolean,
  queryInteger,
} from '#engine/operation.ts';
import { parseStreamToken } from './tokens.ts';

export function decodeSyncRequest(query: URLSearchParams) {
  const raw = query.get('since');
  const since = parseStreamToken(raw);
  if (raw !== null && since === null) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'bad since token: ' + raw);
  }
  const stable = queryBoolean(query.get('use_state_after'), 'use_state_after');
  const unstable = queryBoolean(
    query.get('org.matrix.msc4222.use_state_after'),
    'org.matrix.msc4222.use_state_after',
  );
  return {
    since,
    timeoutMs: queryInteger(query.get('timeout'), 'timeout', 0) ?? 0,
    fullState: queryBoolean(query.get('full_state'), 'full_state') ?? false,
    setPresence:
      enumParameter(query.get('set_presence') ?? undefined, 'set_presence', [
        'online',
        'offline',
        'unavailable',
      ]) ?? 'online',
    useStateAfter: stable ?? unstable ?? false,
    stateAfterKey: stable === undefined
      ? 'org.matrix.msc4222.state_after' as const
      : 'state_after' as const,
    filter: query.get('filter'),
  };
}
