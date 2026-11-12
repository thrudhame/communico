import { mediaType } from './fields.ts';
import { protocol } from './upstream-error.ts';

export function decodeJson(
  bytes: Uint8Array,
  contentType: string | null,
): unknown {
  if (
    contentType === null || mediaType(contentType).value !== 'application/json'
  ) {
    protocol('json', 'expected application/json response');
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    protocol('json', 'invalid UTF-8 JSON response', cause);
  }
}
export function objectOf(
  value: unknown,
  endpoint = 'response',
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    protocol(endpoint, 'expected JSON object');
  }
  return value as Record<string, unknown>;
}
export function arrayOf<T>(
  value: unknown,
  decode: (entry: unknown) => T,
  endpoint = 'response',
): T[] {
  if (!Array.isArray(value)) protocol(endpoint, 'expected JSON array');
  return value.map(decode);
}
export function stringOf(value: unknown, endpoint = 'response'): string {
  if (typeof value !== 'string') protocol(endpoint, 'expected string');
  return value;
}

// Peer-response schemas call this only for fields declared optional. Null means
// absence unless that field's specification gives null a value of its own.
// This is a shallow decoded view: never rewrite signed JSON or opaque content.
export function optionalField<T>(
  value: unknown,
  decode: (value: unknown) => T,
  options: { nullIsValue?: boolean } = {},
): T | undefined {
  if (
    value === undefined || (value === null && options.nullIsValue !== true)
  ) return undefined;
  return decode(value);
}

export function booleanOf(value: unknown, endpoint = 'response'): boolean {
  if (typeof value !== 'boolean') protocol(endpoint, 'expected boolean');
  return value;
}
