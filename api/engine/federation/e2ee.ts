// Authenticated own-domain adapters share exactly the C-S tenant primitives.
import { theApp } from '#engine/app.ts';
import { config } from '#engine/config.ts';
import {
  claimRequest,
  localClaim,
  localQuery,
  ownUsers,
  queryRequest,
} from '#engine/e2ee.ts';
import { localpartOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { assertFederationEnabled } from './keydoc.ts';
import { bounded } from '#engine/tenant/e2ee.ts';

export async function queryUserKeys(body: unknown) {
  assertFederationEnabled();
  const entries = queryRequest(body, config().e2ee);
  ownUsers(theApp().tenant, entries);
  for (const [user] of entries) {
    await theApp().replica?.requireScope('public:' + user, true);
  }
  return await localQuery(
    theApp().tenant,
    entries,
    '',
    config().e2ee,
  );
}
export async function claimUserKeys(body: unknown) {
  assertFederationEnabled();
  return await localClaim(
    theApp().tenant,
    claimRequest(body, config().e2ee),
    config().e2ee,
  );
}
export async function userDevices(user: string) {
  assertFederationEnabled();
  if (!/^@[^:]+:.+$/.test(user)) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'invalid user ID');
  }
  const tenant = theApp().tenant;
  ownUsers(tenant, [[user, []]]);
  await theApp().replica?.requireScope('public:' + user);
  return await tenant.tx(async (tx) => {
    const lp = localpartOf(user);
    if (!await tx.users.exists(lp)) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'no such user');
    }
    const response = await tx.e2ee.snapshot(lp, user, config().e2ee);
    const signing = await tx.crossSigning.views(lp, user, '');
    for (const usage of ['master', 'self_signing']) {
      if (signing[usage + '_keys'] !== undefined) {
        response[usage + '_key'] = signing[usage + '_keys'];
      }
    }
    bounded(response, config().e2ee.maxrequestbytes);
    return response;
  });
}
