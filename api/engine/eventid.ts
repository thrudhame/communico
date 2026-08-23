import { canonicalJson } from './canonical.ts';

const KEEP_TOP = new Set([
  'event_id',
  'type',
  'room_id',
  'sender',
  'state_key',
  'content',
  'hashes',
  'signatures',
  'depth',
  'prev_events',
  'auth_events',
  'origin_server_ts',
]);

const PL_KEYS = new Set([
  'ban',
  'events',
  'events_default',
  'kick',
  'redact',
  'state_default',
  'users',
  'users_default',
  'invite',
]);

// Matrix redaction algorithm (room v11/v12 rules), prototype scope.
export function redact(
  event: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(event)) {
    if (KEEP_TOP.has(k)) out[k] = event[k];
  }
  const content = (event.content ?? {}) as Record<string, unknown>;
  const type = String(event.type ?? '');
  if (type === 'm.room.member') {
    out.content = { membership: content.membership };
  } else if (type === 'm.room.create') {
    out.content = content;
  } else if (type === 'm.room.power_levels') {
    const pl: Record<string, unknown> = {};
    for (const k of Object.keys(content)) {
      if (PL_KEYS.has(k)) pl[k] = content[k];
    }
    out.content = pl;
  } else if (type === 'm.room.history_visibility') {
    out.content = { history_visibility: content.history_visibility };
  } else {
    out.content = {};
  }
  return out;
}

// Mode A event ID = '$' + unpadded-base64url( sha256( canonicalJson(
// redactedEvent ) ) ). event_id and signatures are excluded from the
// reference hash; hashes is kept ABSENT for the prototype (we are not
// federating — content hashes out of scope; recorded in RESULTS.md).
export async function eventIdFor(
  pdu: Record<string, unknown>,
): Promise<string> {
  const r = redact(pdu);
  delete r.event_id;
  delete r.signatures;
  delete r.hashes;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(r)),
  );
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return '$' + b64.replaceAll('+', '-').replaceAll('/', '_').replace(
    /=+$/,
    '',
  );
}
