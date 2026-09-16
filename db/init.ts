// Provisions the server DB (plain tables in the default postgres
// database) from db/server/schema.sql, ensures the F0 signing key (kept
// as the tenant-key migration source), provisions the tenant identity DB
// (key migrated-or-generated once, reused forever), and seeds dev users
// through the real /register path (dev-only, labelled — F1 step 18).
import { serverDb, withDb } from '../api/engine/db.ts';
import { runSqlFile } from '../api/engine/room.ts';
import { ensureServerKey } from '../api/engine/signing.ts';
import { ensureTenant, registerUser } from '../api/engine/tenant.ts';
import { serverName } from '../api/engine/config.ts';

await withDb(serverDb(), async (c) => {
  await runSqlFile(c, 'db/server/schema.sql');
});
console.log(`server DB '${serverDb()}' provisioned from db/server/schema.sql`);

await ensureServerKey();
const { dbName, key } = await ensureTenant(serverName());
console.log(
  `tenant DB '${dbName}' ready (native name ${
    key.nativeName.slice(0, 12)
  }…, key ed25519:${key.keyId})`,
);

// Dev seeds (dev-only, labelled): alice + bob + dev through registerUser
// (the real /register path — argon2id credentials, device, token). dev
// keeps its fixed 'devtoken' for the demo/scripts; everyone uses the
// demo password.
for (
  const [localpart, password, token] of [
    ['alice', 'demo-password', null],
    ['bob', 'demo-password', null],
    ['dev', 'demo-password', 'devtoken'],
  ] as const
) {
  try {
    const res = await registerUser(serverName(), {
      localpart,
      password,
      accessToken: token,
      deviceId: `${localpart}-seed`,
    });
    console.log(
      `seeded @${localpart}:${serverName()} via /register path (device ${res.device_id})`,
    );
  } catch (e) {
    if (String(e).includes('M_USER_IN_USE')) {
      console.log(
        `seed @${localpart}:${serverName()} already registered — kept`,
      );
    } else {
      throw e;
    }
  }
}
