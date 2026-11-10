// The room publication and OOB membership share the event allocator. A later
// room publication wins, even before a post-join marker can clear the OOB row.
// All membership display/count consumers use this one selection contract.
export function visiblePrejoin(alias: string) {
  return `NOT EXISTS (SELECT 1 FROM memberships m WHERE m.room=${alias}.room_id AND m.user=${alias}.user_id AND m.seq>=${alias}.seq)`;
}

export function visibleRoomMembership(alias: string) {
  return `NOT EXISTS (SELECT 1 FROM prejoin_memberships p WHERE p.user_id=${alias}.user AND p.room_id=${alias}.room AND p.status NOT IN ('joined','attempting','failed-attempt') AND p.seq>${alias}.seq)`;
}
