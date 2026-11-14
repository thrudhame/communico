// The link exchanges domain records, never SQL or forwarded HTTP requests.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';

export class LinkError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = 'LinkError';
  }
}

export type Stream = {
  source: string;
  incarnation: string;
  stream: string;
};
export type Cut = { sequence: number; hash: string };
export type LinkRecord = Stream & {
  sequence: number;
  type: string;
  version: number;
  operationId: string;
  previous: string;
  hash: string;
  payload: unknown;
};
export type Version = { major: number; minor: number };
export type Capability = { type: string; version: number };
export type Negotiation = {
  protocol: Version;
  server: string;
  required: Capability[];
};
export const LINK_VERSION: Version = { major: 1, minor: 0 };
export const LINK_CAPABILITIES: readonly Capability[] = [{
  type: 'control',
  version: 1,
}, {
  type: 'room-replica',
  version: 1,
}, {
  type: 'public-replica',
  version: 1,
}, {
  type: 'directory-replica',
  version: 1,
}, {
  type: 'ingress',
  version: 1,
}, {
  type: 'egress',
  version: 1,
}];
export const EMPTY_CUT: Cut = { sequence: 0, hash: '' };

function bad(message: string): never {
  throw new LinkError('LINK_BAD_RECORD', message, 400);
}
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    bad('expected object');
  }
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    bad('expected nonempty string');
  }
  return value;
}
export function integer(value: unknown, min = 0): number {
  if (
    typeof value !== 'number' || !Number.isSafeInteger(value) || value < min
  ) {
    bad('expected safe integer');
  }
  return value;
}
function digest(value: unknown): string {
  try {
    return createHash('sha256').update(canonicalJson(value)).digest('hex');
  } catch (error) {
    if (error instanceof LinkError) throw error;
    bad('record is not canonical JSON');
  }
}
export function recordHash(record: Omit<LinkRecord, 'hash'>): string {
  return digest(record);
}
export function streamOf(raw: unknown): Stream {
  const value = object(raw);
  return {
    source: text(value.source),
    incarnation: text(value.incarnation),
    stream: text(value.stream),
  };
}
export function cutOf(raw: unknown): Cut {
  const value = object(raw);
  const sequence = integer(value.sequence);
  const hash = value.hash;
  if (
    typeof hash !== 'string' ||
    (sequence === 0 ? hash !== '' : !/^[a-f0-9]{64}$/.test(hash))
  ) {
    bad('invalid cut digest');
  }
  return { sequence, hash };
}
export function recordOf(raw: unknown): LinkRecord {
  const value = object(raw);
  const hash = text(value.hash);
  const previous = value.previous;
  if (
    typeof previous !== 'string' ||
    (previous !== '' && !/^[a-f0-9]{64}$/.test(previous))
  ) {
    bad('invalid predecessor digest');
  }
  if (!Object.hasOwn(value, 'payload')) bad('missing payload');
  const record = {
    ...streamOf(raw),
    sequence: integer(value.sequence, 1),
    type: text(value.type),
    version: integer(value.version, 1),
    operationId: text(value.operationId),
    previous,
    payload: value.payload,
  };
  if (recordHash(record) !== hash) {
    throw new LinkError('LINK_DIVERGED', 'record digest mismatch');
  }
  return { ...record, hash };
}
export function negotiate(
  raw: unknown,
  server: string,
  supported: readonly Capability[],
): Negotiation {
  const value = object(raw);
  const protocol = object(value.protocol);
  const major = integer(protocol.major, 1);
  const minor = integer(protocol.minor);
  if (major !== LINK_VERSION.major) {
    throw new LinkError('LINK_VERSION_MISMATCH', 'unsupported link major');
  }
  if (text(value.server) !== server) {
    throw new LinkError('LINK_IDENTITY_MISMATCH', 'wrong logical server', 403);
  }
  if (!Array.isArray(value.required)) {
    bad('required capabilities must be an array');
  }
  const required = value.required.map((raw) => {
    const item = object(raw);
    return { type: text(item.type), version: integer(item.version, 1) };
  });
  for (const item of required) {
    if (
      !supported.some((candidate) =>
        candidate.type === item.type && candidate.version === item.version
      )
    ) {
      throw new LinkError(
        'LINK_CAPABILITY_MISMATCH',
        'unsupported required record type',
      );
    }
  }
  return {
    protocol: { major, minor: Math.min(minor, LINK_VERSION.minor) },
    server,
    required,
  };
}

export function assertCapability(
  record: LinkRecord,
  supported: readonly Capability[],
): void {
  if (
    !supported.some((item) =>
      item.type === record.type && item.version === record.version
    )
  ) {
    throw new LinkError('LINK_CAPABILITY_MISMATCH', 'unsupported record type');
  }
}
