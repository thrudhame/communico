// Directory, profile and hierarchy schemas belong to the wire boundary, not
// individual lookup/join/traversal callers. Extensions remain intact.
import { arrayOf, objectOf, stringOf } from '#engine/net/json.ts';
import { protocol, UpstreamError } from '#engine/net/upstream-error.ts';
import type { Profile } from './query.ts';

function roomId(raw: unknown, phase: string): string {
  const value = stringOf(raw, phase);
  if (!/^!\S+$/.test(value)) protocol(phase, 'invalid room ID');
  return value;
}
export function directoryResponse(raw: unknown) {
  const body = objectOf(raw, 'directory');
  return {
    room_id: roomId(body.room_id, 'directory'),
    servers: arrayOf(body.servers, (raw) => {
      const server = stringOf(raw, 'directory');
      if (!server || /\s/.test(server)) {
        protocol('directory', 'invalid server name');
      }
      return server;
    }, 'directory'),
  };
}

export function profileResponse(raw: unknown): Profile {
  const body = { ...objectOf(raw, 'profile') };
  for (const field of ['displayname', 'avatar_url', 'm.tz']) {
    // SS query/profile explicitly permits null for an unset field. Preserve
    // the existing client projection of absent legacy display/avatar fields.
    if (body[field] === null) delete body[field];
    else if (body[field] !== undefined) stringOf(body[field], 'profile');
  }
  return body as Profile;
}

export function roomSummaryResponse(raw: unknown) {
  const summary = objectOf(raw, 'hierarchy');
  roomId(summary.room_id, 'hierarchy');
  if (!Number.isSafeInteger(summary.num_joined_members)) {
    protocol('hierarchy', 'invalid member count');
  }
  for (const field of ['world_readable', 'guest_can_join']) {
    if (typeof summary[field] !== 'boolean') {
      protocol('hierarchy', 'invalid summary flag');
    }
  }
  for (
    const field of [
      'canonical_alias',
      'name',
      'topic',
      'avatar_url',
      'join_rule',
      'room_type',
      'encryption',
      'room_version',
    ]
  ) {
    if (summary[field] !== undefined) stringOf(summary[field], 'hierarchy');
  }
  if (summary.allowed_room_ids !== undefined) {
    arrayOf(
      summary.allowed_room_ids,
      (id) => roomId(id, 'hierarchy'),
      'hierarchy',
    );
  }
  return summary;
}

export function hierarchyResponse(raw: unknown, requestedRoom: string) {
  const body = objectOf(raw, 'hierarchy'),
    room = roomSummaryResponse(body.room);
  if (room.room_id !== requestedRoom) {
    throw new UpstreamError('validation', {
      phase: 'hierarchy',
      reason: 'room identity mismatch',
    });
  }
  arrayOf(room.children_state, (raw) => {
    const event = objectOf(raw, 'hierarchy');
    stringOf(event.type, 'hierarchy');
    stringOf(event.state_key, 'hierarchy');
    stringOf(event.sender, 'hierarchy');
    objectOf(event.content, 'hierarchy');
    if (!Number.isSafeInteger(event.origin_server_ts)) {
      protocol('hierarchy', 'invalid child timestamp');
    }
    // Invalid child-link *content* is ignored by hierarchy traversal per SS;
    // a stripped event still has to be an event, not a fabricated empty link.
    return event;
  }, 'hierarchy');
  arrayOf(body.children, roomSummaryResponse, 'hierarchy');
  const inaccessible = arrayOf(
    body.inaccessible_children,
    (id) => roomId(id, 'hierarchy'),
    'hierarchy',
  );
  return { room, inaccessible };
}
