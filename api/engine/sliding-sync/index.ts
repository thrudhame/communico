// A protocol coordinator over existing captured owners; no parallel room truth,
// inbox or notification model. Reads/rendering never hold a write transaction.
import { theApp } from '#engine/app.ts';
import { localpartOf } from '#engine/ids.ts';
import { slidingListSnapshot } from '#engine/server/read.ts';
import {
  type ReceiptRow,
  receiptRows,
  setPresenceValue,
} from '#engine/server/ephemeral.ts';
import {
  notificationSnapshot,
  syncNotificationCounts,
} from '#engine/server/notifications.ts';
import { captureAccountData } from '#engine/tenant/accountdata.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { captureTyping } from '#engine/typing.ts';
import { waitForSync } from '#engine/sync-wait.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { selectLists } from './lists.ts';
import { roomPayloads, type SentRoom } from './rooms.ts';
import { publishSlidingResponse } from './delivery.ts';
import { withSlidingConnection } from './lock.ts';
import {
  accountDataExtension,
  e2eeExtension,
  type E2eeExtensionState,
  extensionRooms,
  receiptCaptureSince,
  receiptsExtension,
  type RoomExtensionCuts,
  type TypingCuts,
  typingExtension,
} from './extensions.ts';
import type { SlidingRequest } from './types.ts';

type Json = Record<string, unknown>;
type ConnectionState = {
  eventCut: number;
  deviceBaseline: number;
  selection: string;
  rooms: Record<string, SentRoom>;
  account?: { global: number; rooms: RoomExtensionCuts };
  receipts?: RoomExtensionCuts;
  typing?: TypingCuts;
  e2ee?: E2eeExtensionState;
};

export async function slidingSync(input: {
  userId: string;
  deviceId: string | null;
  generation?: number;
  request: SlidingRequest;
  signal?: AbortSignal;
}) {
  const app = theApp(), request = input.request, signal = input.signal;
  if (input.deviceId === null) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'sliding sync requires a device',
    );
  }
  const localpart = localpartOf(input.userId);
  const device = await deviceIdentity(
    app.tenant,
    localpart,
    input.deviceId,
    input.generation,
  );
  return await withSlidingConnection(
    app.tenant,
    device,
    request.connId,
    signal,
    async () => {
      const lease = await app.tenant.tx((tx) =>
        tx.slidingSync.begin(device, request.connId, request.pos)
      );
      const previous = lease.state as ConnectionState | null;
      if (request.setPresence !== undefined) {
        await setPresenceValue(app.server, input.userId, request.setPresence);
      }
      const captured = await waitForSync(app, {
        timeoutMs: request.timeoutMs,
        signal,
      }, async () => {
        signal?.throwIfAborted();
        const server = await app.server.tx(async (tx) => ({
          ...await slidingListSnapshot(tx, input.userId),
          notifications: await notificationSnapshot(tx, input.userId, 0),
        }));
        // List filters and account-data bodies share one tenant snapshot. Capture
        // eligible candidates once, then disclose only the extension's windows.
        const accountRequest = request.extensions.account_data;
        const captureRoomData = accountRequest?.enabled && (
          accountRequest.lists.some((name) =>
            name === '*'
              ? Object.keys(request.lists).length > 0
              : name in request.lists
          ) ||
          accountRequest.rooms.some((id) =>
            id === '*'
              ? Object.keys(request.subscriptions).length > 0
              : id in request.subscriptions
          )
        );
        const tenant = await app.tenant.tx(async (tx) => ({
          ...await tx.accountData.listSelection(localpart),
          account: request.extensions.account_data?.enabled
            ? await captureAccountData(
              tx,
              localpart,
              app.tenant.serverName,
              previous?.account?.global ?? null,
              new Map(
                (captureRoomData
                  ? [
                    ...new Set([
                      ...server.memberships.filter((m) => !m.forgotten).map((
                        m,
                      ) => m.roomId),
                      ...server.prejoin.map((p) => String(p.room_id)),
                    ]),
                  ]
                  : []).map((id) => [id, previous?.account?.rooms[id] ?? -1]),
              ),
            )
            : null,
          inbox: request.extensions.to_device?.enabled
            ? await tx.toDevice.pendingSliding(
              device,
              lease.connection,
              request.extensions.to_device.since,
              request.extensions.to_device.limit,
            )
            : false,
        }));
        const selection = await selectLists(input.userId, request, {
          snapshot: { ...server, ...tenant, userId: input.userId },
          since: previous?.eventCut,
          previousRooms: new Set(Object.keys(previous?.rooms ?? {})),
        });
        const joined = new Set(
          [...selection.rooms].filter(([, v]) =>
            v.candidate.membership === 'join'
          ).map(([id]) => id),
        );
        const scope = {
          lists: selection.listRooms,
          subscriptions: new Set(
            Object.keys(request.subscriptions).filter((id) =>
              selection.rooms.has(id)
            ),
          ),
        };
        const ephemeralScope = {
          lists: new Map(
            [...scope.lists].map((
              [name, ids],
            ) => [name, new Set([...ids].filter((id) => joined.has(id)))]),
          ),
          subscriptions: new Set(
            [...scope.subscriptions].filter((id) => joined.has(id)),
          ),
        };
        const receiptRooms = extensionRooms(
          request.extensions.receipts,
          ephemeralScope,
        );
        const typingRooms = extensionRooms(
          request.extensions.typing,
          ephemeralScope,
        );
        const typing = captureTyping(typingRooms);
        const receiptCut = server.counters.get('receipts') ?? 0;
        const notifications = new Map(
          [...joined].map((
            id,
          ) => [
            id,
            syncNotificationCounts(server.notifications.rooms.get(id), false)
              .unread_notifications,
          ]),
        );
        const payloads = await roomPayloads(
          {
            userId: input.userId,
            deviceId: input.deviceId,
            tenant: app.tenant,
          },
          selection,
          {
            eventCut: server.eventCut,
            requestSince: previous?.eventCut ?? null,
            direct: tenant.direct,
            previous: previous?.rooms ?? {},
            notifications,
          },
        );
        const receipts = new Map<string, ReceiptRow[]>();
        if (receiptRooms.size) {
          await app.server.tx(async (tx) => {
            for (const id of receiptRooms) {
              // Initial/expanded timelines need older marks. Quiet incremental
              // captures read only rows newer than this room's delivered cut.
              receipts.set(
                id,
                await receiptRows(
                  tx,
                  id,
                  receiptCaptureSince(
                    payloads.rooms[id],
                    previous?.receipts?.[id],
                  ),
                  input.userId,
                  receiptCut,
                ),
              );
            }
          });
        }
        const deviceCut = server.counters.get('devices') ?? 0;
        const state: ConnectionState = {
          ...previous,
          eventCut: server.eventCut,
          deviceBaseline: previous?.deviceBaseline ?? deviceCut,
          selection: JSON.stringify([
            selection.lists,
            request.lists,
            request.subscriptions,
            {
              ...request.extensions,
              to_device: request.extensions.to_device &&
                {
                  enabled: request.extensions.to_device.enabled,
                  limit: request.extensions.to_device.limit,
                },
            },
          ]),
          rooms: payloads.sent,
        };
        const extensions: Json = {};
        let relevant = previous === null || tenant.inbox ||
          state.selection !== previous.selection ||
          Object.keys(payloads.rooms).length > 0;
        if (tenant.account !== null) {
          const account = accountDataExtension(
            tenant.account,
            extensionRooms(request.extensions.account_data, scope),
            previous?.account?.rooms ?? {},
          );
          extensions.account_data = account.response;
          state.account = { global: tenant.account.seq, rooms: account.cuts };
          relevant ||= account.relevant;
        }
        if (request.extensions.receipts?.enabled) {
          const receipt = receiptsExtension(
            input.userId,
            receiptRooms,
            receipts,
            receiptCut,
            previous?.receipts ?? {},
            payloads.rooms,
          );
          extensions.receipts = receipt.response;
          state.receipts = receipt.cuts;
          relevant ||= receipt.relevant;
        }
        if (request.extensions.typing?.enabled) {
          const result = typingExtension(typingRooms, typing, previous?.typing);
          extensions.typing = result.response;
          state.typing = result.cuts;
          relevant ||= result.relevant;
        }
        const e2ee = await e2eeExtension({
          enabled: request.extensions.e2ee?.enabled ?? false,
          server: app.server,
          tenant: app.tenant,
          device,
          since: previous === null
            ? null
            : previous.e2ee?.deviceCut ?? previous.deviceBaseline,
          through: deviceCut,
          previousPoolSeq: previous?.e2ee?.poolSeq,
        });
        if (e2ee !== null) {
          extensions.e2ee = e2ee.response;
          state.e2ee = e2ee.state;
          relevant ||= e2ee.relevant;
        }
        signal?.throwIfAborted();
        return {
          relevant,
          value: {
            state,
            response: {
              lists: selection.lists,
              rooms: payloads.rooms,
              extensions,
            },
          },
        };
      });
      return await publishSlidingResponse({
        tenant: app.tenant,
        device,
        lease,
        ...captured,
        toDevice: request.extensions.to_device,
        signal,
      });
    },
  );
}
