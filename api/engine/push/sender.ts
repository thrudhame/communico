// App-owned, at-least-once gateway delivery. At most eight stable identities
// are active; each pass scans at most32 targets and one job per identity.
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { tenantProjectionPending } from '#engine/tenant/hooks.ts';
import { localpartOf } from '#engine/ids.ts';
import { config } from '#engine/config.ts';
import { openRoom } from '#engine/room/index.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { cancelPushTarget } from '#engine/server/push-queue.ts';
import { visiblePrejoin } from '#engine/server/prejoin.ts';
import {
  cancelPushEvent,
  finishPushWork,
  preparePushWork,
  type PushTarget,
  rejectPushTarget,
  retryPushWork,
} from '#engine/server/push-work.ts';
import {
  renderEvent,
  renderInviteNotification,
} from '#engine/client/render.ts';
import type { Pdu } from '#engine/pdu.ts';
import { gatewayPayload } from './payload.ts';
import { gatewayPolicy, sendGateway } from './transport.ts';

type Json = Record<string, unknown>;
export type PushSender = { tick(): Promise<void>; stop(): Promise<void> };
type Deps = {
  store: Store;
  tenant: Tenant;
  automatic?: boolean;
  now?: () => number;
  random?: () => number;
  giveUpMs?: number;
  send?: (
    url: string,
    payload: unknown,
    signal: AbortSignal,
  ) => Promise<string[]>;
  // Crash boundary seam: deliberately outside the transport retry catch.
  afterSend?: () => void | Promise<void>;
};

async function rendered(
  store: Store,
  tenant: Tenant,
  target: PushTarget,
  roomId: string,
  eventId: string,
): Promise<{ event: Json; names: Record<string, string> } | null> {
  const viewer = { userId: target.user, deviceId: null, tenant };
  const server = await store.server();
  // Lookup never creates a room, including for OOB or removed-room jobs.
  let room: Awaited<ReturnType<typeof openRoom>> | null = null;
  try {
    room = await openRoom(store, roomId);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const invite = (await server.query(
    `SELECT event_json,invite_room_state FROM prejoin_memberships p WHERE room_id=? AND user_id=? AND event_id=? AND status='pending' AND kind='invite' AND ${
      visiblePrejoin('p')
    }`,
    [roomId, target.user, eventId],
  ))[0];
  if (invite) {
    const event = await renderInviteNotification(
      JSON.parse(String(invite.event_json)) as Pdu,
      eventId,
      viewer,
      JSON.parse(String(invite.invite_room_state)),
      room,
    );
    return event ? { event: { ...event, room_id: roomId }, names: {} } : null;
  }
  if (room === null) return null;
  const event = await renderEvent(room, eventId, viewer, {
    bundleThreads: false,
  });
  if (event === null) return null;
  const names: Record<string, string> = {};
  await room.tx(async (tx) => {
    const state = await tx.state.eventStateAfter(eventId);
    if (state === null) return;
    for (
      const [key, type, stateKey, field] of [
        [
          'sender_display_name',
          'm.room.member',
          String(event.sender),
          'displayname',
        ],
        ['room_name', 'm.room.name', '', 'name'],
        ['room_alias', 'm.room.canonical_alias', '', 'alias'],
      ]
    ) {
      const id = await tx.state.groupKey(state.group, type, stateKey);
      const row = id === null ? null : await tx.events.get(id);
      const value = row
        ? (JSON.parse(row.pdu) as Pdu).content?.[field]
        : undefined;
      if (typeof value === 'string') names[key] = value;
    }
  });
  return { event, names };
}

/** Push is independent of federation enablement. Durable polling also recovers
 * a missed post-commit wakeup; shutdown aborts sockets and drains before close. */
export async function startPushSender(deps: Deps): Promise<PushSender> {
  const { store, tenant } = deps;
  const server = await store.server();
  const now = deps.now ?? Date.now, random = deps.random ?? Math.random;
  const giveUpMs = deps.giveUpMs ?? config().push.deliverygiveuphours * 3600000;
  const policy = deps.send ? null : gatewayPolicy();
  const send = deps.send ??
    ((url, payload, signal) => sendGateway(url, payload, signal, policy!));
  const abort = new AbortController();
  const active = new Map<string, Promise<void>>();
  let scanning: Promise<void> | null = null;
  let cursor = '';

  async function deliver(target: PushTarget): Promise<void> {
    let work = await server.tx((tx) =>
      preparePushWork(tx, target, now(), giveUpMs)
    );
    if (!work.event && !work.badge) return;
    const shown = work.event
      ? await rendered(store, tenant, target, work.event.room, work.event.id)
      : null;
    if (work.event && !shown) {
      const seq = work.event.seq;
      await server.tx((tx) => cancelPushEvent(tx, target, seq));
    }
    // Last tenant admission happens after rendering, immediately before the
    // final server cut and request scheduling. Never copy token secrets here.
    if (
      !await tenant.tx((tx) =>
        tx.pushers.isCurrent(
          localpartOf(target.user),
          target.app_id,
          target.pushkey,
          target.incarnation,
        )
      )
    ) {
      await server.tx((tx) => cancelPushTarget(tx, target.incarnation));
      return;
    }
    const latest = await server.tx((tx) =>
      preparePushWork(tx, target, now(), giveUpMs)
    );
    // Only the event we rendered is admitted; a suppressed event can expose the
    // next pending event, which needs its own viewer-aware rendering next pass.
    if (!shown || latest.event?.seq !== work.event?.seq) latest.event = null;
    work = latest;
    if ((!work.event && !work.badge) || abort.signal.aborted) return;
    const payload = gatewayPayload(
      target,
      work.unread,
      work.event ? shown!.event : null,
      work.event?.actions ?? [],
      work.event ? shown!.names : {},
    );
    let rejected: string[];
    try {
      rejected = await send(
        String(JSON.parse(target.payload).data.url),
        payload,
        abort.signal,
      );
    } catch {
      if (!abort.signal.aborted) {
        const at = now(), jitter = random();
        await server.tx((tx) => retryPushWork(tx, target, work, at, jitter));
      }
      return;
    }
    if (abort.signal.aborted) return;
    await deps.afterSend?.();
    if (rejected.includes(target.pushkey)) {
      await server.tx((tx) => rejectPushTarget(tx, target));
      await projectTenant(store, tenant.serverName);
    } else await server.tx((tx) => finishPushWork(tx, target, work));
  }

  async function scan(): Promise<void> {
    if (abort.signal.aborted || active.size >= 8) return;
    // Rejections are server-owned durable work, independent of tenant commits.
    // This indexed server lookup does not reopen an otherwise idle tenant.
    if (
      tenantProjectionPending(store, tenant.serverName) ||
      (await server.query(
          'SELECT 1 FROM push_rejections WHERE tenant=? LIMIT 1',
          [tenant.serverName],
        )).length > 0
    ) {
      await projectTenant(store, tenant.serverName);
    }
    if (abort.signal.aborted) return;
    const at = now();
    const rows = await server.query(
      `SELECT t.* FROM push_targets t WHERE t.tenant=? AND t.state='active' AND t.incarnation>? AND (
      EXISTS (SELECT 1 FROM push_delivery d WHERE d.incarnation=t.incarnation AND d.state='pending' AND (d.next_ms<=? OR d.created_ms<=?)) OR
      EXISTS (SELECT 1 FROM push_badges b WHERE b.incarnation=t.incarnation AND b.revision>MAX(b.sent_revision,b.expired_revision) AND (b.next_ms<=? OR b.created_ms<=?)))
      ORDER BY t.incarnation LIMIT 32`,
      [tenant.serverName, cursor, at, at - giveUpMs, at, at - giveUpMs],
    );
    if (!rows.length) {
      cursor = '';
      return;
    }
    for (const row of rows) {
      if (abort.signal.aborted || active.size >= 8) break;
      cursor = String(row.incarnation);
      const key = JSON.stringify([
        row.tenant,
        row.user,
        row.app_id,
        row.pushkey,
      ]);
      if (active.has(key)) continue;
      const target: PushTarget = {
        tenant: String(row.tenant),
        user: String(row.user),
        app_id: String(row.app_id),
        pushkey: String(row.pushkey),
        incarnation: String(row.incarnation),
        payload: String(row.payload),
      };
      const job = deliver(target).finally(() => active.delete(key));
      active.set(key, job);
      // Automatic runs log only a generic marker, never routing keys/content.
      void job.catch(() => {});
    }
    if (rows.length < 32) cursor = '';
  }

  async function tick(): Promise<void> {
    if (abort.signal.aborted) return;
    if (scanning === null) scanning = scan().finally(() => scanning = null);
    await scanning;
    await Promise.all([...active.values()]);
  }
  const automatic = () => {
    void tick().catch(() => console.error('push worker pass failed'));
  };
  const timer = deps.automatic === false ? null : setInterval(automatic, 1000);
  if (deps.automatic !== false) automatic();
  return {
    tick,
    stop: async () => {
      if (timer !== null) clearInterval(timer);
      abort.abort(new DOMException('push sender stopped', 'AbortError'));
      await Promise.allSettled([scanning]);
      await Promise.allSettled([...active.values()]);
    },
  };
}
