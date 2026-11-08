import type { InviteDeps } from './invites.ts';
import { prepareRemoteLeave, sendRemoteLeave } from './invites.ts';
import { admit } from './gate.ts';
import type { IntentProvider, ReviewableIntentProvider } from './sender.ts';
import {
  clearJoinAttempt,
  type JoinAttempt,
  joinAttemptActive,
  joinAttemptCommitted,
  joinLeave,
  pendingJoinAttempts,
  saveJoinLeave,
} from '#engine/server/join-attempts.ts';

export async function performJoinCleanup(
  deps: Pick<InviteDeps, 'server' | 'signer'>,
  attempt: JoinAttempt,
): Promise<void> {
  let signed = await joinLeave(deps.server, attempt);
  if (signed === null) {
    signed = await prepareRemoteLeave(attempt.destination, attempt, deps);
    await saveJoinLeave(deps.server, attempt, signed);
  }
  await sendRemoteLeave(attempt.destination, signed, attempt.roomVersion, deps);
}

// Compose server-owned cleanup intents with the existing destination loop and
// operator review. Pruning never silently discards an outstanding remote leave.
export function joinCleanupProvider(
  deps: InviteDeps,
  invites: ReviewableIntentProvider,
): ReviewableIntentProvider {
  const provider: IntentProvider = async (server, destination) => {
    for (const attempt of await pendingJoinAttempts(server)) {
      if (
        attempt.destination !== destination ||
        joinAttemptActive(deps.store, attempt)
      ) continue;
      return {
        id: 'join-cleanup:' + attempt.eventId,
        run: async () => {
          if (joinAttemptActive(deps.store, attempt)) return;
          if (
            !(await pendingJoinAttempts(server)).some((a) =>
              a.roomId === attempt.roomId && a.userId === attempt.userId &&
              a.eventId === attempt.eventId
            )
          ) return;
          if (!await joinAttemptCommitted(deps.store, attempt)) {
            await admit(server, destination, {
              kind: 'outbound',
              user: attempt.userId,
              what: 'intent:join-cleanup',
            });
            await performJoinCleanup(deps, attempt);
          }
          await clearJoinAttempt(server, attempt);
        },
        failed: async () => {},
      };
    }
    return await invites(server, destination);
  };
  return Object.assign(provider, {
    review: async () => [
      ...(await pendingJoinAttempts(deps.server)).map((a) => ({
        id: 'join-cleanup:' + a.eventId,
        destination: a.destination,
        kind: 'intent' as const,
        eventId: null,
        intent: {
          what: 'join-cleanup',
          user_id: a.userId,
          candidates: [a.destination],
        },
        addedMs: a.addedMs,
        expiresMs: null,
        inflightTxn: null,
      })),
      ...await invites.review(),
    ],
    prune: (destination: string) => invites.prune(destination),
  });
}
