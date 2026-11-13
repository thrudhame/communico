// Discovery/read contracts remain available independently of the optional
// application-service and identity-server producers. Neither is configured.
import { MatrixError } from '#engine/matrix-error.ts';
import { requiredParameter, stringParameter } from '#engine/operation.ts';

export function thirdPartyProtocols(): Record<string, never> {
  return {};
}

export function thirdPartyProtocol(_protocol: string): never {
  throw new MatrixError(404, 'M_NOT_FOUND', 'Unknown protocol');
}

export function thirdPartyMappings(
  query: URLSearchParams,
  kind: 'user' | 'location',
  protocol?: string,
): never[] {
  if (protocol === undefined) {
    const name = kind === 'user' ? 'userid' : 'alias';
    requiredParameter(
      stringParameter(query.get(name) ?? undefined, name),
      name,
    );
  }
  return [];
}

export function accountThreepids(): { threepids: never[] } {
  return { threepids: [] };
}
