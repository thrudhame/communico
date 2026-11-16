// Shared naming and lifecycle contract for cross-file projection cursors.
// Producers, backup audit and room retirement all use this vocabulary.
export const roomProjectionSources = {
  room: { prefix: 'room:', dropReplay: true },
  'push-context': { prefix: 'push-context:', dropReplay: false },
  'receipt-graph': { prefix: 'receipt-graph:', dropReplay: false },
  'client-room-rules': { prefix: 'client-room-rules:', dropReplay: false },
} as const;

export function roomSource(
  kind: keyof typeof roomProjectionSources,
  room: string,
): string {
  return roomProjectionSources[kind].prefix + room;
}

export const tenantProjectionSources = {
  accounts: 'account_changes',
  e2ee: 'e2ee_changes',
  'public-signing': 'e2ee_changes',
  pushers: 'pusher_changes',
} as const;

export function tenantSource(
  kind: keyof typeof tenantProjectionSources,
  tenant: string,
): string {
  return 'tenant:' + tenant + ':' + kind;
}
