// Live observations compose the existing grant, account, device and room owners.
// Device generations never cross the link: retained creation facts name devices.
import { canonicalJson } from '#engine/canonical.ts';
import type { Conn } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { checkLocalpart } from '#engine/tenant/users.ts';
import { registryDevice } from '#engine/tenant/session-authority.ts';
import { publicDeviceMetadata } from '#engine/tenant/device-operations.ts';
import {
  captureLocalPresence,
  type LivePresenceObservation,
  replacePresenceSource,
} from '#engine/server/ephemeral.ts';
import {
  captureLocalTyping,
  type LiveTypingObservation,
  replaceTypingSource,
} from '#engine/typing.ts';
import {
  type DomainBinding,
  requireAccountExport,
  requireAccountSelection,
  requireDomainControl,
} from './domain-control.ts';
import { DirectoryReplicas } from './directory.ts';
import { captureRemotePresence } from './remote-presence.ts';
import {
  publishRelayedPresence,
  type RemotePresenceObservation,
} from '#engine/server/ephemeral.ts';
import type { NodeIdentity } from './identity.ts';
import { receivedFence } from './journal.ts';
import type { OwnerControl } from './ownership.ts';
import type { Grant, Pairings } from './pairing.ts';
import { signingFence } from './signing-authority.ts';
import {
  integer,
  LinkError,
  type LiveActivity,
  object,
  text,
} from './protocol.ts';

type Binding = Omit<DomainBinding, 'localpart'>;
type Device = { userId: string; deviceId: string; deviceIncarnation: string };
type Presence =
  & Device
  & Omit<LivePresenceObservation, 'deviceId' | 'generation'>;
type Typing = Device & Omit<LiveTypingObservation, 'deviceId' | 'generation'>;
type Snapshot = Binding & {
  presence: Presence[];
  typing: Typing[];
  remotePresence?: RemotePresenceObservation[];
};

function mismatch(message: string): never {
  throw new LinkError('LINK_IDENTITY_MISMATCH', message, 403);
}
function unavailable(message: string): never {
  throw new LinkError('LINK_UNAVAILABLE', message, 503);
}
function snapshotOf(raw: unknown): Snapshot {
  const row = object(raw);
  if (!Array.isArray(row.presence) || !Array.isArray(row.typing)) {
    throw new LinkError('LINK_BAD_RECORD', 'invalid live activity arrays', 400);
  }
  const device = (raw: unknown) => {
    const value = object(raw);
    return {
      userId: text(value.userId),
      deviceId: text(value.deviceId),
      deviceIncarnation: text(value.deviceIncarnation),
    };
  };
  let remotePresence: RemotePresenceObservation[] | undefined;
  if (row.remotePresence !== undefined) {
    if (!Array.isArray(row.remotePresence)) {
      throw new LinkError('LINK_BAD_RECORD', 'invalid remote presence', 400);
    }
    remotePresence = row.remotePresence.map((raw) => {
      const value = object(raw), presence = text(value.presence);
      if (
        !['online', 'unavailable', 'offline'].includes(presence) ||
        (value.status !== null && typeof value.status !== 'string') ||
        typeof value.currentlyActive !== 'boolean'
      ) throw new LinkError('LINK_BAD_RECORD', 'invalid remote presence', 400);
      return {
        origin: text(value.origin),
        userId: text(value.userId),
        presence,
        status: value.status,
        receivedMs: integer(value.receivedMs),
        lastActiveAgo: integer(value.lastActiveAgo),
        currentlyActive: value.currentlyActive,
      };
    });
    if (
      new Set(remotePresence.map((v) => v.userId)).size !==
        remotePresence.length
    ) {
      throw new LinkError('LINK_BAD_RECORD', 'duplicate remote presence', 400);
    }
  }
  const view: Snapshot = {
    ...(remotePresence === undefined ? {} : { remotePresence }),
    server: text(row.server),
    pairing: text(row.pairing),
    grantRevision: integer(row.grantRevision, 1),
    ownerRevision: integer(row.ownerRevision, 1),
    source: text(row.source),
    incarnation: text(row.incarnation),
    presence: row.presence.map((raw) => {
      const value = object(raw), presence = text(value.presence);
      if (!['online', 'unavailable'].includes(presence)) {
        throw new LinkError('LINK_BAD_RECORD', 'invalid live presence', 400);
      }
      return {
        ...device(value),
        presence,
        remainingMs: integer(value.remainingMs),
        lastActiveAgo: integer(value.lastActiveAgo),
      };
    }),
    typing: row.typing.map((raw) => {
      const value = object(raw);
      return {
        ...device(value),
        roomId: text(value.roomId),
        membership: text(value.membership),
        remainingMs: integer(value.remainingMs),
      };
    }),
  };
  if (canonicalJson(view) !== canonicalJson(raw)) {
    throw new LinkError('LINK_BAD_RECORD', 'invalid live activity shape', 400);
  }
  for (const values of [view.presence, view.typing]) {
    const keys = values.map((v) =>
      canonicalJson([
        'roomId' in v ? v.roomId : '',
        v.userId,
        v.deviceId,
      ])
    );
    if (new Set(keys).size !== keys.length) {
      throw new LinkError('LINK_BAD_RECORD', 'duplicate live observation', 400);
    }
  }
  return view;
}

export class ActivityExchange implements LiveActivity {
  constructor(
    private readonly store: Store,
    private readonly tenant: Tenant,
    private readonly pairings: Pairings,
    private readonly node?: Pick<NodeIdentity, 'node' | 'incarnation'>,
  ) {}

  private localpart(userId: string) {
    const suffix = ':' + this.tenant.serverName;
    if (!userId.startsWith('@') || !userId.endsWith(suffix)) {
      mismatch('live activity is not a local account');
    }
    const localpart = userId.slice(1, -suffix.length);
    if (checkLocalpart(localpart) !== localpart) {
      mismatch('invalid live account');
    }
    return localpart;
  }

  private async authority(pairing: string, local: boolean) {
    let grant: Grant;
    if (this.node) grant = await this.pairings.active();
    else {
      const peer = await this.pairings.connection(pairing);
      if (peer.state !== 'paired' || !peer.grant) {
        mismatch('live link is not paired');
      }
      grant = peer.grant;
    }
    const context = grant.body.transcript.body.context;
    if (
      context.id !== pairing || context.server !== this.tenant.serverName ||
      (this.node && (context.node !== this.node.node ||
        grant.body.transcript.body.incarnation !== this.node.incarnation))
    ) mismatch('wrong live activity pairing');
    const server = await this.store.server();
    const current = signingFence(server), received = receivedFence(server);
    const [row] = await server.query(
      'SELECT c.signed_json FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision WHERE a.pairing=?',
      [pairing],
    );
    if (!row) unavailable('live activity awaits ownership control');
    const control: OwnerControl = JSON.parse(String(row.signed_json)).body;
    const source = control.nodes.find((n) =>
      n.node ===
        (local ? this.node?.node ?? 'home' : this.node ? 'home' : context.node)
    );
    if (!source) mismatch('live source absent from ownership control');
    const binding: Binding = {
      server: context.server,
      pairing,
      grantRevision: grant.body.revision,
      ownerRevision: control.revision,
      source: source.node,
      incarnation: source.incarnation,
    };
    const streams = (await server.query(
      "SELECT source,incarnation,stream,received,applied,received_hash,applied_hash FROM facade_streams WHERE direction='in' AND peer=?",
      [this.node ? 'home' : context.node],
    )).filter((r) =>
      r.stream === 'owner-control' ||
      /^(auth:|authority:|device|key-)/.test(String(r.stream))
    );
    const check = async (tx: Conn, users: Iterable<string>) => {
      current();
      const selected = new Set(users);
      for (
        const r of streams.filter((r) =>
          r.stream === 'owner-control' ||
          [...selected].some((user) => String(r.stream).endsWith(':' + user))
        )
      ) {
        if (
          r.received !== r.applied || r.received_hash !== r.applied_hash ||
          !received(this.node ? 'home' : context.node, {
            source: String(r.source),
            incarnation: String(r.incarnation),
            stream: String(r.stream),
          })
        ) unavailable('live activity awaits applied authority');
      }
      const [held] = await tx.query(
        'SELECT state,grant_json FROM facade_pairings WHERE id=? AND side=?',
        [pairing, this.node ? 'facade' : 'home'],
      );
      if (
        held?.state !== 'paired' || held.grant_json !== canonicalJson(grant)
      ) {
        mismatch('live activity grant changed');
      }
      await requireDomainControl(tx, { ...binding, localpart: '' });
      if (!this.node) {
        for (const userId of selected) {
          await requireAccountExport(tx, {
            peer: context.node,
            pairing,
            server: context.server,
            localpart: this.localpart(userId),
          });
        }
      }
      current();
    };
    await server.tx((tx) => check(tx, []));
    return { server, binding, check, peer: context.node };
  }

  private async devices<T extends { userId: string; deviceId: string }>(
    binding: Binding,
    values: readonly T[],
    capture: boolean,
  ) {
    return await (await this.store.tenant(binding.server)).tx(async (tx) => {
      await requireDomainControl(tx, { ...binding, localpart: '' });
      const result: (T & { deviceIncarnation: string; generation: number })[] =
        [];
      for (const value of values) {
        const localpart = this.localpart(value.userId);
        if (this.node) {
          await requireAccountSelection(tx, { ...binding, localpart });
        }
        const metadata = await publicDeviceMetadata(tx, localpart);
        const creation = await registryDevice(tx, localpart, value.deviceId);
        if (!creation) {
          if (capture) continue;
          unavailable('live activity awaits device creation');
        }
        if (
          creation.node !== binding.source ||
          creation.incarnation !== binding.incarnation ||
          !metadata?.some((d) => d.device_id === value.deviceId)
        ) {
          if (capture) continue; // Deleted or superseded local activity is not exported.
          mismatch('live activity device creation unavailable');
        }
        if (capture) {
          const [mapping] = await tx.query(
            'SELECT incarnation,generation FROM authority_devices WHERE localpart=? AND device_id=?',
            [localpart, value.deviceId],
          );
          if (
            !mapping || mapping.incarnation !== creation.id ||
            mapping.generation !==
              (value as T & { generation: number }).generation
          ) continue;
        } else if ((value as T & Device).deviceIncarnation !== creation.id) {
          mismatch('live activity device incarnation differs');
        }
        result.push({
          ...value,
          deviceIncarnation: creation.id,
          generation: capture
            ? (value as T & { generation: number }).generation
            : creation.seq,
        });
      }
      return result;
    });
  }

  async capture(pairing: string, relay = true): Promise<Snapshot> {
    const authority = await this.authority(pairing, true);
    const selected = new Set(
      this.node
        ? (await (await this.store.tenant(authority.binding.server)).query(
          'SELECT localpart FROM account_auth_snapshots',
        )).map((row) =>
          '@' + String(row.localpart) + ':' + authority.binding.server
        )
        : (await authority.server.query(
          'SELECT scope FROM facade_exports WHERE peer=? AND incarnation=?',
          [authority.peer, pairing],
        )).filter((row) => String(row.scope).startsWith('auth:')).map((row) =>
          String(row.scope).slice(5)
        ),
    );
    const presence = (await captureLocalPresence(authority.server)).filter((
      v,
    ) => selected.has(v.userId));
    const typing = (await captureLocalTyping(
      authority.server,
      await this.store.rooms(),
    )).filter((v) => selected.has(v.userId));
    const devices = await this.devices(authority.binding, [
      ...presence,
      ...typing,
    ], true);
    const admitted = new Set(
      devices.map((v) => canonicalJson([v.userId, v.deviceId, v.generation])),
    );
    const wire = <
      T extends { userId: string; deviceId: string; generation: number },
    >(values: T[]) =>
      values.filter((v) =>
        admitted.has(canonicalJson([v.userId, v.deviceId, v.generation]))
      )
        .map((v) => {
          const { generation: _generation, ...value } = v;
          return {
            ...value,
            deviceIncarnation: devices.find((d) =>
              d.userId === v.userId && d.deviceId === v.deviceId &&
              d.generation === v.generation
            )!.deviceIncarnation,
          };
        });
    const rooms = this.node
      ? await Promise.all(
        typing.map((v) =>
          new DirectoryReplicas(
            authority.server,
            this.pairings,
            authority.binding.server,
          )
            .prepareRoomScope(v.roomId, false, v.userId)
        ),
      )
      : [];
    await authority.server.tx(async (tx) => {
      await authority.check(tx, devices.map((v) => v.userId));
      for (const room of rooms) await room.check(tx);
    });
    return {
      ...authority.binding,
      presence: wire(presence),
      typing: wire(typing),
      ...(this.node && relay
        ? { remotePresence: captureRemotePresence(authority.server) }
        : {}),
    };
  }

  async apply(
    pairing: string,
    raw: unknown,
    elapsed: () => number,
  ): Promise<void> {
    const snapshot = snapshotOf(raw),
      authority = await this.authority(pairing, false);
    if (this.node && snapshot.remotePresence !== undefined) {
      mismatch('remote presence is only relayed to home');
    }
    for (const key of Object.keys(authority.binding) as (keyof Binding)[]) {
      if (snapshot[key] !== authority.binding[key]) {
        mismatch('live activity source differs');
      }
    }
    const presence = await this.devices(
      authority.binding,
      snapshot.presence,
      false,
    );
    const typing = await this.devices(
      authority.binding,
      snapshot.typing,
      false,
    );
    const rooms = this.node
      ? await Promise.all(
        typing.map((v) =>
          new DirectoryReplicas(
            authority.server,
            this.pairings,
            authority.binding.server,
          )
            .prepareRoomScope(v.roomId, false, v.userId)
        ),
      )
      : [];
    const check = async (tx: Conn) => {
      await authority.check(tx, [...presence, ...typing].map((v) => v.userId));
      for (const room of rooms) await room.check(tx);
    };
    await replacePresenceSource(
      authority.server,
      {
        node: snapshot.source,
        incarnation: snapshot.incarnation,
      },
      presence,
      elapsed,
      check,
    );
    await replaceTypingSource(
      authority.server,
      snapshot.source,
      typing,
      elapsed,
      check,
    );
    for (const value of snapshot.remotePresence ?? []) {
      await publishRelayedPresence(
        authority.server,
        authority.binding.server,
        value,
        (tx) => authority.check(tx, []),
      );
    }
  }
}
