// Frozen v11-v14 row representation. Do not run today's ownership-aware device
// or token writers against a deliberately unmigrated historical file.
import type { Database } from '#engine/store/db.ts';
import { hashToken } from '#engine/tenant/auth.ts';
import { hashPassword } from '#engine/tenant/users.ts';

export async function seedLegacySession(
  db: Database,
  localpart: string,
  device: string,
  displayName: string,
) {
  const token = crypto.randomUUID();
  const hash = await hashToken(token);
  const phc = hashPassword('pw');
  await db.tx(async (conn) => {
    await conn.execute(
      'INSERT INTO users(localpart,display_name) VALUES(?,?)',
      [localpart, displayName],
    );
    await conn.execute(
      "INSERT INTO credentials(localpart,kind,hash) VALUES(?,'argon2id',?)",
      [localpart, phc],
    );
    await conn.execute(
      'INSERT INTO devices(localpart,device_id,generation,display_name) VALUES(?,?,1,?)',
      [localpart, device, 'Device'],
    );
    await conn.execute(
      "INSERT INTO counters(name,value) VALUES('device_generation',1) ON CONFLICT(name) DO UPDATE SET value=MAX(value,1)",
    );
    await conn.execute(
      'INSERT INTO access_tokens(token,localpart,device_id,generation,expires_ms) VALUES(?,?,?,1,NULL)',
      [hash, localpart, device],
    );
  });
  return token;
}
