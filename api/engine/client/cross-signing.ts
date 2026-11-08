import { theApp } from '#engine/app.ts';
import { config } from '#engine/config.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { domainOf, localpartOf } from '#engine/ids.ts';
import { signingUpload } from '#engine/e2ee-signing.ts';
import { needsSigningAuth } from '#engine/tenant/cross-signing.ts';
import { PASSWORD_FLOWS, requireUia } from '#engine/tenant/uia.ts';
import { object } from '#engine/tenant/e2ee.ts';
import { signatureTargets } from '#engine/tenant/key-signatures.ts';
import { queryKeys } from '#engine/client/e2ee.ts';
import { withRemoteSigningState } from '#engine/server/remote-devices.ts';
import type { Json } from '#engine/tenant/e2ee.ts';

export async function uploadSignatures(user: string, body: unknown) {
  const targets = signatureTargets(body, config().e2ee);
  const app = theApp(), localpart = localpartOf(user);
  const local = targets.filter((target) =>
    domainOf(target.user) === app.tenant.serverName
  );
  const remote = targets.filter((target) =>
    domainOf(target.user) !== app.tenant.serverName
  );
  const result = await app.tenant.tx((tx) =>
    tx.keySignatures.upload(localpart, user, local)
  );
  if (!remote.length) return result;
  const signers = await app.tenant.tx((tx) =>
    tx.keySignatures.basis(localpart)
  );
  const revisions = new Map<string, number>();
  for (const target of remote) {
    if (!revisions.has(target.user)) {
      revisions.set(
        target.user,
        await withRemoteSigningState(
          app.server,
          target.user,
          (state) => Promise.resolve(state.revision),
        ),
      );
    }
  }
  // Existing composition owns four-origin concurrency, validation and the total
  // deadline. No consuming operation and no network under either file's gate.
  const resolved = await queryKeys(user, {
    device_keys: Object.fromEntries(
      [...revisions.keys()].map((id) => [id, []]),
    ),
  });
  for (const target of remote) {
    const answer = await withRemoteSigningState(
      app.server,
      target.user,
      async (state) => {
        const json = (resolved.master_keys as Json)[target.user] as
          | Json
          | undefined;
        const keys = json?.keys as Json | undefined;
        const valid = state.revision === revisions.get(target.user) &&
          keys && Object.hasOwn(keys, 'ed25519:' + target.id);
        return await app.tenant.tx((tx) =>
          tx.keySignatures.upload(localpart, user, [{
            ...target,
            ...(valid
              ? { remote: { json: json!, revision: state.revision, signers } }
              : {}),
          }])
        );
      },
    );
    for (const [subject, failures] of Object.entries(answer.failures as Json)) {
      (result.failures as Json)[subject] = {
        ...((result.failures as Json)[subject] as Json),
        ...(failures as Json),
      };
    }
  }
  return result;
}

export async function uploadSigningKeys(
  user: string,
  body: unknown,
): Promise<void> {
  const tenant = theApp().tenant, localpart = localpartOf(user);
  const input = signingUpload(body, user, config().e2ee);
  const old = await tenant.tx((tx) => tx.crossSigning.state(localpart));
  const authenticated = needsSigningAuth(old, input);
  if (authenticated) {
    await requireUia(tenant, {
      body: object(body, 'body'),
      caller: user,
      flows: PASSWORD_FLOWS,
    });
  }
  await tenant.tx((tx) =>
    tx.crossSigning.upload(
      localpart,
      user,
      input,
      canonicalJson(old),
      authenticated,
    )
  );
}
