import type { Conn } from '#engine/store/db.ts';

export async function nextDeviceSeq(tx: Conn): Promise<number> {
  await tx.execute(
    "INSERT INTO counters VALUES('devices',0) ON CONFLICT(name) DO NOTHING",
  );
  await tx.execute("UPDATE counters SET value=value+1 WHERE name='devices'");
  return Number(
    (await tx.query("SELECT value FROM counters WHERE name='devices'"))[0]
      .value,
  );
}

/** Capture the audience at publication time; later membership never rewrites history. */
export async function publishDeviceChange(
  tx: Conn,
  seq: number,
  subject: string,
): Promise<void> {
  for (const scope of ['sync', 'keys']) {
    const audience = new Set((await tx.query(
      'SELECT observer FROM device_tracking WHERE subject=? AND scope=? AND end_seq IS NULL',
      [subject, 'keys'],
    )).map((r) => String(r.observer)));
    audience.add(subject);
    for (const observer of audience) {
      await tx.execute(
        'INSERT INTO device_notices VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',
        [seq, observer, subject, scope, 'change'],
      );
    }
  }
}
