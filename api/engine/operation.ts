// HTTP operation decoders share strict primitives, not defaults or endpoint
// policy. Undefined is omission; null and malformed known values are not.
import { MatrixError } from './matrix-error.ts';

export function invalidParameter(name: string): never {
  throw new MatrixError(400, 'M_INVALID_PARAM', 'Invalid parameter: ' + name);
}

export function objectParameter(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidParameter(name);
  }
  return value as Record<string, unknown>;
}

export function stringParameter(
  value: unknown,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') invalidParameter(name);
  return value;
}

export function booleanParameter(
  value: unknown,
  name: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') invalidParameter(name);
  return value;
}

export function integerParameter(
  value: unknown,
  name: string,
  minimum?: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' || !Number.isSafeInteger(value) ||
    (minimum !== undefined && value < minimum)
  ) invalidParameter(name);
  return value;
}

export function enumParameter<const T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const text = stringParameter(value, name);
  if (text !== undefined && !allowed.includes(text as T)) {
    invalidParameter(name);
  }
  return text as T | undefined;
}

export function queryInteger(
  value: string | null,
  name: string,
  minimum?: number,
): number | undefined {
  if (value === null) return undefined;
  if (!/^-?\d+$/.test(value)) invalidParameter(name);
  return integerParameter(Number(value), name, minimum);
}

export function queryBoolean(
  value: string | null,
  name: string,
): boolean | undefined {
  if (value === null) return undefined;
  if (value !== 'true' && value !== 'false') invalidParameter(name);
  return value === 'true';
}

export function requiredParameter<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'Missing parameter: ' + name);
  }
  return value;
}
