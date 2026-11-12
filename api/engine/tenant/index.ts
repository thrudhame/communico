// api/engine/tenant/index.ts — the typed tenant handle: one tenant file,
// holding the tenant's identity (generate-once ed25519 keypair, never
// silently rotated), the native server name derived from the key, and the
// event signer (stage 3b's Signer). One transaction per tx() call, every
// data operation exposed inside it under its module's short name. The
// store must have been opened with the tenant schema provider (R14).
import type { Store } from '#engine/store/index.ts';
import type { Conn } from '#engine/store/db.ts';
import type { Signer } from '#engine/room/signer.ts';
import type { Pdu } from '#engine/pdu.ts';
import { tenantSchema } from '#engine/tenant/schema.ts';
import * as accountdata from '#engine/tenant/accountdata.ts';
import * as auth from '#engine/tenant/auth.ts';
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
  tenantCommitted,
} from '#engine/tenant/hooks.ts';
import * as filters from '#engine/tenant/filters.ts';
import * as media from '#engine/tenant/media.ts';
import * as pushers from '#engine/tenant/pushers.ts';
import * as pushrules from '#engine/tenant/pushrules.ts';
import * as txns from '#engine/tenant/txns.ts';
import * as uia from '#engine/tenant/uia.ts';
import * as slidingSync from '#engine/tenant/sliding-sync.ts';
import * as users from '#engine/tenant/users.ts';
import * as openid from '#engine/tenant/openid.ts';
import * as profiles from '#engine/tenant/profiles.ts';
import * as erasure from '#engine/tenant/erasure.ts';
import type { ErasureCut } from '#engine/room/state.ts';
import { tenantStreamCommitted } from '#engine/tenant/streams.ts';
import { writeCertificate } from '#engine/tenant/certificate.ts';
import {
  b32encode,
  b64decode,
  b64encodeStd,
  exportPrivateKeyPkcs8,
  exportPublicKeyRaw,
  generateSigningKeypair,
  importPrivateKeyFromPkcs8,
  importPublicKeyFromRaw,
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
  changed: () => void = () => {},
  projectionChanged: () => void = () => {},
) {
  const mutation = async <T>(operation: Promise<T>): Promise<T> => {
    const value = await operation;
    projectionChanged();
    return value;
  };
  return {
    keyBackup: {
      clear: (localpart: string) => keyBackup.clearBackup(conn, localpart),
      version: (
        localpart: string,
        action: keyBackup.Action,
        version?: string,
        input?: unknown,
      ) =>
        keyBackup.backupVersion(
          conn,
          localpart,
          action,
          version,
          input,
          config().e2ee,
        ),
      keys: (
        localpart: string,
        action: keyBackup.Action,
        version: string | null,
        room?: string,
        session?: string,
        input?: unknown,
      ) =>
        keyBackup.backupKeys(
          conn,
          localpart,
          action,
          version,
          room,
          session,
          input,
          config().e2ee,
        ),
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
      ) =>
        slidingSync.commitPosition(
          conn,
          d,
          lease,
          state,
          config().slidingsync,
          now,
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
      ) =>
        mutation(
          todevice.receiveMessages(
            conn,
            origin,
            id,
            sender,
            type,
            server,
            messages,
            limits,
          ),
        ),
      acknowledge: (d: devices.DeviceIdentity, since: StreamToken | null) =>
        todevice.acknowledge(conn, d, since),
      acknowledgeSliding: (
        d: devices.DeviceIdentity,
        connection: string,
        since: string | null,
      ) => todevice.acknowledgeSliding(conn, d, connection, since),
      deliverSliding: (
        d: devices.DeviceIdentity,
        connection: string,
        limit: number,
        limits: e2ee.KeyLimits,
      ) => todevice.deliverSliding(conn, d, connection, limit, limits),
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
        mutation(e2ee.uploadKeys(conn, device, input)),
      query: (
        localpart: string,
        ids: string[],
        requester: string,
        owner: string,
        maxKeys: number,
      ) => e2ee.queryKeys(conn, localpart, ids, requester, owner, maxKeys),
      claim: (localpart: string, id: string, algorithm: string) =>
        mutation(e2ee.claimKey(conn, localpart, id, algorithm)),
      status: (device: devices.DeviceIdentity) => e2ee.keyStatus(conn, device),
      snapshot: (localpart: string, owner: string, limits: e2ee.KeyLimits) =>
        e2ee.deviceSnapshot(conn, localpart, owner, limits),
    },
    erasure: {
      mark: (localpart: string, cuts: Record<string, ErasureCut>) =>
        erasure.markErased(conn, localpart, cuts),
      get: (localpart: string, roomId: string) =>
        erasure.erasureRow(conn, localpart, roomId),
    },
    profiles: {
      get: (localpart: string) => profiles.profileRow(conn, localpart),
      set: (localpart: string, key: string, value: unknown) =>
        profiles.setProfileRow(conn, localpart, key, value),
      clear: (localpart: string) => profiles.clearProfileRows(conn, localpart),
    },
    users: {
      exists: (localpart: string) => users.userExists(conn, localpart),
      insert: (localpart: string, displayName: string) =>
        users.insertUser(conn, localpart, displayName),
      byLocalpart: (localpart: string) =>
        users.userByLocalpart(conn, localpart),
      setDisplayName: (localpart: string, name: string | null) =>
        users.setUserDisplayName(conn, localpart, name),
      setAvatarUrl: (localpart: string, url: string | null) =>
        users.setUserAvatarUrl(conn, localpart, url),
      markDeactivated: (localpart: string) =>
        mutation(users.markDeactivated(conn, localpart)),
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
        mutation(
          devices.upsertDeviceRow(conn, deviceId, localpart, displayName),
        ),
      byId: (deviceId: string, localpart: string) =>
        devices.deviceById(conn, deviceId, localpart),
      ofUser: (localpart: string) => devices.devicesOfUser(conn, localpart),
      rename: (deviceId: string, localpart: string, displayName: string) =>
        mutation(devices.renameDevice(conn, deviceId, localpart, displayName)),
      delete: (deviceId: string, localpart: string) =>
        mutation(devices.deleteDevice(conn, deviceId, localpart)),
      deleteForUser: (localpart: string) =>
        mutation(devices.deleteDevicesOfUser(conn, localpart)),
    },
    tokens: {
      insert: (
        hash: string,
        localpart: string,
        deviceId: string | null,
        expiresMs: number | null,
      ) => auth.insertAccessToken(conn, hash, localpart, deviceId, expiresMs),
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
      ) => auth.insertRefreshToken(conn, hash, localpart, deviceId, accessHash),
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
      insert: (session: string, flows: { stages: string[] }[]) =>
        uia.insertUiaSession(conn, session, flows),
      byId: (session: string) => uia.uiaSessionById(conn, session),
      complete: (session: string, stages: string[]) =>
        uia.completeUiaSessionStages(conn, session, stages),
      drop: (session: string) => uia.deleteUiaSession(conn, session),
    },
    pushers: {
      isCurrent: (
        localpart: string,
        appId: string,
        pushkey: string,
        incarnation: string,
      ) =>
        pushers.pusherIsCurrent(conn, localpart, appId, pushkey, incarnation),
      moveToken: (oldHash: string, newHash: string) =>
        pushers.movePusherToken(conn, oldHash, newHash),
      deleteForToken: (accessHash: string) =>
        mutation(pushers.deletePushersForToken(conn, accessHash)),
      deleteForUser: (localpart: string) =>
        mutation(pushers.deletePushersOfUser(conn, localpart)),
      delete: (localpart: string, appId: string, pushkey: string) =>
        mutation(pushers.deletePusherRow(conn, localpart, appId, pushkey)),
      deleteOtherUsers: (localpart: string, appId: string, pushkey: string) =>
        mutation(
          pushers.deleteOtherPusherUsers(conn, localpart, appId, pushkey),
        ),
      upsert: (
        localpart: string,
        pusher: pushers.PusherInput & { kind: string },
        accessHash: string,
      ) =>
        mutation(pushers.upsertPusherRow(conn, localpart, pusher, accessHash)),
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
      listSelection: (localpart: string) =>
        accountdata.listSelectionSnapshot(conn, localpart),
      clear: (localpart: string) =>
        accountdata.clearAccountData(conn, localpart),
      roomsSince: (localpart: string, since: number, until: number) =>
        accountdata.roomAccountDataSince(conn, localpart, since, until),
      snapshot: (localpart: string, roomId: string, type: string) =>
        accountdata.accountDataSnapshot(conn, localpart, roomId, type),
      put: (
        localpart: string,
        roomId: string,
        type: string,
        content: string,
        seq: number,
      ) =>
        accountdata.putAccountDataRow(
          conn,
          localpart,
          roomId,
          type,
          content,
          seq,
        ),
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
      insert: (hash: string, localpart: string, expires: number) =>
        openid.insertOpenId(conn, hash, localpart, expires),
      user: (hash: string, now: number) => openid.openIdUser(conn, hash, now),
      clear: (localpart: string) => openid.clearOpenId(conn, localpart),
      expire: (now: number) => openid.expireOpenId(conn, now),
    },
    pushRules: {
      clear: (localpart: string) => pushrules.clearPushRules(conn, localpart),
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
      stampStream: (localpart: string, seq: number) =>
        pushrules.stampPushStream(conn, localpart, seq),
      streamSeq: (localpart: string) =>
        pushrules.pushStreamSeqRow(conn, localpart),
    },
    filters: {
      clear: (localpart: string) => filters.clearFilters(conn, localpart),
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
      ) =>
        txns.finishSubmission(
          conn,
          deviceId,
          endpoint,
          txnId,
          eventId,
          accepted,
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

export async function openTenant(
  store: Store,
  serverName: string,
  options: { create?: boolean } = {},
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
      const { result, changed, projectionRevision } = await db.tx(
        async (conn) => {
          let changed = false;
          let projectionChanged = false;
          const result = await fn(bind(conn, () => {
            changed = true;
          }, () => {
            projectionChanged = true;
          }));
          const projectionRevision = projectionChanged
            ? await recordTenantProjection(conn)
            : 0;
          return { result, changed, projectionRevision };
        },
      );
      if (projectionRevision) {
        rememberTenantProjection(store, serverName, projectionRevision);
        await tenantCommitted(store, serverName);
      }
      if (changed || projectionRevision) {
        tenantStreamCommitted(store, serverName);
      }
      return result;
    },
  };
}
