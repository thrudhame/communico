// One Matrix JSON ingress owner. Generated metadata retains requestBody.required
// separately from the Synapse-compatible empty-object interpretation.
import type { PathfinderRequest } from '@pathfinder/pathfinder';
import contracts from './operation-bodies.json' with { type: 'json' };
import { MatrixError } from './matrix-error.ts';

export const operationBodies = contracts;
const policies = contracts.operations.map((operation) => ({
  ...operation,
  pattern: new RegExp(
    '^' +
      operation.path.split(/(\{[^}]+\})/).map((part) =>
        part.startsWith('{')
          ? '[^/]+'
          : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      ).join('') + '$',
  ),
}));

export function operationBodyPolicies(method: string, path: string) {
  return policies.filter((policy) =>
    policy.method === method && policy.pattern.test(path)
  );
}

export function decodeOperationBody(
  bytes: Uint8Array,
  method: string,
  path: string,
): Record<string, unknown> {
  if (bytes.length === 0) {
    if (
      operationBodyPolicies(method, path).some((policy) =>
        policy.required && !policy.emptyObject
      )
    ) {
      throw new MatrixError(400, 'M_NOT_JSON', 'Content not JSON.');
    }
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new MatrixError(400, 'M_NOT_JSON', 'Content not JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MatrixError(400, 'M_BAD_JSON', 'Content must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

// Pathfinder memoizes accepted body bytes. Middleware and adapters share this
// decoder; no route can reintroduce the framework's empty-body ParseError.
export async function parseJson(request: PathfinderRequest) {
  return decodeOperationBody(
    await request.body.bytes(),
    request.method,
    new URL(request._raw.url).pathname,
  );
}
