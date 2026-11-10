import { localpartOf } from '#engine/ids.ts';
import { getAccountData } from '#engine/tenant/accountdata.ts';
import type { Room } from '#engine/room/index.ts';
import type { Viewer } from './render.ts';

// Ignore policy is presentation-only. State is still delivered and original PDUs
// remain available to room auth/federation; all ordinary client readers share it.
export async function ignoredSenders(viewer: Viewer): Promise<Set<string>> {
  const value = await getAccountData(
    viewer.tenant,
    localpartOf(viewer.userId),
    '',
    'm.ignored_user_list',
  ) as { ignored_users?: unknown } | null;
  const users = value?.ignored_users;
  return new Set(
    users !== null && typeof users === 'object' && !Array.isArray(users)
      ? Object.keys(users)
      : [],
  );
}

export async function isIgnoredEvent(
  room: Room,
  eventId: string,
  viewer: Viewer,
): Promise<boolean> {
  const row = await room.tx((tx) => tx.events.get(eventId));
  return row !== null && row.state_key === null &&
    (await ignoredSenders(viewer)).has(row.sender);
}
