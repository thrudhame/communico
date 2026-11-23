// api/engine/tenant/index.ts — the typed tenant handle: one tenant file,
// holding the tenant's identity (generate-once ed25519 keypair, never
// silently rotated), the native server name derived from the key, and the
// event signer (stage 3b's Signer). One transaction per tx() call, every
// data operation exposed inside it under its module's short name. The
// store must have been opened with the tenant schema provider (R14).
import type { Store } from '#engine/store/index.ts';
import type { Conn } from '#engine/store/db.ts';
import { syncStreamHeads } from '#engine/tenant/streams.ts';
import type { Signer } from '#engine/room/signer.ts';
import type { Pdu } from '#engine/pdu.ts';
import { tenantSchema } from '#engine/tenant/schema.ts';
import * as accountdata from '#engine/tenant/accountdata.ts';
import * as auth from '#engine/tenant/auth.ts';
import type { AuthIntent, IngressAuthority } from '#engine/tenant/ingress.ts';
import {
  recordLogoutBarrier,
  requireSessionAuthority,
} from '#engine/tenant/session-authority.ts';
import * as devices from '#engine/tenant/devices.ts';
import * as e2ee from '#engine/tenant/e2ee.ts';
import * as crossSigning from '#engine/tenant/cross-signing.ts';
import * as keySignatures from '#engine/tenant/key-signatures.ts';
import * as keyBackup from '#engine/tenant/key-backup.ts';
import {
  remoteTargetMaterial,
  signatureSigner,
  signatureView,
} from '#engine/tenant/signature-view.ts';
import type { SigningUpload } from '#engine/e2ee-signing.ts';
import { config } from '#engine/config.ts';
import * as todevice from '#engine/tenant/todevice.ts';
import type { StreamToken } from '#engine/client/tokens.ts';
import {
  pendingTenantProjection,
  recordTenantProjection,
  rememberTenantProjection,
  tenantChangesCommitted,
} from '#engine/tenant/hooks.ts';
import * as filters from '#engine/tenant/filters.ts';
import * as media from '#engine/tenant/media.ts';
import * as pushers from '#engine/tenant/pushers.ts';
import * as pushrules from '#engine/tenant/pushrules.ts';
import * as txns from '#engine/tenant/txns.ts';
import * as completion from '#engine/tenant/completion.ts';
import type { CompletionTarget } from '#engine/room/completion.ts';
import * as delayedEvents from '#engine/tenant/delayed-events.ts';
import * as uia from '#engine/tenant/uia.ts';
import * as slidingSync from '#engine/tenant/sliding-sync.ts';
import * as users from '#engine/tenant/users.ts';
import * as openid from '#engine/tenant/openid.ts';
import * as profiles from '#engine/tenant/profiles.ts';
import * as profileFanout from '#engine/tenant/profile-fanout.ts';
import * as conflicts from '#engine/tenant/conflicts.ts';
import * as erasure from '#engine/tenant/erasure.ts';
import * as publicReplica from '#engine/tenant/public-replica.ts';
import type { ErasureCut } from '#engine/room/state.ts';
import { writeCertificate } from '#engine/tenant/certificate.ts';
import {
  type DomainBinding,
  requireAccountSelection,
  requireDomainControl,
} from '#engine/facade/domain-control.ts';
import {
  b32encode,
  b64decode,
  b64encodeStd,
  exportPrivateKeyPkcs8,
  exportPublicKeyRaw,
  generateSigningKeypair,
  importPrivateKeyFromPkcs8,
  importPublicKeyFromRaw,
  matrixBase64,
  sha256bytes,
} from '#engine/signing-primitives.js';

export { tenantSchema };
export type { AccountDataRow } from '#engine/tenant/accountdata.ts';
export type { DeviceRow } from '#engine/tenant/devices.ts';
export type { MediaMeta, MediaRow } from '#engine/tenant/media.ts';
export type { PusherInput, PusherRow } from '#engine/tenant/pushers.ts';
export type { PushRule, RuleRow } from '#engine/tenant/pushrules.ts';
export type { ProfileRow } from '#engine/tenant/users.ts';
export type { UiaSession } from '#engine/tenant/uia.ts';

// Native server name: the tenant key as lowercase unpadded base32, one
// DNS label (52 chars for ed25519) — as in doltgres:api/engine/tenant.ts.
export function nativeNameFor(pubRaw: Uint8Array): string {
  return b32encode(pubRaw).replace(/=+$/, '').toLowerCase();
}

export async function signingKeyVersionFor(
  pubRaw: Uint8Array,
): Promise<string> {
  // Matrix key versions allow only [a-zA-Z0-9_]. Twelve hex digits retain
  // 48 bits of the key fingerprint without the '-' in base64url.
  const hash = await sha256bytes(pubRaw);
  return Array.from(
    hash.slice(0, 6),
    (byte) => byte.toString(16).padStart(2, '0'),
  )
    .join('');
}

export type Tenant = {
  readonly ingress?: IngressAuthority;
  // The server name the tenant file was opened with.
  readonly serverName: string;
  // The key-derived native name (base32 of the public key).
  readonly nativeName: string;
  // The full key id ('ed25519:…'), used verbatim as the signatures key.
  readonly keyId: string;
  // The public key, standard base64 unpadded.
  readonly publicB64: string;
  // The real event signer (stage 3b) from the tenant key.
  signer(): Signer;
  writeFederationCert(
    certPath: string,
    keyPath: string,
  ): ReturnType<typeof writeCertificate>;
  tx<T>(fn: (tenant: TenantTx) => Promise<T>): Promise<T>;
};

type IdentityRow = {
  server_name: string;
  native_name: string;
  pubkey_b64: string;
  privkey_enc: string;
  key_id: string;
};

function bind(
  conn: Conn,
  serverName: string,
  changed: () => void = () => {},
  projectionChanged: () => void = () => {},
  ingress?: import('./ingress.ts').PreparedIngressAuthority,
) {
  const authorize = async (intent: AuthIntent) => {
    await ingress?.check(conn, intent);
    if (intent.kind === 'session') {
      await requireSessionAuthority(conn, intent.hash, intent.refresh);
    }
  };
  const admittedDelay = async (id: string) => {
    const event = await delayedEvents.get(conn, id);
    if (event) {
      await authorize({
        kind: 'domain',
        localpart: event.localpart,
        feature: 'schedules',
      });
    }
    return event;
  };
  const mutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const before = conn.writes;
    const value = await operation();
    // The owner may have returned an existing result or found nothing to do.
    // Empty work must not compete with reconciliation on projection_revision.
    if (conn.writes !== before) projectionChanged();
    return value;
  };
  return {
    admit: (check: import('#engine/store/commit.ts').CommitCheck) =>
      conn.admit(check),
    ingress: { check: authorize },
    domains: {
      authorize: async (
        view: DomainBinding,
        selected?: { pairing: string; revision: number },
      ) => {
        await requireDomainControl(conn, view);
        if (!selected) return;
        await requireAccountSelection(conn, {
          localpart: view.localpart,
          pairing: selected.pairing,
          grantRevision: selected.revision,
        });
      },
    },
    publicReplica: {
      users: () => publicReplica.publicUsers(conn),
      inventory: () => publicReplica.publicInventory(conn),
      export: (localpart: string, server: string) =>
        publicReplica.exportPublicUser(conn, localpart, server),
      install: (raw: unknown, server: string) =>
        publicReplica.installPublicUser(conn, raw, server),
    },
    streams: { heads: () => syncStreamHeads(conn) },
    conflicts: {
      inspect: (selector: conflicts.ConflictSelector) =>
        conflicts.inspectConflicts(conn, selector),
      export: (selector: conflicts.ConflictSelector, operationId: string) =>
        conflicts.exportConflict(conn, selector, operationId),
    },
    keyBackup: {
      clear: (localpart: string) => keyBackup.clearBackup(conn, localpart),
      operations: (localpart: string) =>
        keyBackup.backupOperations(conn, localpart),
      import: (
        operation: import('#engine/facade/registers.ts').RegisterOperation,
        history?: import('#engine/facade/domain-control.ts').DomainHistoryProof,
      ) => keyBackup.importBackup(conn, operation, config().e2ee, history),
      version: async (
        localpart: string,
        action: keyBackup.Action,
        version?: string,
        input?: unknown,
      ) => {
        if (action === 'get') {
          await authorize({
            kind: 'domain-read',
            localpart,
            feature: 'backups',
          });
        }
        return await keyBackup.backupVersion(
          conn,
          localpart,
          action,
          version,
          input,
          config().e2ee,
        );
      },
      keys: async (
        localpart: string,
        action: keyBackup.Action,
        version: string | null,
        room?: string,
        session?: string,
        input?: unknown,
      ) => {
        if (action === 'get') {
          await authorize({
            kind: 'domain-read',
            localpart,
            feature: 'backups',
          });
        }
        return await keyBackup.backupKeys(
          conn,
          localpart,
          action,
          version,
          room,
          session,
          input,
          config().e2ee,
        );
      },
    },
    keySignatures: {
      basis: async (localpart: string) => {
        const state = await crossSigning.signingState(conn, localpart);
        const signer = state.user_signing &&
          await signatureSigner(conn, localpart, state.user_signing.id);
        return signer ? { [signer.key]: signer.basis } : {};
      },
      remoteView: (
        key: e2ee.Json,
        user: string,
        id: string,
        requester: string,
        revision: number,
      ) =>
        signatureView(
          conn,
          key,
          user,
          id,
          requester,
          remoteTargetMaterial(key, revision),
        ),
      upload: (
        localpart: string,
        user: string,
        targets: keySignatures.SignatureTarget[],
      ) =>
        mutation(
          () =>
            keySignatures.uploadSignatures(
              conn,
              localpart,
              user,
              targets,
              config().e2ee,
              config().federation.bulkmaxbytes,
            ),
        ),
    },
    crossSigning: {
      clear: (localpart: string, user: string) =>
        mutation(
          () =>
            crossSigning.clearSigningKeys(
              conn,
              localpart,
              user,
              config().federation.bulkmaxbytes,
            ),
        ),
      state: (localpart: string) => crossSigning.signingState(conn, localpart),
      views: (localpart: string, user: string, requester: string) =>
        crossSigning.signingViews(conn, localpart, user, requester),
      upload: (
        localpart: string,
        user: string,
        input: SigningUpload,
        basis: string,
        authenticated: boolean,
      ) =>
        mutation(
          () =>
            crossSigning.uploadSigningKeys(
              conn,
              localpart,
              user,
              input,
              basis,
              authenticated,
              config().federation.bulkmaxbytes,
            ),
        ),
    },
    slidingSync: {
      begin: (
        d: devices.DeviceIdentity,
        name: string,
        position: string | null,
        now = Date.now(),
      ) =>
        slidingSync.beginPosition(
          conn,
          d,
          name,
          position,
          config().slidingsync,
          now,
        ),
      commit: (
        d: devices.DeviceIdentity,
        lease: slidingSync.PositionLease,
        state: Record<string, unknown>,
        now = Date.now(),
        domain?: string,
      ) =>
        slidingSync.commitPosition(
          conn,
          d,
          lease,
          state,
          config().slidingsync,
          now,
          domain,
        ),
      prune: (now = Date.now()) => slidingSync.prunePositions(conn, now),
    },
    toDevice: {
      send: (
        d: devices.DeviceIdentity,
        server: string,
        type: string,
        txn: string,
        source: string,
        messages: todevice.Message[],
        limits: e2ee.KeyLimits,
        delivery: todevice.DeliveryPolicy,
      ) =>
        mutation(
          () =>
            todevice.sendMessages(
              conn,
              d,
              server,
              type,
              txn,
              source,
              messages,
              limits,
              delivery,
            ),
        ),
      receive: (
        origin: string,
        id: string,
        sender: string,
        type: string,
        server: string,
        messages: todevice.Message[],
        limits: e2ee.KeyLimits,
        policy?: 'legacy',
      ) =>
        mutation(
          () =>
            todevice.receiveMessages(
              conn,
              origin,
              id,
              sender,
              type,
              server,
              messages,
              limits,
              policy,
            ),
        ),
      acknowledge: (d: devices.DeviceIdentity, since: StreamToken | null) =>
        todevice.acknowledge(conn, d, since, projectionChanged),
      acknowledgeSliding: (
        d: devices.DeviceIdentity,
        connection: string,
        since: string | null,
      ) =>
        todevice.acknowledgeSliding(
          conn,
          d,
          connection,
          since,
          projectionChanged,
        ),
      deliverSliding: (
        d: devices.DeviceIdentity,
        connection: string,
        limit: number,
        limits: e2ee.KeyLimits,
        domain?: string,
      ) => todevice.deliverSliding(conn, d, connection, limit, limits, domain),
      deliver: (
        d: devices.DeviceIdentity,
        token: StreamToken,
        limits: e2ee.KeyLimits,
      ) => todevice.deliverMessages(conn, d, token, limits),
      pending: (d: devices.DeviceIdentity) => todevice.pendingMessages(conn, d),
      pendingSliding: (
        d: devices.DeviceIdentity,
        connection: string,
        since: string | null,
        limit: number,
      ) => todevice.pendingSliding(conn, d, connection, since, limit),
      head: () => todevice.inboxHead(conn),
    },
    e2ee: {
      upload: (device: devices.DeviceIdentity, input: e2ee.Upload) =>
        mutation(() => e2ee.uploadKeys(conn, device, input)),
      query: (
        localpart: string,
        ids: string[],
        requester: string,
        owner: string,
        maxKeys: number,
      ) => e2ee.queryKeys(conn, localpart, ids, requester, owner, maxKeys),
      claim: (localpart: string, id: string, algorithm: string) =>
        mutation(() => e2ee.claimKey(conn, localpart, id, algorithm)),
      status: (device: devices.DeviceIdentity) => e2ee.keyStatus(conn, device),
      snapshot: (localpart: string, owner: string, limits: e2ee.KeyLimits) =>
        e2ee.deviceSnapshot(conn, localpart, owner, limits),
    },
    erasure: {
      mark: (localpart: string, cuts: Record<string, ErasureCut>) =>
        mutation(() => erasure.markErased(conn, localpart, cuts)),
      get: (localpart: string, roomId: string) =>
        erasure.erasureRow(conn, localpart, roomId),
    },
    profiles: {
      fanout: {
        list: (localpart?: string) =>
          profileFanout.profileFanouts(conn, localpart),
        discover: (
          work: profileFanout.ProfileFanout,
          rooms: readonly string[],
        ) => profileFanout.discoverProfileRooms(conn, work, rooms),
        rooms: (work: profileFanout.ProfileFanout) =>
          profileFanout.profileRoomResults(conn, work),
        submission: (work: profileFanout.ProfileFanout, room: string) =>
          profileFanout.profileSubmission(conn, work, room),
        prepare: (
          work: profileFanout.ProfileFanout,
          room: string,
          pdu: import('#engine/pdu.ts').Pdu,
        ) => profileFanout.prepareProfileSubmission(conn, work, room, pdu),
        finish: (
          work: profileFanout.ProfileFanout,
          room: string,
          eventId: string | null,
          accepted: boolean | null,
        ) =>
          profileFanout.finishProfileSubmission(
            conn,
            work,
            room,
            eventId,
            accepted,
          ),
      },
      get: (localpart: string) => profiles.profileRow(conn, localpart),
      operations: (localpart: string) =>
        profiles.profileOperations(conn, localpart),
      import: async (
        operation: import('#engine/facade/registers.ts').RegisterOperation,
        history?: import('#engine/facade/domain-control.ts').DomainHistoryProof,
      ) => {
        if (await profiles.importProfile(conn, operation, history)) {
          projectionChanged();
        }
      },
      set: (localpart: string, key: string, value: unknown) =>
        mutation(() => profiles.setProfileRow(conn, localpart, key, value)),
      clear: (localpart: string) =>
        mutation(() => profiles.clearProfileRows(conn, localpart)),
    },
    users: {
      deactivate: (
        localpart: string,
        server: string,
        cuts?: Record<string, ErasureCut>,
      ) =>
        mutation(() => users.deactivateUserRows(conn, server, localpart, cuts)),
      exists: (localpart: string) => users.userExists(conn, localpart),
      insert: (localpart: string, displayName: string) =>
        mutation(() => users.insertUser(conn, localpart, displayName)),
      byLocalpart: (localpart: string) =>
        users.userByLocalpart(conn, localpart),
      setDisplayName: (localpart: string, name: string | null) =>
        mutation(() => users.setUserDisplayName(conn, localpart, name)),
      setAvatarUrl: (localpart: string, url: string | null) =>
        mutation(() => users.setUserAvatarUrl(conn, localpart, url)),
      markDeactivated: (localpart: string) =>
        mutation(() => users.markDeactivated(conn, localpart)),
    },
    credentials: {
      clear: (localpart: string) => users.clearCredential(conn, localpart),
      set: (localpart: string, phc: string) =>
        users.setCredential(conn, localpart, phc),
      hash: (localpart: string) => users.credentialHash(conn, localpart),
    },
    devices: {
      upsert: (
        deviceId: string,
        localpart: string,
        displayName: string | null,
      ) =>
        (async () => {
          await authorize({ kind: 'device', localpart, deviceId });
          await mutation(
            () =>
              devices.upsertDeviceRow(conn, deviceId, localpart, displayName),
          );
        })(),
      byId: (deviceId: string, localpart: string) =>
        devices.deviceById(conn, deviceId, localpart),
      exists: (deviceId: string, localpart: string) =>
        devices.deviceExists(conn, deviceId, localpart),
      ofUser: (localpart: string) => devices.devicesOfUser(conn, localpart),
      metadata: async (localpart: string) => {
        await authorize({ kind: 'account', localpart });
        return await devices.deviceMetadata(conn, localpart);
      },
      rename: async (
        deviceId: string,
        localpart: string,
        displayName?: string,
      ) => {
        await authorize({ kind: 'device', localpart, deviceId });
        return await mutation(
          () => devices.renameDevice(conn, deviceId, localpart, displayName),
        );
      },
      delete: (deviceId: string, localpart: string) =>
        mutation(() => devices.deleteDevice(conn, deviceId, localpart)),
      deleteForUser: (localpart: string) =>
        mutation(() => devices.deleteDevicesOfUser(conn, localpart)),
    },
    tokens: {
      deleteOthers: (localpart: string, keepHash: string | null) =>
        auth.deleteOtherTokens(conn, localpart, keepHash),
      barrier: (localpart: string) => recordLogoutBarrier(conn, localpart),
      insert: (
        hash: string,
        localpart: string,
        deviceId: string | null,
        expiresMs: number | null,
      ) =>
        (async () => {
          await authorize(
            deviceId === null
              ? { kind: 'account', localpart }
              : { kind: 'device', localpart, deviceId },
          );
          await auth.insertAccessToken(
            conn,
            hash,
            localpart,
            deviceId,
            expiresMs,
          );
        })(),
      byHash: (hash: string) => auth.accessTokenByHash(conn, hash),
      ofUser: (localpart: string) => auth.accessTokensOfUser(conn, localpart),
      ofDevice: (deviceId: string, localpart: string) =>
        auth.accessTokensOfDevice(conn, deviceId, localpart),
      delete: (hash: string) => auth.deleteAccessToken(conn, hash),
      deleteForUser: (localpart: string) =>
        auth.deleteAccessTokensOfUser(conn, localpart),
    },
    refresh: {
      insert: (
        hash: string,
        localpart: string,
        deviceId: string | null,
        accessHash: string,
      ) =>
        (async () => {
          await authorize({
            kind: 'session',
            hash: accessHash,
            refresh: false,
          });
          await auth.insertRefreshToken(
            conn,
            hash,
            localpart,
            deviceId,
            accessHash,
          );
        })(),
      byHash: (hash: string) => auth.refreshTokenByHash(conn, hash),
      delete: (hash: string) => auth.deleteRefreshToken(conn, hash),
      deleteForAccessToken: (accessHash: string) =>
        auth.deleteRefreshForAccessToken(conn, accessHash),
      deleteForUser: (localpart: string) =>
        auth.deleteRefreshTokensOfUser(conn, localpart),
      confirm: (hash: string) => auth.confirmRefreshToken(conn, hash),
      confirmAccess: (hash: string) => auth.confirmAccessToken(conn, hash),
      replace: (hash: string, nextHash: string, accessHash: string) =>
        auth.replaceRefreshToken(conn, hash, nextHash, accessHash),
    },
    uia: {
      capture: (request: Parameters<typeof uia.captureUiaState>[1]) =>
        uia.captureUiaState(conn, request, authorize),
      authorize: (
        authorization: uia.UiaAuthorization,
        expected?: { localpart: string; action: uia.UiaAction },
      ) => uia.authorizeUia(conn, authorization, authorize, expected),
      insert: (
        session: string,
        flows: { stages: string[] }[],
        binding?: string | null,
      ) => uia.insertUiaSession(conn, session, flows, binding),
      byId: (session: string) => uia.uiaSessionById(conn, session),
      complete: (session: string, stages: string[]) =>
        uia.completeUiaSessionStages(conn, session, stages),
      drop: (session: string) => uia.deleteUiaSession(conn, session),
    },
    pushers: {
      operations: (localpart: string) =>
        pushers.pusherOperations(conn, localpart),
      choices: (localpart: string) =>
        pushers.pusherChoiceOperations(conn, localpart),
      import: async (
        operation: import('#engine/facade/registers.ts').RegisterOperation,
        history?: import('#engine/facade/domain-control.ts').DomainHistoryProof,
      ) => {
        const canceled = operation.kind === 'pusher-choice'
          ? await pushers.importPusherChoice(conn, operation, history)
          : await pushers.importPusherOperation(conn, operation, history);
        if (canceled) {
          changed();
        }
      },
      isCurrent: async (
        localpart: string,
        appId: string,
        pushkey: string,
        incarnation: string,
      ) => {
        await authorize({ kind: 'domain', localpart, feature: 'pushers' });
        return await pushers.pusherIsCurrent(
          conn,
          localpart,
          appId,
          pushkey,
          incarnation,
        );
      },
      moveToken: (oldHash: string, newHash: string) =>
        pushers.movePusherToken(conn, oldHash, newHash),
      deleteForToken: (accessHash: string) =>
        mutation(() => pushers.deletePushersForToken(conn, accessHash)),
      deleteForUser: (localpart: string) =>
        mutation(() => pushers.deletePushersOfUser(conn, localpart)),
      delete: (localpart: string, appId: string, pushkey: string) =>
        mutation(() =>
          pushers.deletePusherRow(conn, localpart, appId, pushkey)
        ),
      deleteOtherUsers: (localpart: string, appId: string, pushkey: string) =>
        mutation(
          () => pushers.deleteOtherPusherUsers(conn, localpart, appId, pushkey),
        ),
      upsert: (
        localpart: string,
        pusher: pushers.PusherInput & { kind: string },
        accessHash: string,
      ) =>
        mutation(() =>
          pushers.upsertPusherRow(conn, localpart, pusher, accessHash)
        ),
      ofUser: (localpart: string) => pushers.pushersOfUser(conn, localpart),
      incarnations: (localpart: string) =>
        pushers.pusherIncarnations(conn, localpart),
    },
    counters: {
      next: (name: string) => accountdata.nextCounter(conn, name),
      nextStream: () => {
        changed();
        return accountdata.nextStreamSeq(conn);
      },
    },
    accountData: {
      operations: (localpart: string) =>
        accountdata.accountDataOperations(conn, localpart),
      import: async (
        operation: import('#engine/facade/registers.ts').RegisterOperation,
        history?: import('#engine/facade/domain-control.ts').DomainHistoryProof,
      ) => {
        if (await accountdata.importAccountData(conn, operation, history)) {
          changed();
        }
      },
      tag: async (
        localpart: string,
        room: string,
        tag: string,
        value?: unknown,
      ) => {
        const result = await accountdata.putRoomTag(
          conn,
          localpart,
          room,
          tag,
          value,
        );
        if (result.changed) changed();
        if (result.recorded) projectionChanged();
      },
      listSelection: (localpart: string) =>
        accountdata.listSelectionSnapshot(conn, localpart),
      clear: (localpart: string) =>
        accountdata.clearAccountData(conn, localpart),
      roomsSince: (localpart: string, since: number, until: number) =>
        accountdata.roomAccountDataSince(conn, localpart, since, until),
      selectedSince: (
        localpart: string,
        selected: ReadonlyMap<string, number>,
        until: number,
      ) =>
        accountdata.selectedAccountDataSince(conn, localpart, selected, until),
      snapshot: (localpart: string, roomId: string, type: string) =>
        accountdata.accountDataSnapshot(conn, localpart, roomId, type),
      put: (
        localpart: string,
        roomId: string,
        type: string,
        content: string,
        seq: number,
      ) =>
        (async () => {
          if (
            await accountdata.putAccountDataRow(
              conn,
              localpart,
              roomId,
              type,
              content,
              seq,
            )
          ) projectionChanged();
        })(),
      get: (localpart: string, roomId: string, type: string) =>
        accountdata.accountDataRow(conn, localpart, roomId, type),
      ofRoom: (
        localpart: string,
        roomId: string,
        since?: number,
        until?: number,
      ) => accountdata.accountDataOfRoom(conn, localpart, roomId, since, until),
      globalSince: (localpart: string, aSeq: number) =>
        accountdata.globalAccountDataSince(conn, localpart, aSeq),
      maxSeq: (localpart: string) =>
        accountdata.accountDataMaxSeq(conn, localpart),
    },
    openid: {
      issue: (localpart: string, now: number, expires: number) =>
        openid.createOpenIdToken(conn, localpart, now, expires),
      read: (token: string, hash: string, now: number) =>
        openid.readOpenIdUser(conn, token, hash, now),
      operations: (localpart: string) =>
        openid.openIdOperations(conn, localpart),
      import: (
        operation: import('#engine/facade/registers.ts').RegisterOperation,
        history?: import('#engine/facade/domain-control.ts').DomainHistoryProof,
      ) => openid.importOpenId(conn, operation, history),
      insert: (hash: string, localpart: string, expires: number) =>
        openid.insertOpenId(conn, hash, localpart, expires),
      user: (hash: string, now: number) => openid.openIdUser(conn, hash, now),
      clear: (localpart: string) => openid.clearOpenId(conn, localpart),
      expire: (now: number) => openid.expireOpenId(conn, now),
    },
    pushRules: {
      prepare: (localpart: string) =>
        pushrules.preparePushRules(conn, localpart, serverName),
      operations: (localpart: string) =>
        pushrules.pushRuleOperations(conn, localpart),
      import: async (
        operation: import('#engine/facade/registers.ts').RegisterOperation,
        history?: import('#engine/facade/domain-control.ts').DomainHistoryProof,
      ) => {
        if (
          await pushrules.importPushRules(conn, operation, serverName, history)
        ) {
          changed();
        }
      },
      clear: (localpart: string) => pushrules.clearPushRules(conn, localpart),
      rulesetRows: (localpart: string) =>
        pushrules.rulesetRows(conn, localpart),
      putDefault: (localpart: string, kind: string, rule: pushrules.PushRule) =>
        pushrules.putDefaultOverride(conn, localpart, kind, rule),
      kindRows: (localpart: string, kind: string) =>
        pushrules.kindRows(conn, localpart, kind),
      byId: (localpart: string, kind: string, ruleId: string) =>
        pushrules.ruleById(conn, localpart, kind, ruleId),
      put: (
        localpart: string,
        kind: string,
        ruleId: string,
        priority: number,
        actions: string,
        conditions: string | null,
        pattern: string | null,
        seq: number,
      ) =>
        pushrules.putRuleRow(
          conn,
          localpart,
          kind,
          ruleId,
          priority,
          actions,
          conditions,
          pattern,
          seq,
        ),
      delete: (localpart: string, kind: string, ruleId: string) =>
        pushrules.deleteRuleRow(conn, localpart, kind, ruleId),
      setEnabled: (
        localpart: string,
        kind: string,
        ruleId: string,
        enabled: boolean,
      ) => pushrules.setRuleEnabledRow(conn, localpart, kind, ruleId, enabled),
      setActions: (
        localpart: string,
        kind: string,
        ruleId: string,
        actions: string,
      ) => pushrules.setRuleActionsRow(conn, localpart, kind, ruleId, actions),
      setPriority: (
        localpart: string,
        kind: string,
        ruleId: string,
        priority: number,
      ) => pushrules.setRulePriority(conn, localpart, kind, ruleId, priority),
      roomRulesOf: (roomId: string, onlyLocalpart?: string) =>
        pushrules.roomRulesOf(conn, roomId, onlyLocalpart),
      copyRoomRule: (
        localpart: string,
        newRoomId: string,
        row: pushrules.RuleRow,
      ) => pushrules.copyRoomRule(conn, localpart, newRoomId, row),
      stampStream: async (localpart: string, seq: number) => {
        if (await pushrules.recordPushRules(conn, localpart, serverName, seq)) {
          projectionChanged();
        }
        changed();
      },
      streamSeq: (localpart: string) =>
        pushrules.pushStreamSeqRow(conn, localpart),
    },
    filters: {
      clear: (localpart: string) => filters.clearFilters(conn, localpart),
      create: async (localpart: string, filter: unknown) => {
        const id = await filters.createFilter(conn, localpart, filter);
        changed();
        return id;
      },
      read: (localpart: string, filterId: string) =>
        filters.readFilter(conn, localpart, filterId),
      operations: (localpart: string) =>
        filters.filterOperations(conn, localpart),
      import: (
        operation: import('#engine/facade/registers.ts').RegisterOperation,
        history?: import('#engine/facade/domain-control.ts').DomainHistoryProof,
      ) => filters.importFilter(conn, operation, history),
      count: (localpart: string) => filters.countFilters(conn, localpart),
      insert: (localpart: string, filterId: string, filter: string) =>
        filters.insertFilter(conn, localpart, filterId, filter),
      byId: (localpart: string, filterId: string) =>
        filters.filterById(conn, localpart, filterId),
    },
    media: {
      insert: (
        localpart: string,
        mediaId: string,
        state: 'pending' | 'uploaded',
        meta: media.MediaMeta,
      ) => media.insertMedia(conn, localpart, mediaId, state, meta),
      byId: (mediaId: string) => media.mediaById(conn, mediaId),
      markUploaded: (mediaId: string, meta: media.MediaMeta) =>
        media.markMediaUploaded(conn, mediaId, meta),
    },
    delayedEvents: {
      newId: () => delayedEvents.newId(conn),
      requireOwner: (id: string) => delayedEvents.requireOwner(conn, id),
      operations: (localpart: string) =>
        delayedEvents.operations(conn, localpart),
      import: (
        operation: import('#engine/facade/registers.ts').RegisterOperation,
        history?: import('#engine/facade/domain-control.ts').DomainHistoryProof,
      ) => delayedEvents.importOperation(conn, operation, history),
      replicas: async (localpart: string) => {
        await authorize({
          kind: 'domain-read',
          localpart,
          feature: 'schedules',
        });
        return await delayedEvents.replicas(conn, localpart);
      },
      get: admittedDelay,
      list: async (localpart: string) => {
        await authorize({
          kind: 'domain-read',
          localpart,
          feature: 'schedules',
        });
        return await delayedEvents.list(conn, localpart);
      },
      receipt: async (receipt: delayedEvents.DelayReceipt) => {
        await authorize({
          kind: 'domain',
          localpart: receipt.device.localpart,
          feature: 'schedules',
        });
        return await delayedEvents.receipt(conn, receipt);
      },
      add: async (
        event: delayedEvents.DelayedEvent,
        limit: number,
        receipt?: delayedEvents.DelayReceipt,
      ) => {
        await authorize({
          kind: 'domain',
          localpart: event.localpart,
          feature: 'schedules',
        });
        const id = await delayedEvents.add(conn, event, limit, receipt);
        changed();
        return id;
      },
      remove: async (
        id: string,
        standing?: import('#engine/room/events.ts').Standing,
      ) => {
        await admittedDelay(id);
        await delayedEvents.remove(conn, id, standing);
        changed();
      },
      action: async (
        id: string,
        action: 'cancel' | 'restart' | 'send',
        now: number,
      ) => {
        await admittedDelay(id);
        await delayedEvents.action(conn, id, action, now);
        changed();
      },
      next: () => delayedEvents.next(conn),
      retry: async (ids: readonly string[], due: number) => {
        await delayedEvents.retry(conn, ids, due);
        changed();
      },
      due: (now: number) => delayedEvents.due(conn, now),
      claim: async (id: string, now: number) => {
        await admittedDelay(id);
        const event = await delayedEvents.claim(conn, id, now);
        if (event) changed();
        return event;
      },
      submission: async (id: string) => {
        await admittedDelay(id);
        return await delayedEvents.submission(conn, id);
      },
      prepare: async (id: string, pdu: Pdu) => {
        await admittedDelay(id);
        const submission = await delayedEvents.prepare(conn, id, pdu);
        changed();
        return submission;
      },
      finish: async (id: string) => {
        await admittedDelay(id);
        await delayedEvents.finish(conn, id);
        changed();
      },
    },
    completion: {
      pending: (device: devices.DeviceIdentity) =>
        completion.pendingCompletions(conn, device),
      retire: (
        device: devices.DeviceIdentity,
        captured: completion.PendingCompletion,
      ) => completion.retireCompletion(conn, device, captured),
    },
    txns: {
      submission: (
        deviceId: devices.DeviceIdentity,
        endpoint: txns.TransactionEndpoint,
        txnId: string,
      ) => txns.submissionById(conn, deviceId, endpoint, txnId),
      prepare: (
        deviceId: devices.DeviceIdentity,
        endpoint: txns.TransactionEndpoint,
        txnId: string,
        pdu: Pdu,
      ) => txns.prepareSubmission(conn, deviceId, endpoint, txnId, pdu),
      finish: (
        deviceId: devices.DeviceIdentity,
        endpoint: txns.TransactionEndpoint,
        txnId: string,
        eventId: string,
        accepted: boolean,
        target?: CompletionTarget,
      ) =>
        txns.finishSubmission(
          conn,
          deviceId,
          endpoint,
          txnId,
          eventId,
          accepted,
          target,
        ),
      forEvent: (
        deviceId: devices.DeviceIdentity,
        roomId: string,
        eventId: string,
      ) => txns.transactionIdForEvent(conn, deviceId, roomId, eventId),
      lookup: (
        deviceId: devices.DeviceIdentity,
        endpoint: txns.TransactionEndpoint,
        txnId: string,
      ) => txns.transactionById(conn, deviceId, endpoint, txnId),
      record: (
        deviceId: devices.DeviceIdentity,
        endpoint: txns.TransactionEndpoint,
        txnId: string,
        eventId: string,
      ) => txns.insertTransaction(conn, deviceId, endpoint, txnId, eventId),
    },
  };
}

export type TenantTx = ReturnType<typeof bind>;

/** Explicit provisioning uses an already-authorized local signer. It neither
 * generates nor replaces identity, and never accepts a key from a remote row
 * replication API. The facade enrollment owner is the production caller. */
export async function provisionTenant(
  store: Store,
  serverName: string,
  identity: { keyId: string; publicB64: string; privateB64: string },
  options: { ingress?: IngressAuthority } = {},
): Promise<Tenant> {
  if (!/^ed25519:[A-Za-z0-9_]+$/.test(identity.keyId)) {
    throw new Error('invalid provisioned tenant identity key ID');
  }
  const raw = matrixBase64(identity.publicB64, 32);
  const publicKey = await importPublicKeyFromRaw(raw);
  const privateKey = await importPrivateKeyFromPkcs8(
    b64decode(identity.privateB64),
  );
  const proof = crypto.getRandomValues(new Uint8Array(32));
  const signed = await crypto.subtle.sign('Ed25519', privateKey, proof);
  if (!await crypto.subtle.verify('Ed25519', publicKey, signed, proof)) {
    throw new Error('provisioned tenant identity keys do not match');
  }
  const row: IdentityRow = {
    server_name: serverName,
    native_name: nativeNameFor(raw),
    pubkey_b64: b64encodeStd(raw),
    privkey_enc: identity.privateB64,
    key_id: identity.keyId.slice('ed25519:'.length),
  };
  const db = await store.tenant(serverName, { create: true });
  const created = Date.now();
  await db.tx(async (conn) => {
    const existing = await conn.query(
      'SELECT * FROM tenant WHERE server_name=?',
      [serverName],
    );
    if (existing.length) {
      for (const key of Object.keys(row) as (keyof IdentityRow)[]) {
        if (existing[0][key] !== row[key]) {
          throw new Error(
            'existing tenant identity does not match enrolled node',
          );
        }
      }
      return;
    }
    await conn.execute(
      'INSERT INTO tenant(server_name,native_name,pubkey_b64,privkey_enc,key_id,created_ms) VALUES(?,?,?,?,?,?)',
      [
        row.server_name,
        row.native_name,
        row.pubkey_b64,
        row.privkey_enc,
        row.key_id,
        created,
      ],
    );
  });
  return await openTenant(store, serverName, options);
}

export async function openTenant(
  store: Store,
  serverName: string,
  options: { create?: boolean; ingress?: IngressAuthority } = {},
): Promise<Tenant> {
  const db = await store.tenant(serverName, options);
  const { row, privateKey } = await db.tx(async (conn) => {
    const rows = await conn.query(
      'SELECT server_name, native_name, pubkey_b64, privkey_enc, key_id FROM tenant WHERE server_name = ?',
      [serverName],
    );
    if (rows.length > 0) {
      const row = rows[0] as unknown as IdentityRow;
      return {
        row,
        privateKey: await importPrivateKeyFromPkcs8(
          b64decode(String(row.privkey_enc)),
        ),
      };
    }
    if (options.create !== true) {
      throw new Error(
        'tenant identity missing; explicit creation or provisioning required',
      );
    }
    const pair = (await generateSigningKeypair()) as CryptoKeyPair;
    const pubRaw = await exportPublicKeyRaw(pair.publicKey);
    const privDer = await exportPrivateKeyPkcs8(pair.privateKey);
    const row: IdentityRow = {
      server_name: serverName,
      native_name: nativeNameFor(pubRaw),
      pubkey_b64: b64encodeStd(pubRaw),
      privkey_enc: b64encodeStd(privDer),
      // Counterparts cache (server, key id): a new key needs a new id.
      key_id: await signingKeyVersionFor(pubRaw),
    };
    await conn.execute(
      'INSERT INTO tenant (server_name, native_name, pubkey_b64, privkey_enc, key_id, created_ms) VALUES (?, ?, ?, ?, ?, ?)',
      [
        row.server_name,
        row.native_name,
        row.pubkey_b64,
        row.privkey_enc,
        row.key_id,
        Date.now(),
      ],
    );
    return { row, privateKey: pair.privateKey };
  });
  // The public key is verified loadable once at open; the signer closes
  // over both halves.
  await importPublicKeyFromRaw(b64decode(String(row.pubkey_b64)));
  rememberTenantProjection(
    store,
    serverName,
    await pendingTenantProjection(db),
  );
  return {
    ingress: options.ingress,
    serverName,
    nativeName: String(row.native_name),
    keyId: 'ed25519:' + String(row.key_id),
    publicB64: String(row.pubkey_b64),
    writeFederationCert: (certPath, keyPath) =>
      writeCertificate(privateKey, String(row.native_name), certPath, keyPath),
    signer: () => ({
      serverName,
      keyId: 'ed25519:' + String(row.key_id),
      sign: async (canonical: string) => {
        const signature = await crypto.subtle.sign(
          { name: 'Ed25519' },
          privateKey,
          new TextEncoder().encode(canonical),
        );
        return b64encodeStd(new Uint8Array(signature));
      },
    }),
    tx: async (fn) => {
      const ingress = options.ingress &&
        ('prepare' in options.ingress
          ? await options.ingress.prepare()
          : options.ingress);
      const { result, changed, projectionRevision } = await db.tx(
        async (conn) => {
          let changed = false;
          let projectionChanged = false;
          const result = await fn(bind(conn, serverName, () => {
            changed = true;
          }, () => {
            projectionChanged = true;
          }, ingress));
          const projectionRevision = projectionChanged
            ? await recordTenantProjection(conn)
            : 0;
          return { result, changed, projectionRevision };
        },
      );
      await tenantChangesCommitted(
        store,
        serverName,
        projectionRevision,
        changed,
      );
      return result;
    },
  };
}
