export class AdminError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

export type Body = Record<string, unknown>;
export type Operation = (body: Body) => Promise<unknown> | unknown;

export function text(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') {
    throw new AdminError('BAD_REQUEST', `${key} must be a string`);
  }
  return value;
}

export function optionalText(body: Body, key: string): string | null {
  if (body[key] === null || body[key] === undefined) return null;
  if (typeof body[key] !== 'string') {
    throw new AdminError('BAD_REQUEST', `${key} must be a string`);
  }
  return body[key];
}

export function flag(body: Body, key: string): boolean {
  if (body[key] === undefined) return false;
  if (typeof body[key] !== 'boolean') {
    throw new AdminError('BAD_REQUEST', `${key} must be a boolean`);
  }
  return body[key];
}
